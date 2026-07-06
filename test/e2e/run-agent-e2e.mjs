#!/usr/bin/env node
// Runs the REAL Agent class (src/chrome/src/agent/agent.js) end-to-end
// against a REAL Playwright Chromium page, driven by the REAL local LM
// Studio model — no extension loading, no browser-chrome UI, no mocked
// agent logic. Only chrome.* is mocked (see chrome-mock.mjs); everything
// downstream of `new Agent(providerManager)` is the genuine production code.
//
// WHY THIS EXISTS: Chrome's extension isolation means a separate
// browser-automation agent cannot read/interact with this extension's own
// pages or click its toolbar icon — there is no way to validate the real
// agent loop end-to-end from outside the browser except by running the same
// code in Node with Playwright standing in for the tab. This also lets us
// test arbitrarily complex synthetic pages without a real site account.
//
// Usage:
//   node test/e2e/run-agent-e2e.mjs
//   node test/e2e/run-agent-e2e.mjs --task "custom task text"
//   node test/e2e/run-agent-e2e.mjs --model qwen/qwen3.6-35b-a3b --base http://localhost:1234/v1
//   node test/e2e/run-agent-e2e.mjs --headed          # show the browser window
//   node test/e2e/run-agent-e2e.mjs --max-steps 20
//   node test/e2e/run-agent-e2e.mjs --out /path/to/transcript.json
//
// Output: a full JSON transcript (LLM requests/responses, every tool call +
// result + latency, final outcome) written to test/e2e/results/<timestamp>.json
// and a human-readable log streamed to stdout as the run happens.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { Agent } from '../../src/chrome/src/agent/agent.js';
import { ProviderManager } from '../../src/chrome/src/providers/manager.js';
import { createChromeMock } from './chrome-mock.mjs';
import { injectContentScripts } from './content-inject.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const RESULTS_DIR = path.join(__dirname, 'results');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const BASE_URL = args.base || 'http://localhost:1234/v1';
const MODEL = args.model || 'qwen/qwen3.6-35b-a3b';
const HEADLESS = !args.headed;
const MAX_STEPS = args['max-steps'] ? parseInt(args['max-steps'], 10) : 40;
const MODE = args.mode === 'ask' ? 'ask' : 'act';
const FIXTURE = args.fixture || path.join(__dirname, 'fixtures', 'evil-page.html');
const OUT_PATH = args.out || path.join(RESULTS_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

const DEFAULT_TASK =
  'Dismiss anything blocking the page, then use the category dropdown filter ' +
  'to find all rows whose category is "Alpha". Fill in the shadow-DOM search ' +
  'box with the text "test" and submit it. Then submit the iframe\'s contact ' +
  'form (any placeholder name/email is fine). Finally, use the "Load more" ' +
  'button as needed and report how many Alpha rows exist in total, including ' +
  'any revealed by Load More. If Load More stops adding new rows, stop ' +
  'clicking it and report the count you have.';

const TASK = args.task && args.task !== true ? args.task : DEFAULT_TASK;

function fixtureUrl(p) {
  return 'file://' + p;
}

// ── Transcript recording ────────────────────────────────────────────────
const transcript = {
  startedAt: new Date().toISOString(),
  config: { baseUrl: BASE_URL, model: MODEL, mode: MODE, maxSteps: MAX_STEPS, fixture: FIXTURE, task: TASK },
  chromeMockLog: [],
  onUpdateEvents: [],
  debugLog: null,
  errorLog: null,
  result: null,
  finishedAt: null,
  durationMs: null,
};

function logLine(...parts) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${parts.join(' ')}`;
  console.log(line);
}

function summarizeMockEntry(entry) {
  if (entry.api === 'chrome.tabs.sendMessage') {
    const { action, params } = entry.message || {};
    const ok = entry.result && entry.result.success !== false && !entry.result.error;
    return `sendMessage action=${action} params=${JSON.stringify(params).slice(0, 120)} -> ${ok ? 'ok' : 'FAIL: ' + (entry.result?.error || JSON.stringify(entry.result).slice(0, 120))} (${entry.latencyMs}ms)`;
  }
  if (entry.api === 'chrome.scripting.executeScript') {
    return `executeScript mode=${entry.mode} ${entry.files ? 'files=' + entry.files.length : ''} ${entry.allFrames ? 'allFrames frameCount=' + entry.frameCount : ''}`.trim();
  }
  if (entry.api === 'chrome.debugger.sendCommand') {
    return `CDP ${entry.method}${entry.note ? ' — ' + entry.note : ''}${entry.error ? ' ERROR: ' + entry.error : ''}`;
  }
  return `${entry.api} ${JSON.stringify(entry).slice(0, 150)}`;
}

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });

  logLine('▸ Checking LM Studio endpoint', BASE_URL, 'model', MODEL);
  try {
    const probe = await fetch(BASE_URL.replace(/\/v1\/?$/, '') + '/v1/models');
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    const data = await probe.json();
    const ids = (data.data || []).map(m => m.id);
    if (!ids.includes(MODEL)) {
      logLine('▸ WARNING: model', MODEL, 'not in /v1/models list:', ids.join(', '));
    } else {
      logLine('▸ Model confirmed loaded:', MODEL);
    }
  } catch (e) {
    logLine('▸ FATAL: could not reach LM Studio at', BASE_URL, '-', e.message);
    process.exit(1);
  }

  logLine('▸ Launching Playwright Chromium (headless=' + HEADLESS + ')');
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') logLine('  [page console error]', msg.text().slice(0, 300));
  });
  page.on('pageerror', (err) => {
    logLine('  [page error]', err.message.slice(0, 300));
  });

  logLine('▸ Loading fixture', FIXTURE);
  await page.goto(fixtureUrl(FIXTURE), { waitUntil: 'domcontentloaded' });

  logLine('▸ Injecting real content scripts (accessibility-tree.js, content.js, agent-visual-indicator.js)');
  await injectContentScripts(page);

  const { chrome: chromeMock } = createChromeMock(page, {
    onLog: (entry) => {
      transcript.chromeMockLog.push({ t: Date.now(), ...entry });
      logLine('  [mock]', summarizeMockEntry(entry));
    },
  });
  globalThis.chrome = chromeMock;

  // ── ProviderManager: bypass chrome.storage-backed .load(), construct the
  // lmstudio provider directly with the exact config we need. This avoids
  // depending on the full default-config merge logic in manager.js (which is
  // designed for the real extension's settings UI) while still using the
  // REAL OpenAICompatibleProvider class (not a stub).
  const providerManager = new ProviderManager();
  providerManager.activeProviderId = 'lmstudio';
  const lmstudioConfig = {
    type: 'openai',
    category: 'local',
    label: 'LM Studio (Local)',
    providerName: 'lmstudio',
    baseUrl: BASE_URL,
    model: MODEL,
    contextWindow: 65536,
    apiKey: 'lm-studio',
    supportsVision: true,
    enabled: true,
    // promptTier intentionally omitted — BaseLLMProvider.get promptTier()
    // resolves category:'local' + no explicit tier + no useCompactPrompt to
    // 'full' (see providers/base.js). That was a same-day change verified in
    // this investigation; explicitly NOT overriding it here documents that
    // this harness relies on that default rather than hardcoding a tier.
  };
  providerManager.providers.set('lmstudio', providerManager._createProvider('lmstudio', lmstudioConfig));

  logLine('▸ Provider ready: lmstudio @', BASE_URL, 'model', MODEL, 'promptTier=', providerManager.getActive().promptTier);

  const agent = new Agent(providerManager);
  // Planner gate defaults to 'off' (agent.js constructor: planBeforeActMode
  // = 'off', planBeforeAct = false) — no extra LLM call before the main loop,
  // consistent with the real extension's out-of-the-box behavior.
  agent.maxSteps = MAX_STEPS;
  // Skip the (capability, host) permission gate in this headless harness.
  // The gate normally PROMPTS the user before a consequential action; no
  // user here means every click would hang forever waiting on approval.
  // Set BOTH: the flag directly, AND the storage value it derives from —
  // agent._ensureGateSetting() re-reads chrome.storage.local mid-run and
  // would otherwise reset _skipPermissionGate back to false (undefined
  // !== false), which is exactly what hung the earlier runs. This mirrors
  // the real extension's "don't ask before consequential actions"
  // autopilot toggle; it does NOT touch the loop / paralysis / receipts
  // guardrails under test, which live in the tool-execution path.
  await chromeMock.storage.local.set({ askBeforeConsequentialActions: false });
  agent._skipPermissionGate = true;

  const TAB_ID = 1;

  const stepStart = new Map();
  function onUpdate(type, data) {
    const evt = { t: Date.now(), type, data };
    transcript.onUpdateEvents.push(evt);
    // Safety net: a headless run has no human to answer a clarify()/permission
    // prompt, so ANY such question would deadlock the agent loop forever (the
    // failure mode that hung two earlier runs). Auto-answer immediately:
    // permission prompts get "once" (allow this action), plain clarify()
    // questions get a canned "proceed with your best judgment." This is a
    // TEST convenience only — it does not weaken the guardrails under test.
    if (type === 'clarify' && data?.clarifyId) {
      const answer = data.permission ? 'once' : 'Proceed with your best judgment; no human is available to answer.';
      logLine(`  [auto-answer clarify] ${data.permission ? 'ALLOW(once)' : 'proceed'} — "${(data.question || '').slice(0, 80)}"`);
      // Defer a tick so the awaiting clarify Promise is registered first.
      setTimeout(() => agent.submitClarifyResponse(TAB_ID, data.clarifyId, answer, 'e2e-harness'), 0);
    }
    if (type === 'thinking') {
      logLine(`▸ step ${data.step}${data.note ? ' (' + data.note + ')' : ''}`);
    } else if (type === 'tool_call' || type === 'tool_result') {
      logLine(`  [${type}]`, JSON.stringify(data).slice(0, 300));
    } else if (type === 'error' || type === 'warning') {
      logLine(`  [${type}]`, data.message || JSON.stringify(data));
    } else {
      logLine(`  [onUpdate:${type}]`, JSON.stringify(data).slice(0, 200));
    }
  }

  logLine('▸ Task:', TASK);
  logLine('▸ Starting agent.processMessage(tabId=' + TAB_ID + ', mode=' + MODE + ', maxSteps=' + MAX_STEPS + ')');

  const t0 = Date.now();
  let finalResponse = null;
  let runError = null;
  try {
    finalResponse = await agent.processMessage(TAB_ID, TASK, onUpdate, MODE);
  } catch (e) {
    runError = { message: e.message, stack: e.stack };
    logLine('▸ FATAL agent error:', e.message);
  }
  const durationMs = Date.now() - t0;

  // Pull the agent's own internal debug/error ring buffers — these carry
  // every LLM request/response pair and CDP/runtime errors it captured,
  // independent of our chromeMockLog.
  transcript.debugLog = agent._debugLog || null;
  transcript.errorLog = agent._errorLog || null;
  transcript.result = { finalResponse, error: runError };
  transcript.finishedAt = new Date().toISOString();
  transcript.durationMs = durationMs;

  // Fixture-side ground truth, read directly off the page for scoring.
  let groundTruth = null;
  try {
    groundTruth = await page.evaluate(() => ({
      totalRows: window.__evilPageRowCount ? window.__evilPageRowCount() : null,
      alphaRows: window.__evilPageAlphaCount ? window.__evilPageAlphaCount() : null,
      shadowSearchSubmitted: window.__shadowSearchSubmitted ?? null,
      iframeFormSubmitted: null, // filled below (cross-frame)
    }));
    const frame = page.frames().find(f => f.url().includes('evil-iframe-form.html'));
    if (frame) {
      groundTruth.iframeFormSubmitted = await frame.evaluate(() => window.__iframeFormSubmitted ?? null);
    }
    const overlayHidden = await page.evaluate(() =>
      document.getElementById('overlay-backdrop')?.classList.contains('hidden'));
    groundTruth.overlayDismissed = !!overlayHidden;
  } catch (e) {
    groundTruth = { error: e.message };
  }
  transcript.groundTruth = groundTruth;

  logLine('▸ Done in', durationMs + 'ms');
  logLine('▸ Final response:', String(finalResponse).slice(0, 500));
  logLine('▸ Ground truth from page:', JSON.stringify(groundTruth));

  writeFileSync(OUT_PATH, JSON.stringify(transcript, null, 2));
  logLine('▸ Transcript written to', OUT_PATH);

  await browser.close();
  process.exit(runError ? 1 : 0);
}

main().catch((e) => {
  console.error('Harness crashed:', e);
  process.exit(1);
});
