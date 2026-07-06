// Injects the REAL content-script sources (accessibility-tree.js, content.js,
// agent-visual-indicator.js) into a Playwright page, after stubbing just
// enough of `chrome.runtime` for content.js's top-level
// `chrome.runtime.onMessage.addListener(...)` call to succeed and for us to
// capture the handler it registers.
//
// This is the same trick test/fixtures/run.mjs already uses (see its
// `stubChrome` + `setup()`), reused here so the e2e harness doesn't diverge
// from the pattern the existing fixtures runner validated. We add
// agent-visual-indicator.js because agent.js's real retry path
// (agent.js ~9380) injects all three files together.

import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const CHROME_SRC = path.join(root, 'src', 'chrome', 'src');

const FILES = [
  path.join(CHROME_SRC, 'content', 'accessibility-tree.js'),
  path.join(CHROME_SRC, 'content', 'content.js'),
  path.join(CHROME_SRC, 'content', 'agent-visual-indicator.js'),
];

// BUG FOUND DURING HARNESS DEVELOPMENT (fixed here, in our own mock code —
// not a real agent.js/content.js/tools.js bug): both content.js AND
// agent-visual-indicator.js call `chrome.runtime.onMessage.addListener(...)`
// at their own top level. Real Chrome fans a message out to EVERY
// registered listener (each gets a chance to call sendResponse or return
// `true`); our first version of this stub instead did
// `addListener: (fn) => { window.__wb_handler = fn }`, which just
// overwrites the reference — so whichever file loaded LAST silently won,
// and content.js's real get_accessibility_tree/click_ax/etc. handler was
// discarded in favor of agent-visual-indicator.js's much narrower
// WB_SHOW_AGENT_INDICATORS/WB_HIDE_FOR_TOOL_USE handler. Every
// content-script-mediated tool call then hung forever: agent-visual-
// indicator's handler correctly no-ops (`if (!msg || typeof msg.type !==
// 'string') return;`) for a {target:'content', action:...} message, so
// `sendResponse` was simply never called and our Promise-wrapping
// `chrome.tabs.sendMessage` mock waited indefinitely. Root-caused by
// instrumenting the injected handler and diffing its source against
// content.js's real listener (see the e2e run report for the full
// repro trail). Fix: keep a LIST of listeners and fan out to each,
// matching real chrome.runtime.onMessage dispatch semantics.
const STUB_CHROME_RUNTIME = `
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};
  if (!window.chrome.runtime.onMessage) {
    window.__wb_handlers = [];
    window.chrome.runtime.onMessage = {
      addListener: (fn) => { window.__wb_handlers.push(fn); },
    };
    // window.__wb_handler: fans a message out to every registered listener,
    // same contract chrome.runtime.onMessage uses for a real multi-listener
    // page. Stops at the first listener that either (a) calls sendResponse
    // synchronously, or (b) returns true (claims it will respond async).
    // If none claim the message, calls back with undefined (matches Chrome:
    // no listener responded).
    window.__wb_handler = (msg, sender, sendResponse) => {
      let settled = false;
      const wrappedSend = (resp) => { if (!settled) { settled = true; sendResponse(resp); } };
      for (const fn of window.__wb_handlers) {
        const ret = fn(msg, sender, wrappedSend);
        if (settled) return true; // some listener already responded sync
        if (ret === true) return true; // that listener claims async responsibility
        // else: this listener no-op'd (didn't recognize the message) — try the next one
      }
      if (!settled) sendResponse(undefined);
      return true;
    };
  }
  window.chrome.runtime.getURL = window.chrome.runtime.getURL || ((p) => p);
`;

/**
 * Inject the stub + real content-script sources into `page`'s MAIN world
 * (Playwright has no isolated-world equivalent — see chrome-mock.mjs header
 * for why that's an accepted, documented approximation for this harness).
 * Idempotent: content.js itself guards on `window.__webbrain_injected`, and
 * we additionally short-circuit if `window.__wb_handler` is already present.
 */
export async function injectContentScripts(page) {
  const already = await page.evaluate(() => typeof window.__wb_handler === 'function').catch(() => false);
  if (already) return;

  await page.addScriptTag({ content: STUB_CHROME_RUNTIME });
  for (const file of FILES) {
    const src = await readFile(file, 'utf-8');
    await page.addScriptTag({ content: src });
  }
  await page.waitForFunction(() => typeof window.__wb_handler === 'function', { timeout: 5000 });
}
