# Local-Model Reliability Guards

This document covers a family of runtime guards in `_executeToolBatch`
(`src/chrome/src/agent/agent.js`) built to close a gap the rest of the docs
don't cover: **WebBrain works fine with strong cloud models, but a small local
model (this project was hardened against a 35B-parameter local model served
via LM Studio) fails in specific, recurring, mostly non-adversarial ways** —
it isn't being attacked, it's just weaker, and it fails the same handful of
ways over and over. Each guard below exists because that exact failure was
observed live and reproduced, not from speculation.

This is a companion to [security-model.md](security-model.md), not a
duplicate of it: security-model.md defends against a *hostile page*; this
document defends against an *honest but weak model* undermining its own task.
Two guards here (Guard A, Guard B) do double as safety mechanisms and are
cross-referenced from security-model.md's Defense Layers table.

## Why this exists

Cloud frontier models rarely need any of this — they self-correct, ask
clarifying questions unprompted, and rarely confabulate about what they just
did. A weak local model won't reliably do any of that on its own, so the gap
has to be closed mechanically: detect the specific failure pattern in code,
and either force a different action or tell the model plainly what happened.
Every guard below follows the same shape: a narrow, high-signal, low-false-
positive check, with the reasoning for *why it's narrow* written in the
code comment next to it — read those before loosening a check.

## The guards

### Coordinate-click / blind-type loop gate
**State:** `coordLoopMustObserve`, `recentBlindTypeFailures` (Maps, tabId → bool/count)

A weak model tends to guess `click({x, y})` from a screenshot repeatedly
when a click doesn't do what it expected, instead of reading the actual page
structure. Once a coordinate-click loop or two repeated blind `type_text`
focus failures are detected, further blind clicks/types are **hard-blocked**
(not just nudged) until the model calls an observation tool
(`get_accessibility_tree`, `get_interactive_elements`, `extract_data`) or a
ref-based action (`click_ax`, `set_field`, `type_ax`,
`select_dropdown_option`) — see `COORD_LOOP_CLEARING_TOOLS`. A soft nudge
alone was tried first and observed to be non-binding: the model reads the
warning and immediately repeats the same guess anyway.

### Fabricated-credential guard
Blocks `type_ax` / `set_field` / `type_text` when the text contains a
reserved example domain (`@[\w.-]*\bexample\.(com|org|net)`, per RFC 2606).
Nobody's real email is `@example.com` — if the model is about to type one,
it invented a placeholder instead of asking the user for their real login.
Narrow by design so it can never false-positive against real user data.

### Guard A — destructive-confirmation click block
Blocks clicking anything whose resolved label matches `/\banyway\b/i`
("Send anyway", "Post anyway", "Delete anyway", "Continue anyway", …) —
one of the strongest, most site-agnostic signals that **the page itself**
is warning the user this isn't the normal path, without requiring the user
to have confirmed anything first. Deliberately a separate guard from
`permission-gate.js`, which never inspects button text by design (a page
could otherwise talk that gate out of a decision by controlling its own
labels) — this guard trades a sliver of that purity for one narrow,
high-signal phrase.

Covers **both** call shapes:
- `click({text: "Send anyway"})` — checked directly against `fnArgs.text`.
- `click_ax({ref_id: "ref_5"})` — the label is resolved via
  `_resolveRefLabelFromHistory(messages, ref_id)`, which scans backwards
  through the conversation for the `"<label>" [ref_N]` shape
  `get_accessibility_tree` emits, rather than an extra content-script
  round-trip before every `click_ax` call.

The `click_ax` half of this was **not** part of the original guard — see
[Methodology](#methodology-deterministic-tests-are-not-enough) below for how
it was found.

### Guard B — Gmail Labels/Move-to menu-failed gate
**State:** `gmailLabelMenuFailed` (Map, tabId → bool)

Observed live: on Gmail, clicking the "Labels"/"Move to" toolbar button
sometimes silently fails to open its menu (portal-rendered, timing-
sensitive). The model's fallback was to click a label directly in the left
sidebar instead — which only *navigates to that label's view*, it does
**not** apply the label to the selected emails — despite the adapter note
explicitly telling it not to do that.

Mechanism: before any click/click_ax on a `mail.google.com` page, snapshot
page state (`_clickProgressSnapshot`); after the click, if the target text
matched `/^(move to|labels?)$/i` and the snapshot didn't change, the menu
didn't open. That arms `gmailLabelMenuFailed`, which hard-blocks the *next*
click/click_ax until the model either re-observes the page or uses
`drag_drop` (drag the selected email(s) onto the sidebar label — the
functionally-correct fallback) — see `select_dropdown_option` below for the
related composite-tool motivation. The gate clears on any
`COORD_LOOP_CLEARING_TOOLS` call or `drag_drop`.

### Analysis-paralysis escalator
**State:** `consecutiveObservations` (Map, tabId → count)

`OBSERVATION_TOOLS` (tree/state reads) increment a per-tab counter;
`STATE_CHANGE_TOOLS` (or `navigate`/`new_tab`) reset it to zero. At 5
consecutive observations with zero actions, an "OBSERVATION STREAK" nudge
fires. At 8+, an "ANALYSIS PARALYSIS — MANDATORY CHOICE" message forces the
next call to be one of: a state-changing action on an already-seen ref_id,
`clarify()`, or `done()` with an honest failure summary. This was the fix
for a real observed failure: the model froze on a shadow-DOM
misidentification for 10+ read-only calls, took zero actions, and then
**falsely claimed in its `done()` summary that it had tried clicks it never
made** — the receipts mechanism below is what let that lie be caught.

### Receipts
**State:** `runActionLog` (Map, tabId → `[{tool, ident, ok}]`, capped at 120)

Every `STATE_CHANGE_TOOLS` call (plus `navigate`/`new_tab`) appends a
ground-truth entry via `_describeActionForReceipt(name, args)` — deliberately
**never includes typed text** (a `set_field`/`type_ax` value can be a
password, and receipts get surfaced in `done()` results and transcripts;
only targets — ref_id, selector, clicked label, URL — are recorded). This
log is attached at `done()` time so a summary claiming actions that never
happened is visibly contradicted by what actually ran.

### Outcome contracts + outcome-warnings surfacing
**Tools:** `OUTCOME_CONTRACT_TOOLS = {click, click_ax, set_field, type_ax, drag_drop}`
**State:** `outcomeWarnings` (Map, tabId → `[{tool, expect}]`)

Each of those tools accepts an optional `expect: "<what should visibly
happen>"` string. When present, `_clickProgressSnapshot` is taken before and
after the call and diffed (`_checkOutcomeContract`); if nothing visibly
changed, a warning is appended to `resultContent` immediately **and**
accumulated in `outcomeWarnings`. At `done()`, any unresolved warnings are
surfaced in the final summary text regardless of whether the model
mentioned them — this is a *different* failure mode than receipts: a
`set_field` call can succeed by its own report (the DOM value really did
change) while the page never visibly reacted to it (no save confirmation,
no re-render), and the model's `done()` summary can still claim success.
Receipts only catches "claimed an action that didn't happen"; this catches
"the action happened but produced no visible effect, and the summary
doesn't say so."

### `select_dropdown_option` composite tool
Not a guard so much as a fix for a guard-adjacent fragility: the
open-combobox → find-portal-rendered-option → click → verify sequence was
error-prone across 4+ separate tool calls. Collapsed into one deterministic
tool (`content.js` handler) that checks for already-visible options *first*
(a real bug: the naive version unconditionally clicked the trigger, closing
a dropdown the model had already opened itself) before clicking, then
self-verifies via a before/after label diff.

## Known, deliberate non-features

- **No bypass mechanism for Guard A after a `clarify()` exchange.** If the
  model asks and the user says yes, retrying the same "anyway" click will be
  blocked *again* — there's no per-tab "user already authorized this
  specific click" state. Acceptable for now: the guard is meant to force a
  human decision point, and a second explicit confirmation loop is a minor
  friction cost against a real safety property. Revisit if this becomes an
  actual complaint rather than a theoretical one.
- **Guard A is a single regex (`\banyway\b`).** Deliberately narrow — see
  the code comment. Don't expand it to a broader "looks scary" heuristic
  without expecting new false positives; the whole point is that this one
  word is rare in legitimate non-confirmation UI copy.

## Methodology: deterministic tests are not enough

`test/e2e/guard-validation.mjs` is a deterministic, no-LLM regression suite
(21 checks as of this writing) that drives the real `Agent` class directly
via `_executeToolBatch` with hand-crafted `tool_calls` — fast, free, and
exactly reproducible. Run it with `npm run test:e2e-guards`.

**It is not sufficient on its own**, and the reason is worth internalizing:
a hand-crafted test only proves a guard's logic is correct for the exact
call shape you wrote into the test. Guard A's original version passed 16/16
deterministic checks the night it was written, including a dedicated Guard A
test — because that test called `click({text: "Send anyway"})`, the one
shape the guard actually inspected.

Running the *same scenario* against the real local model
(`test/e2e/guard-a-live-test.mjs`, a compose-form fixture with an empty-
subject "Send anyway" trap) showed the model resolve the button via
`get_accessibility_tree` and call `click_ax({ref_id: "ref_5"})` instead —
the tool this codebase steers models toward *everywhere else* — and walk
straight through the guard, actually sending the email
(`sentWithoutSubject: true` in the fixture's ground truth).

The fix (`_resolveRefLabelFromHistory`, described above) closed the gap, and
a new deterministic test (`testGuardAClickAxBypass`) now covers this call
shape too. But the general lesson stands: **a guard that only exists in
hand-crafted-test-shaped code paths only protects hand-crafted-test-shaped
inputs.** For any new guard touching how the model is likely to *actually*
call a tool, budget a live-model run against the real target model before
trusting a deterministic pass. `test/e2e/run-agent-e2e.mjs` is the general-
purpose harness for this (real `Agent` + real Playwright page + real LM
Studio, no extension loading required); `guard-a-live-test.mjs` is a
purpose-built single-scenario variant — copy its shape for a new guard
rather than overloading `run-agent-e2e.mjs`'s default evil-page task.

## Related bug, same investigation

While validating the iframe-interaction fix live, the model burned 10+ steps
with `iframe_type` returning `"Input not found in any matching iframe"`
despite `iframe_read` correctly seeing the target fields. Root cause:
`frameHostMatches` (`permission-gate.js`) and its two inline copies in
`iframe_click`/`iframe_type` (`agent.js`) required an **exact hostname
match** for anti-spoofing (`https://evil.example/?x=stripe.com` shouldn't
match a `urlFilter` of `stripe.com`) — but `file:`, `data:`, `blob:`, and
`about:` frame URLs have **no hostname at all**, so the check failed for
every `urlFilter` unconditionally. Fixed by treating an empty frame hostname
as "nothing to spoof, fall back to the substring check alone" in all three
copies. This wasn't a guard bug, but it was found by the same live-testing
discipline described above, and it silently broke `urlFilter` for any
hostless-scheme iframe — not just test fixtures, but real local/data-URL
iframes in production too.

## Testing reference

| Suite | What it proves | Cost |
|---|---|---|
| `npm run test:e2e-guards` (`guard-validation.mjs`) | Guard *logic* is correct for known call shapes | Free, instant, no GPU |
| `node test/e2e/run-agent-e2e.mjs` | The real model can complete a realistic multi-pattern task end-to-end (shadow DOM, iframe, dropdown, load-more) without a guard false-firing | ~5-8 min, needs LM Studio running |
| `node test/e2e/guard-a-live-test.mjs` | The real model's response to being blocked is actually the desired recovery (stop and ask), not a workaround | ~30s, needs LM Studio running |
| `test/llm/run-scenarios.mjs` | Next-tool-call prediction quality across scenario categories | Per-scenario, needs LM Studio running |

**`test/llm/run-scenarios.mjs` cannot validate any guard in this document.**
It sends one conversation state to the model and scores the *predicted* next
tool call — it never actually executes tools, so a scenario built around
"does the model try to click Send anyway" will show whatever the model would
have called next, with no guard ever in the loop to block it. Guard
regression coverage lives only in `guard-validation.mjs` (logic) and the
`*-live-test.mjs` scripts (live behavior) above.
