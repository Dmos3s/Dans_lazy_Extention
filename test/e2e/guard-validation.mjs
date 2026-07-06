#!/usr/bin/env node
// Deterministic, no-LLM, no-GPU validation of:
//   1. Outcome-warnings surfacing at done() (task #15)
//   2. iframe_click + press_keys work with the multi-arg mock fix (task #3)
//   3. Guard A: destructive "anyway" click block
//   4. Guard B: Gmail Labels/Move-to menu-failed gate
//
// Drives the REAL Agent class directly via _executeToolBatch with
// hand-crafted tool_calls — bypassing the LLM entirely, so results are
// deterministic and don't cost GPU time. Setup mirrors run-agent-e2e.mjs
// exactly (chrome-mock + content-inject + ProviderManager + Agent) to avoid
// repeating an earlier mismatch mistake.
import { chromium } from 'playwright';
import { createChromeMock } from './chrome-mock.mjs';
import { injectContentScripts } from './content-inject.mjs';
import { Agent } from '../../src/chrome/src/agent/agent.js';
import { ProviderManager } from '../../src/chrome/src/providers/manager.js';

const TAB_ID = 1;
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`); }
}

async function setup(html) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await injectContentScripts(page);
  const { chrome: chromeMock } = createChromeMock(page, { onLog: () => {} });
  globalThis.chrome = chromeMock;

  // _ensureGateSetting() re-reads chrome.storage.local mid-run and would
  // otherwise silently reset _skipPermissionGate back to false (undefined
  // !== false) — the exact bug that hung two earlier e2e runs. Seed the
  // real storage value it derives from, not just the in-memory flag.
  await chromeMock.storage.local.set({ askBeforeConsequentialActions: false });

  const providerManager = new ProviderManager();
  providerManager.activeProviderId = 'lmstudio';
  providerManager.providers.set('lmstudio', providerManager._createProvider('lmstudio', {
    type: 'openai', category: 'local', providerName: 'lmstudio',
    baseUrl: 'http://localhost:1234/v1', model: 'unused', contextWindow: 65536,
    apiKey: 'x', supportsVision: false, enabled: true,
  }));
  const agent = new Agent(providerManager);
  agent._skipPermissionGate = true;
  const provider = providerManager.getActive();
  return { browser, page, agent, provider };
}

// Finds a ref_id from the accessibility tree. Tries a name match first (if
// hint is non-empty); falls back to the FIRST ref_id anywhere in the tree,
// which is reliable for these single-element test pages regardless of how
// a given role renders its accessible name.
async function ref(agent, provider, hint) {
  const messages = [];
  const call = { id: 'r1', function: { name: 'get_accessibility_tree', arguments: JSON.stringify({ filter: 'all', maxDepth: 10 }) } };
  await agent._executeToolBatch(TAB_ID, [call], messages, () => {}, provider);
  const content = messages[0]?.content || '';
  if (hint) {
    const m = content.match(new RegExp(`"${hint}"\\s*\\[(ref_\\d+)\\]`));
    if (m) return m[1];
  }
  const any = content.match(/\[(ref_\d+)\]/);
  return any ? any[1] : null;
}

async function run(agent, provider, toolCalls, seedMessages) {
  // seedMessages: optional prior conversation history to start from, mutated
  // in place like the real Agent's accumulating `messages` array — needed to
  // test guards that scan history (e.g. _resolveRefLabelFromHistory) without
  // re-running a full multi-turn conversation.
  const messages = seedMessages || [];
  const events = [];
  // Defense in depth: this headless test has no human to answer a clarify()
  // or permission prompt, so ANY such question would hang forever (the
  // exact failure mode diagnosed earlier tonight). Auto-answer immediately
  // even though the storage seed in setup() should prevent permission
  // prompts from firing at all — this covers any other clarify() path.
  const onUpdate = (type, data) => {
    events.push({ type, data });
    if (type === 'clarify' && data?.clarifyId) {
      const answer = data.permission ? 'once' : 'Proceed with best judgment; no human available.';
      setTimeout(() => agent.submitClarifyResponse(TAB_ID, data.clarifyId, answer, 'test-harness'), 0);
    }
  };
  const result = await agent._executeToolBatch(TAB_ID, toolCalls, messages, onUpdate, provider);
  return { result, messages, events };
}

// ── Test 1: iframe_click + press_keys work (multi-arg mock fix) ──────────
async function testIframeAndPressKeys() {
  console.log('\n=== Test 1: iframe_click + press_keys (multi-arg mock fix) ===');
  const html = `
    <button id="top-btn">top</button>
    <iframe srcdoc="<button id='inner-btn' onclick=&quot;window.__clicked=true&quot;>inner</button>"></iframe>
  `;
  const { browser, page, agent, provider } = await setup(html);
  try {
    const { result: r1, messages: m1 } = await run(agent, provider, [
      { id: 'c1', function: { name: 'iframe_click', arguments: JSON.stringify({ selector: '#inner-btn' }) } },
    ]);
    const r1Content = JSON.parse(m1[0]?.content || '{}');
    check('iframe_click reports success (no "Too many arguments" throw)', r1Content.success === true, r1Content);
    // Confirm the click actually registered INSIDE the iframe's own document
    // — reading a flag from the iframe's own frame context, not the parent
    // page (an iframe's own globals/title never propagate to the parent).
    const innerFrame = page.frames().find((f) => f !== page.mainFrame());
    const clickedFlag = innerFrame ? await innerFrame.evaluate(() => window.__clicked === true) : false;
    check('iframe_click actually executed inside the iframe (flag set there)', clickedFlag === true, { clickedFlag });

    // press_keys on a native <select> (exercises _autoSelectOption's
    // multi-arg [arrowKey, delta] call, same mock code path).
  } finally {
    await browser.close();
  }
}

async function testPressKeysNativeSelect() {
  console.log('\n=== Test 1b: press_keys on native <select> ===');
  const html = `<select id="sel"><option>Alpha</option><option>Beta</option><option>Gamma</option></select>`;
  const { browser, page, agent, provider } = await setup(html);
  try {
    const selRef = await ref(agent, provider, 'Alpha');
    check('found the select via accessibility tree', !!selRef, { selRef });
    if (selRef) {
      await run(agent, provider, [{ id: 'c1', function: { name: 'click_ax', arguments: JSON.stringify({ ref_id: selRef }) } }]);
      const { result } = await run(agent, provider, [
        { id: 'c2', function: { name: 'press_keys', arguments: JSON.stringify({ key: 'ArrowDown' }) } },
      ]);
      check('press_keys on native select did not throw / returned a result', !!result, result);
    }
  } finally {
    await browser.close();
  }
}

// ── Test 1c: urlFilter against a real file:// iframe (hostless-scheme bug) ──
// file:, data:, blob:, and about: frame URLs all have an EMPTY hostname, so
// the anti-substring host check in frameHostMatches / iframe_click /
// iframe_type used to reject every urlFilter unconditionally for these
// frames — found live when a real model correctly filled in a urlFilter for
// evil-page.html's file://-loaded contact iframe and got "Input not found in
// any matching iframe" on every attempt (searchedFrames: 0), burning 10+
// steps before hitting the step cap. Reproduces that exact scenario.
async function testIframeUrlFilterHostless() {
  console.log('\n=== Test 1c: iframe_type urlFilter on a hostless (file://) frame ===');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const fixture = path.join(__dirname, 'fixtures', 'evil-page.html');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('file://' + fixture, { waitUntil: 'domcontentloaded' });
  await injectContentScripts(page);
  const { chrome: chromeMock } = createChromeMock(page, { onLog: () => {} });
  globalThis.chrome = chromeMock;
  await chromeMock.storage.local.set({ askBeforeConsequentialActions: false });

  const providerManager = new ProviderManager();
  providerManager.activeProviderId = 'lmstudio';
  providerManager.providers.set('lmstudio', providerManager._createProvider('lmstudio', {
    type: 'openai', category: 'local', providerName: 'lmstudio',
    baseUrl: 'http://localhost:1234/v1', model: 'unused', contextWindow: 65536,
    apiKey: 'x', supportsVision: false, enabled: true,
  }));
  const agent = new Agent(providerManager);
  agent._skipPermissionGate = true;
  const provider = providerManager.getActive();
  try {
    const { result, messages } = await run(agent, provider, [
      { id: 'c1', function: { name: 'iframe_type', arguments: JSON.stringify({ urlFilter: 'evil-iframe-form.html', selector: 'input#iframe-name', text: 'John Doe', clear: true }) } },
    ]);
    const content = JSON.parse(messages[0]?.content || '{}');
    check('iframe_type with a urlFilter succeeds against a file:// iframe', content.success === true, content);
    check('did not report searchedFrames: 0 (the hostless-scheme bug)', content.searchedFrames !== 0, content);
  } finally {
    await browser.close();
  }
}

// ── Test 2: Guard A — destructive "anyway" click block ───────────────────
async function testGuardA() {
  console.log('\n=== Test 2: Guard A — destructive "anyway" click block ===');
  const html = `<button id="danger">Send anyway</button><button id="safe">Save changes</button>`;
  const { browser, page, agent, provider } = await setup(html);
  try {
    const { result, messages } = await run(agent, provider, [
      { id: 'c1', function: { name: 'click', arguments: JSON.stringify({ text: 'Send anyway' }) } },
    ]);
    const content = JSON.parse(messages[0]?.content || '{}');
    check('blocked click on "Send anyway"', content.denied === true, content);
    check('denial message mentions clarify()', /clarify\(\)/.test(content.error || ''), content);

    // Sanity: a SAFE click (no "anyway") must NOT be blocked by this guard.
    // A successful (non-denied) result is wrapped in <untrusted_page_content>
    // markup by _wrapUntrusted — only denials are pushed as raw JSON — so
    // check the raw string rather than assuming every message is bare JSON.
    const { messages: m2 } = await run(agent, provider, [
      { id: 'c2', function: { name: 'click', arguments: JSON.stringify({ text: 'Save changes' }) } },
    ]);
    check('does NOT block an unrelated click ("Save changes")', !(m2[0]?.content || '').includes('"denied":true'), m2[0]?.content);
  } finally {
    await browser.close();
  }
}

// ── Test 2b: Guard A also covers click_ax (ref_id), not just click(text) ──
// Found via a live-model run: a real model resolved "Send anyway" through
// get_accessibility_tree and called click_ax({ref_id}) instead of
// click({text}) — the ONLY path Guard A originally inspected — and sailed
// straight through, actually sending the email. _resolveRefLabelFromHistory
// closes this by recovering the label from tree text already in `messages`.
async function testGuardAClickAxBypass() {
  console.log('\n=== Test 2b: Guard A blocks click_ax resolving to "...anyway" ===');
  const html = `<button id="danger">Send anyway</button>`;
  const { browser, page, agent, provider } = await setup(html);
  try {
    const dangerRef = await ref(agent, provider, 'Send anyway');
    check('found a ref_id for "Send anyway"', !!dangerRef, { dangerRef });
    if (!dangerRef) { await browser.close(); return; }

    // Seed history with a fake prior get_accessibility_tree-shaped tool
    // result, mirroring what a real conversation would already contain by
    // the time the model calls click_ax on this ref.
    const seed = [{ role: 'tool', content: `button "Send anyway" [${dangerRef}]` }];
    const { messages } = await run(agent, provider, [
      { id: 'c1', function: { name: 'click_ax', arguments: JSON.stringify({ ref_id: dangerRef }) } },
    ], seed);
    const content = JSON.parse(messages[messages.length - 1]?.content || '{}');
    check('click_ax resolving to "Send anyway" is blocked', content.denied === true, content);
    check('denial mentions clarify()', /clarify\(\)/.test(content.error || ''), content);
  } finally {
    await browser.close();
  }
}

// ── Test 3: Guard B — Gmail Labels/Move-to menu-failed gate ──────────────
async function testGuardB() {
  console.log('\n=== Test 3: Guard B — Gmail Labels menu-failed gate ===');
  // "Move to" button that does NOTHING when clicked (simulates the menu
  // failing to open) — served as a file:// page but we spoof the URL check
  // by using a real mail.google.com-hosted... we can't navigate there, so
  // instead verify the detection logic directly is inert on non-Gmail (this
  // page) and separately confirm the gate mechanics via direct state
  // injection, since we cannot navigate Playwright to a real mail.google.com
  // origin in this offline test.
  const html = `<button id="moveto">Move to</button><div id="sidebar"><a id="label1">Personal</a></div>`;
  const { browser, page, agent, provider } = await setup(html);
  try {
    // 3a. Off-Gmail: clicking "Move to" must NOT arm the gate (host check).
    const { messages: mOff } = await run(agent, provider, [
      { id: 'c1', function: { name: 'click', arguments: JSON.stringify({ text: 'Move to' }) } },
    ]);
    check('off-Gmail "Move to" click is NOT blocked (host-scoped correctly)', !(mOff[0]?.content || '').includes('"denied":true'));
    check('gate NOT armed for a non-Gmail host', !agent.gmailLabelMenuFailed.get(TAB_ID));

    // 3b. Directly arm the flag (simulating what the on-Gmail detection sets)
    // and confirm the PRE-EXECUTION gate then blocks the next click/click_ax
    // regardless of target, and clears on get_accessibility_tree.
    agent.gmailLabelMenuFailed.set(TAB_ID, true);
    const { messages: mBlocked } = await run(agent, provider, [
      { id: 'c2', function: { name: 'click_ax', arguments: JSON.stringify({ ref_id: 'ref_1' }) } },
    ]);
    const blockedContent = JSON.parse(mBlocked[0]?.content || '{}');
    check('click_ax blocked while gmailLabelMenuFailed is armed', blockedContent.denied === true, blockedContent);
    check('denial mentions drag_drop', /drag_drop/.test(blockedContent.error || ''), blockedContent);

    await run(agent, provider, [{ id: 'c3', function: { name: 'get_accessibility_tree', arguments: '{}' } }]);
    check('gate clears after an observation tool call', !agent.gmailLabelMenuFailed.get(TAB_ID));
  } finally {
    await browser.close();
  }
}

// ── Test 4: Outcome-warnings surfacing at done() ──────────────────────────
async function testOutcomeWarningsSurfacing() {
  console.log('\n=== Test 4: Outcome-warnings surfacing at done() ===');
  // A plain, listener-free input: filling it changes .value but NOT
  // anything _clickProgressSnapshot fingerprints (innerText/media/control
  // "state" fields don't include a text input's value) — guarantees the
  // "nothing visibly changed" branch fires deterministically.
  // title="" gives the fingerprint a fixed, non-empty label so it never
  // falls back to el.value — _clickProgressSnapshot's controls fingerprint
  // uses `aria-label || title || value || innerText`, so without a title,
  // filling the value WOULD show up in the fingerprint via that fallback,
  // defeating the "nothing visibly changed" test this is meant to force.
  const html = `<input id="inert" value="" title="static label">`;
  const { browser, page, agent, provider } = await setup(html);
  try {
    const fieldRef = await ref(agent, provider, '');
    check('found a ref_id for the inert input', !!fieldRef);
    if (!fieldRef) { await browser.close(); return; }

    await run(agent, provider, [
      { id: 'c1', function: { name: 'set_field', arguments: JSON.stringify({ ref_id: fieldRef, text: 'hello', expect: 'a success message appears on the page' }) } },
    ]);
    const warnings = agent.outcomeWarnings.get(TAB_ID) || [];
    check('outcomeWarnings accumulated an entry for the no-op set_field', warnings.length === 1, warnings);

    const { result } = await run(agent, provider, [
      { id: 'c2', function: { name: 'done', arguments: JSON.stringify({ summary: 'Filled the field successfully.', outcome: 'success' }) } },
    ]);
    const finalText = result?.value || '';
    check('done() surfaces the unresolved outcome-check warning', /Outcome check:.*action\(s\) this run/.test(finalText), finalText);
    check('surfaced text names the tool and the expectation', finalText.includes('set_field') && finalText.includes('success message'), finalText);
  } finally {
    await browser.close();
  }
}

const tests = [
  testIframeAndPressKeys,
  testPressKeysNativeSelect,
  testIframeUrlFilterHostless,
  testGuardA,
  testGuardAClickAxBypass,
  testGuardB,
  testOutcomeWarningsSurfacing,
];

for (const t of tests) {
  try {
    await t();
  } catch (e) {
    fail++;
    console.log(`FAIL (exception in ${t.name}): ${e.message}\n${e.stack}`);
  }
}

console.log(`\n${'='.repeat(50)}\nRESULT: ${pass} passed, ${fail} failed\n${'='.repeat(50)}`);
process.exit(fail ? 1 : 0);
