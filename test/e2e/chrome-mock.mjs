// A `chrome` global mock that lets the REAL Agent class (src/chrome/src/agent/agent.js)
// run its full processMessage()/processMessageStream() loop against a REAL
// Playwright page, standing in for a real Chrome tab. No extension is loaded;
// no UI is involved. We go straight from this Node script to
// `new Agent(providerManager)` then `agent.processMessage(tabId, ...)`.
//
// WHY THIS SHAPE: agent.js's own tool-executor code (see agent.js around the
// `actionMap` object, ~line 9251) funnels most DOM-touching tools through
// `chrome.tabs.sendMessage(tabId, {target:'content', action, params})`, which
// is exactly what `src/chrome/src/content/content.js`'s
// `chrome.runtime.onMessage.addListener(...)` handles. test/fixtures/run.mjs
// already solved "inject content.js + accessibility-tree.js into a Playwright
// page and reach its onMessage handler" via a `window.__wb_handler` capture
// hook — we reuse that exact trick here rather than reinventing it.
//
// A second, disjoint code path (get_shadow_dom, shadow_dom_query, drag_drop,
// coordinate clicks, iframe_read/click/type, full_page_screenshot, etc.) goes
// through `cdpClient` (src/chrome/src/cdp/cdp-client.js), a singleton that
// calls `chrome.debugger.sendCommand(...)` directly (Runtime.evaluate,
// Input.dispatchMouseEvent, DOM.*, Page.*, Overlay.*). We mock
// chrome.debugger.* by translating each CDP method into the closest
// Playwright equivalent (mostly `page.evaluate` for Runtime.evaluate, and
// `page.mouse`/`page.keyboard` for Input.*). This is an approximation, not a
// real CDP session — see the per-method notes below for exact fidelity gaps.
//
// LIMITATIONS (documented, not silently papered over):
//  - Playwright has no true "isolated world" the way chrome.scripting's
//    world:'ISOLATED' does. All page.evaluate calls here run in the page's
//    MAIN world. This means content.js's `window.__generateAccessibilityTree`
//    /`window.__wb_ax_lookup` helpers (normally attached in an isolated
//    world so page JS can't see/clobber them) are attached to the REAL
//    `window` here. For a synthetic test fixture we fully control, this is
//    safe; it would NOT be a safe stand-in for testing anti-tampering /
//    hostile-page behavior.
//  - chrome.debugger's real event-driven attach/detach lifecycle, and the
//    distinction between "attached to tabId" vs "attached to a specific CDP
//    session", is collapsed to "the mock is always attached to the single
//    Playwright page we were constructed with." Multi-tab CDP scenarios are
//    out of scope for this harness.
//  - chrome.downloads / chrome.alarms / chrome.tabGroups / chrome.action are
//    stubbed minimally (enough that agent.js doesn't throw) — they are not
//    exercised meaningfully because our fixture never downloads a file or
//    groups tabs.
//  - Only ONE tab/page is modeled. chrome.tabs.query({}) returns a
//    single-element array. chrome.tabs.create() is a no-op stub that returns
//    a fake second tab id without actually opening anything in Playwright —
//    the synthetic test task deliberately avoids `new_tab`.

import { EventEmitter } from 'node:events';

// ---- tiny chrome.runtime.lastError shim -----------------------------------
// Real chrome.* callback APIs signal errors via the ambient
// chrome.runtime.lastError rather than throwing. We fake the same contract:
// set it right before invoking a callback that should "fail", and code that
// checks `chrome.runtime.lastError` synchronously right after the callback
// fires will see it. This is fragile in real Chrome (must be read
// synchronously) and just as fragile here — by design, so behavior matches.
function makeLastErrorHolder() {
  return { current: null };
}

/**
 * Build a full `chrome` mock object bound to one Playwright `page`.
 *
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @param {(entry: object) => void} [opts.onLog] - called for every mocked
 *   chrome.* call we consider "interesting" to trace (tabs.sendMessage,
 *   scripting.executeScript, debugger.sendCommand). Use this to build a
 *   transcript of what the agent actually did to the page.
 * @returns {{ chrome: object, storageLocalSeed: (obj: object) => void }}
 */
export function createChromeMock(page, opts = {}) {
  const onLog = opts.onLog || (() => {});
  const FAKE_TAB_ID = 1;
  const FAKE_WINDOW_ID = 1;

  const storageLocal = new Map();
  const storageSession = new Map();
  const lastError = makeLastErrorHolder();

  // ---- runtime.onMessage (background <-> content) --------------------------
  // Nothing in this harness sends messages to a background page (we ARE the
  // background — we call agent.processMessage directly), but content.js's
  // own onMessage.addListener call must not throw, and downloadResourceFromPage /
  // other helpers may add listeners too. We fan out addListener calls to an
  // in-process EventEmitter and let chrome.tabs.sendMessage below drive them
  // for same-process cases (unused here since content.js lives in the page,
  // not in this Node process — see chrome.tabs.sendMessage instead).
  const runtimeMessageBus = new EventEmitter();
  runtimeMessageBus.setMaxListeners(100);

  async function currentUrl() {
    let href;
    try { href = await page.evaluate(() => location.href); } catch { return 'about:blank'; }
    // The permission gate resolves a HOST from the tab URL to permission-check
    // state-changing actions. A file:// fixture URL has no host, so the gate
    // fails closed ("target frame/host couldn't be identified") and every
    // click is rejected — a pure harness artifact, since real fixtures are
    // served over https. Present a stable synthetic https host for file://
    // (and about:blank) so host-based logic behaves as it would on a real
    // page. The actual Playwright navigation still uses the real file:// URL.
    if (/^(file:|about:)/i.test(href || '')) {
      const base = String(href).split('/').pop() || 'index';
      return `https://e2e.fixture.local/${base}`;
    }
    return href;
  }
  async function currentTitle() {
    try { return await page.evaluate(() => document.title); } catch { return ''; }
  }

  function fakeTab(url, title) {
    return {
      id: FAKE_TAB_ID,
      windowId: FAKE_WINDOW_ID,
      url,
      title,
      status: 'complete',
      active: true,
      index: 0,
      pinned: false,
      incognito: false,
    };
  }

  // ---- chrome.tabs -----------------------------------------------------
  const tabs = {
    async get(tabId) {
      const url = await currentUrl();
      const title = await currentTitle();
      return fakeTab(url, title);
    },
    async query(_queryInfo) {
      const url = await currentUrl();
      const title = await currentTitle();
      return [fakeTab(url, title)];
    },
    async update(tabId, updateProps) {
      onLog({ api: 'chrome.tabs.update', tabId, updateProps });
      if (updateProps?.url) {
        await page.goto(updateProps.url, { waitUntil: 'domcontentloaded' }).catch((e) => {
          onLog({ api: 'chrome.tabs.update', error: e.message });
        });
      }
      return fakeTab(await currentUrl(), await currentTitle());
    },
    async create(createProps) {
      onLog({ api: 'chrome.tabs.create', createProps, note: 'STUB: no second Playwright page opened' });
      // The synthetic fixture/task never calls new_tab; if the agent tries
      // it anyway, hand back a plausible-looking but inert tab object rather
      // than throwing, so the run degrades gracefully instead of crashing.
      return fakeTab(createProps?.url || 'about:blank', '');
    },
    async captureVisibleTab(_windowId, _opts) {
      onLog({ api: 'chrome.tabs.captureVisibleTab' });
      const buf = await page.screenshot({ type: 'png' });
      return 'data:image/png;base64,' + buf.toString('base64');
    },
    async sendMessage(tabId, message) {
      // THE central bridge. agent.js's content-script-mediated tools
      // (get_accessibility_tree, click_ax, type_ax, set_field, click,
      // type_text, press_keys, scroll, extract_data, inspect_element_styles,
      // wait_for_element, wait_for_stable, get_selection) all arrive here as
      // {target:'content', action, params}. content.js's own
      // chrome.runtime.onMessage.addListener is captured (by our page-side
      // stub, injected in setupContentScript()) onto window.__wb_handler.
      // We invoke it in-page and return its response the same way the real
      // extension's message-passing would.
      const t0 = Date.now();
      const result = await page.evaluate(({ message }) => {
        return new Promise((resolve) => {
          if (typeof window.__wb_handler !== 'function') {
            resolve({ error: 'content.js not injected / __wb_handler missing' });
            return;
          }
          let settled = false;
          const done = (resp) => { if (!settled) { settled = true; resolve(resp); } };
          const ret = window.__wb_handler(message, {}, done);
          // Synchronous handlers return a value directly instead of calling
          // sendResponse; async ones return `true` and call sendResponse later.
          if (ret !== true && ret !== undefined) done(ret);
        });
      }, { message }).catch((e) => ({ error: `page.evaluate threw: ${e.message}` }));
      onLog({ api: 'chrome.tabs.sendMessage', message, result, latencyMs: Date.now() - t0 });
      return result;
    },
    async group(_opts) { return -1; },
  };

  // ---- chrome.scripting --------------------------------------------------
  const scripting = {
    async executeScript(injection) {
      const t0 = Date.now();
      // Two call shapes appear in agent.js:
      //  (a) { target: {tabId}, files: [...] }  — inject content.js et al.
      //  (b) { target: {tabId, allFrames}, func, args } — run a real function
      //      (iframe_read/click/type, and a handful of probe helpers).
      if (Array.isArray(injection.files)) {
        // Inline the requested source files into the page. Paths are relative
        // to src/chrome/ in the real extension; the caller (test harness) is
        // responsible for making sure `injectContentScripts` already ran, so
        // in practice this branch only fires if the mock's onMessage bridge
        // reports "not injected" and agent.js retries — see agent.js ~9380.
        onLog({ api: 'chrome.scripting.executeScript', mode: 'files', files: injection.files });
        const { injectContentScripts } = await import('./content-inject.mjs');
        await injectContentScripts(page);
        return [{ frameId: 0, result: undefined }];
      }

      if (typeof injection.func === 'function') {
        const allFrames = !!injection.target?.allFrames;
        const fn = injection.func;
        const fnArgs = injection.args || [];
        const results = [];
        // Playwright's evaluate(pageFunction, arg) takes exactly ONE arg —
        // spreading fnArgs as extra positional arguments to .evaluate() itself
        // (not to pageFunction) throws "Too many arguments" for any call
        // site with args.length > 1. The real chrome.scripting.executeScript
        // API has no such limit (func gets called with the full args array
        // spread positionally) — 5 real call sites in agent.js pass 2-4 args
        // (iframe_type, iframe_click, and the arrow-key/press_keys coordinate
        // helpers), all of which silently/loudly failed under this mock
        // before this fix (confirmed live: iframe_type reported "input not
        // found in any matching iframe" in every frame, for every attempt,
        // because evaluate() was throwing before fn ever ran — not because
        // the element was actually missing).
        //
        // Fix: always pass exactly ONE arg to evaluate() — a plain data
        // object carrying fn's SOURCE STRING plus fnArgs — and reconstruct +
        // invoke fn from that source INSIDE the page/frame context. The
        // wrapper below must NOT close over `fn` (or anything else from this
        // Node-side scope): Playwright serializes the wrapper via its own
        // toString() to run in the browser, where Node-side closure
        // variables don't exist — a wrapper that referenced `fn` directly
        // would throw "fn is not defined" the instant it ran. Passing
        // fn.toString() as DATA inside the single arg object sidesteps that
        // entirely. Safe because every func passed here is a pure,
        // closure-free function (verified across all 5 real call sites) —
        // it only reads its own parameters, so round-tripping through
        // toString()/`new Function` loses nothing.
        const wrapper = (payload) => {
          // eslint-disable-next-line no-new-func
          const rebuilt = new Function('return (' + payload.fnSource + ')')();
          return rebuilt(...payload.args);
        };
        const payload = { fnSource: fn.toString(), args: fnArgs };
        if (allFrames) {
          for (const frame of page.frames()) {
            try {
              const value = await frame.evaluate(wrapper, payload);
              results.push({ frameId: results.length, result: value });
            } catch (e) {
              results.push({ frameId: results.length, result: { ok: false, error: e.message, url: frame.url() } });
            }
          }
        } else {
          try {
            const value = await page.evaluate(wrapper, payload);
            results.push({ frameId: 0, result: value });
          } catch (e) {
            results.push({ frameId: 0, result: { ok: false, error: e.message } });
          }
        }
        onLog({ api: 'chrome.scripting.executeScript', mode: 'func', allFrames, frameCount: results.length, latencyMs: Date.now() - t0 });
        return results;
      }

      onLog({ api: 'chrome.scripting.executeScript', mode: 'unknown', injection });
      return [{ frameId: 0, result: undefined }];
    },
  };

  // ---- chrome.storage -----------------------------------------------------
  function storageApi(map) {
    return {
      async get(keys) {
        if (keys == null) {
          return Object.fromEntries(map.entries());
        }
        const keyList = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = {};
        for (const k of keyList) {
          if (map.has(k)) out[k] = map.get(k);
          else if (!Array.isArray(keys) && typeof keys === 'object') out[k] = keys[k]; // defaults shape
        }
        return out;
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) map.set(k, v);
      },
      async remove(keys) {
        const keyList = typeof keys === 'string' ? [keys] : keys;
        for (const k of keyList) map.delete(k);
      },
      async clear() { map.clear(); },
    };
  }

  // ---- chrome.debugger (CDP surface, approximated via Playwright) --------
  // cdp-client.js's real calls are exclusively:
  //   chrome.debugger.attach/detach/sendCommand + onEvent/onDetach listeners.
  // We implement sendCommand for the specific CDP methods cdp-client.js
  // actually issues (see src/chrome/src/cdp/cdp-client.js), translating each
  // to Playwright. Anything we don't recognize returns a best-effort empty
  // object rather than throwing, so unanticipated CDP calls degrade instead
  // of crashing the whole run — but they ARE logged so we notice.
  const debuggerListeners = { onEvent: [], onDetach: [] };
  let debuggerAttached = false;

  async function cdpDispatch(method, params) {
    switch (method) {
      case 'DOM.enable':
      case 'Runtime.enable':
      case 'Page.enable':
      case 'Input.enable':
      case 'Overlay.enable':
        return {};

      case 'Runtime.evaluate': {
        // cdp-client.js wraps `expression` as a plain JS expression string
        // (already an IIFE), awaits promises, returns by value.
        const expr = params.expression;
        try {
          const value = await page.evaluate(new Function(`return (${expr});`));
          return { result: { value } };
        } catch (e) {
          // CDP would return exceptionDetails; approximate with a thrown-like shape.
          return { result: { value: undefined }, exceptionDetails: { text: e.message } };
        }
      }

      case 'Runtime.callFunctionOn': {
        // Used for probeLocalFile / getFileInputFiles / node .click(). We only
        // support the "objectId refers to a value we tracked" pattern loosely:
        // since we don't implement a real Runtime object registry, we treat
        // objectId as an opaque JSON-encoded {selector} the resolveSelector
        // path attached — see DOM.resolveNode below for how objectId is minted.
        try {
          const target = objectRegistry.get(params.objectId);
          if (!target) return { result: { value: null } };
          const fn = new Function(`return (${params.functionDeclaration});`)();
          const value = await page.evaluate(
            ({ selector, fnSrc, args }) => {
              const el = document.querySelector(selector);
              // eslint-disable-next-line no-new-func
              const f = new Function('return (' + fnSrc + ')')();
              return f.apply(el, args || []);
            },
            { selector: target.selector, fnSrc: params.functionDeclaration, args: (params.arguments || []).map(a => a.value) },
          );
          return { result: { value } };
        } catch (e) {
          return { result: { value: null }, exceptionDetails: { text: e.message } };
        }
      }

      case 'DOM.getDocument':
        return { root: { nodeId: 1, nodeName: '#document' } };

      case 'DOM.getFlattenedDocument':
      case 'DOM.querySelectorAll':
        return { nodeIds: [] };

      case 'DOM.querySelector': {
        // Used by cdp-client's closed-shadow-root fallback in resolveSelector.
        // We don't model closed shadow roots distinctly from Playwright's
        // (which pierces open shadow DOM via page.evaluate already handled in
        // Runtime.evaluate above) — return not-found so callers fall back to
        // the JS-walker strategy, which IS accurate for open shadow roots.
        return { nodeId: 0 };
      }

      case 'DOM.describeNode':
        return { node: { nodeName: 'DIV', backendNodeId: params.nodeId, shadowRoots: [] } };

      case 'DOM.resolveNode': {
        // Mint an opaque objectId keyed to nothing useful without a real
        // selector context; most cdp-client callers that need this go through
        // Runtime.evaluate's JS-walker path instead, which we fully support.
        const objectId = `obj_${++objectIdCounter}`;
        objectRegistry.set(objectId, { selector: params.__selectorHint || 'body' });
        return { object: { objectId } };
      }

      case 'DOM.getBoxModel': {
        return null; // triggers cdp-client's graceful "could not get box model" paths
      }

      case 'DOM.focus':
      case 'DOM.scrollIntoViewIfNeeded':
      case 'DOM.setFileInputFiles':
        return {};

      case 'DOM.getAttributes':
        return { attributes: [] };

      case 'Input.dispatchMouseEvent': {
        const { type, x, y } = params;
        try {
          if (type === 'mouseMoved') await page.mouse.move(x, y);
          else if (type === 'mousePressed') { await page.mouse.move(x, y); await page.mouse.down(); }
          else if (type === 'mouseReleased') await page.mouse.up();
        } catch (e) { /* best effort */ }
        return {};
      }

      case 'Input.dispatchKeyEvent': {
        const { type, key } = params;
        try {
          if (type === 'keyDown') await page.keyboard.down(key);
          else if (type === 'keyUp') await page.keyboard.up(key);
        } catch (e) { /* best effort */ }
        return {};
      }

      case 'Input.insertText': {
        try { await page.keyboard.insertText(params.text); } catch (e) { /* best effort */ }
        return {};
      }

      case 'Page.getFrameTree': {
        const main = page.mainFrame();
        const toFrameNode = (f) => ({
          frame: { id: f.url() + '#' + Math.random().toString(36).slice(2), url: f.url(), name: f.name() },
          childFrames: f.childFrames().map(toFrameNode),
        });
        return { frameTree: toFrameNode(main) };
      }

      case 'Page.captureScreenshot': {
        const buf = await page.screenshot({ type: 'png' });
        return { data: buf.toString('base64') };
      }

      case 'Page.createIsolatedWorld':
        // Playwright has no isolated-world equivalent; report failure so
        // callers (probeLocalFile) fall back to the main-world path, which we
        // DO support. Documented limitation (see file header).
        return { executionContextId: null };

      case 'Emulation.setDeviceMetricsOverride':
      case 'Overlay.highlightQuad':
      case 'Overlay.hideHighlight':
      case 'Runtime.releaseObject':
        return {};

      default:
        onLog({ api: 'chrome.debugger.sendCommand', method, params, note: 'UNMOCKED CDP METHOD — returned {}' });
        return {};
    }
  }
  let objectIdCounter = 0;
  const objectRegistry = new Map();

  const debuggerApi = {
    attach(_target, _version, callback) {
      debuggerAttached = true;
      lastError.current = null;
      Promise.resolve().then(() => callback());
    },
    detach(_target, callback) {
      debuggerAttached = false;
      lastError.current = null;
      Promise.resolve().then(() => callback && callback());
    },
    sendCommand(_target, method, params, callback) {
      const t0 = Date.now();
      cdpDispatch(method, params || {})
        .then((result) => {
          lastError.current = null;
          onLog({ api: 'chrome.debugger.sendCommand', method, params, latencyMs: Date.now() - t0 });
          callback(result);
        })
        .catch((e) => {
          lastError.current = { message: e.message };
          onLog({ api: 'chrome.debugger.sendCommand', method, params, error: e.message });
          callback(undefined);
        });
    },
    onEvent: {
      addListener(fn) { debuggerListeners.onEvent.push(fn); },
    },
    onDetach: {
      addListener(fn) { debuggerListeners.onDetach.push(fn); },
    },
  };

  // ---- chrome.downloads / alarms / tabGroups / action — minimal stubs ----
  const downloads = {
    search(_query, callback) { callback([]); },
    download(_opts, callback) { callback(1); },
    onChanged: { addListener() {}, removeListener() {} },
  };
  const alarms = {
    create() {}, clear(_name, cb) { cb && cb(true); }, onAlarm: { addListener() {} },
  };
  const action = { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setIcon: async () => {} };
  const runtime = {
    id: 'test-harness-fake-extension-id',
    get lastError() { return lastError.current; },
    onMessage: { addListener(fn) { runtimeMessageBus.on('message', fn); } },
    sendMessage: async () => { /* no background/side-panel listener in this harness */ },
    getURL: (p) => `chrome-extension://test-harness-fake-extension-id/${p}`,
    getPlatformInfo(callback) {
      const info = { os: process.platform === 'darwin' ? 'mac' : 'linux', arch: 'x86-64', nacl_arch: 'x86-64' };
      if (typeof callback === 'function') { callback(info); return undefined; }
      return Promise.resolve(info);
    },
  };

  const chromeMock = {
    tabs,
    scripting,
    storage: { local: storageApi(storageLocal), session: storageApi(storageSession) },
    debugger: debuggerApi,
    downloads,
    alarms,
    action,
    runtime,
    tabGroups: undefined, // absent on purpose: agent.js feature-detects `chrome.tabGroups`
    webNavigation: { onCommitted: { addListener() {} }, onHistoryStateUpdated: { addListener() {} } },
  };

  return {
    chrome: chromeMock,
    storageLocal,
    storageSession,
    seedStorageLocal(obj) { for (const [k, v] of Object.entries(obj)) storageLocal.set(k, v); },
  };
}
