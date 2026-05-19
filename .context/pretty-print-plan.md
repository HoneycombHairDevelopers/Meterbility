# Pretty-print for `spool inspect` step tabs + web step cards

Universal, opt-in pretty-print for the four step-detail tabs (`decision`,
`outcome`, `action`, `cost`). Raw JSON stays the default everywhere so existing
grep/jq pipelines and muscle memory don't break. Pretty mode is the careful-
reading view.

## Decisions locked across both reviews

### Design review (5)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Visual style | Schema-aware field labels with `┃`-prefixed multi-line string blocks. Strings containing `\n` (and `\r\n`) render as real line breaks. |
| D2 | Toggle (CLI) | Raw is default. New `--pretty-print` flag on `spool inspect` opts in. |
| D2 | Toggle (web) | Raw is default. Per-step `Pretty (all tabs)` button in step card header. |
| D3 | Smartness | Domain-aware: use `fmtCents` / `fmtTokens` from `@spool/shared` (see N1). Unparseable decision blob falls back to ┃ block with `(not JSON)` tag. String values truncate at 4 kB with `… (N more chars)` hint (see N3). |
| D4 | Scope | Both `packages/cli/src/commands/inspect.ts` (CLI) and `packages/server/src/html.ts` step cards (web). |
| D5 | Web toggle UX | Button in step header `row-actions`. Persists per-step via localStorage key `spool:pretty:<run_id>:<step_id>=1` (see N5). `aria-pressed` for screen readers. |

### Engineering review (10)

| # | Decision | Choice |
|---|----------|--------|
| A1 | Module location | `packages/server/src/pretty.ts`. CLI imports from `@spool/server` (existing dep direction). |
| A2 | Web color rendering | HTML spans + CSS classes (`.p-section`, `.p-key`, `.p-val`, `.p-str`, `.p-num`). Reuses existing palette CSS variables. |
| A3 | HTML payload strategy | Pre-render both raw and pretty bodies inline per step card. Add `SPOOL_DEBUG` payload sentinel that warns if a run page exceeds 2 MB. Lazy-fetch is the fallback if real usage hits the warning. |
| A4 | Decision truncation | Bump `loadDecisionPreviews` slice from 4 kB to 32 kB. In pretty mode, if `JSON.parse` fails AND the source length equals the slice cap, label `(truncated · view raw)` not `(not JSON)`. |
| A5 | `--pretty-print` + `--show context`/`files` | Silent no-op; those tabs have their own bespoke renderers. Documented in `--help`. |
| C1 | DRY cleanup | Delete all three `prettyJson` copies (`inspect.ts:456`, `html.ts:3068`, `html.ts:3393`). Export single `reformatJsonString` from `@spool/server` (next to `pretty.ts`). All three callsites import it. |
| C2 | Recursion guard | Hard cap `prettyValue` recursion at depth 16. Render `… (deeper structure)` at boundary. |
| N1 | Formatter location | Move `fmtCents` / `fmtTokens` from `packages/cli/src/util.ts` to new `packages/shared/src/format.ts`. CLI's `util.ts` re-exports from `@spool/shared` so existing callers don't change. |
| N2 | Renderer purity | Renderer is pure. Caller pre-resolves `outcome.tool_result_ref` and passes `toolResultText?` through `PrettyOptions`. No store/IO inside `pretty.ts`. |
| N4 | Button placement | Step header (not tab bar). Label reads `Pretty (all tabs)` to make scope explicit. Toggles all 4 tab bodies (visible + hidden) together. |

## API contract (the only public surface)

```ts
// packages/server/src/pretty.ts

export type PrettyMode = "ansi" | "plain" | "html";

export interface PrettyOptions {
  mode: PrettyMode;            // ansi for CLI, html for web, plain for NO_COLOR/piped
  maxStringLen?: number;       // default 4096
  indent?: number;             // default 2
  toolResultText?: string;     // CALLER pre-resolves outcome.tool_result_ref
  truncated?: boolean;         // CALLER tells us "this string hit a slice limit" (for decision blob)
}

export type TabKind = "action" | "outcome" | "decision" | "cost";

/**
 * Decision blob is ALWAYS passed as a string (raw JSON text from the blob store).
 * Other tabs receive their parsed shape (Action / Outcome / cost subset).
 * The renderer is pure — no async, no I/O.
 */
export function prettyTab(
  kind: TabKind,
  value: unknown,
  opts: PrettyOptions,
): string;

// Exported for tests:
export function prettyValue(v: unknown, opts: PrettyOptions, depth: number): string;
export function prettyMultilineString(s: string, opts: PrettyOptions): string;

// Consolidated replacement for the 3 deleted prettyJson copies:
export function reformatJsonString(s: string): string;
```

### Rendering rules

1. **Object** → one field per line, key left-aligned to a column, value inline if short, indented block if nested or multi-line. Known fields render in spec order; unknown fields render after, alphabetically.
2. **String containing `\n` or `\r\n`** → block-quote with `┃` prefix per line. Never show literal escapes.
3. **Array of primitives** → inline `[a, b, c]` if it fits; otherwise one per line.
4. **Number with known semantic** (cost_cents, token counts, latency_ms) → format via `fmtCents` / `fmtTokens` / `"312 ms"`.
5. **null / undefined / empty string** → `—` (em-dash), dimmed.
6. **String > `maxStringLen`** → truncate with `… (N more chars)`.
7. **Recursion depth > 16** → `… (deeper structure)`.
8. **Decision string fallback**: `prettyTab("decision", text, opts)` tries `JSON.parse(text)`. If it throws AND `opts.truncated === true`, emit `(truncated · view raw)`. If it throws and not truncated, emit `(not JSON)`. In both cases render the raw text as a ┃ block.

## Tab-by-tab spec

**action** — `{kind, tool_name?, tool_use_id?, tool_input?, text?, sub_agent?}`

```
action
  kind   tool_call
  tool   Edit                          [toolu_01ab…]
  input
    file_path   packages/cli/inspect.ts
    old_string  ┃ function prettyJson(maybe: string): string {
                ┃   try { … }
                ┃ }
    new_string  ┃ function prettyJson(text, opts): string {
                ┃   …
                ┃ }
```

Special cases: `message` → text as ┃ block; `thinking_only` → text under `thinking`; `sub_agent_dispatch` → `sub_agent` prominent; `none` → `—`.

**outcome** — `{status, summary?, tool_result_ref?, is_error?, state_delta?}`

```
outcome
  status   ok
  summary  edit applied · +4 −4 lines
  result   blob a7f3… · 1.2 kB · view raw   ← from opts.toolResultText (caller-resolved)
  state_delta
    cwd  /Users/.../Spool-demo
```

Status color: red on error, yellow on pending, default on ok (CLI ANSI / web `.p-status-error`/`.p-status-pending`).

**decision** — string blob; renderer parses internally

```
decision
  thinking  ┃ The user is asking about pretty-printing. I need to:
            ┃
            ┃ 1. Check the existing inspect.ts renderer
  plan      ["read inspect.ts", "design pretty-print"]
  next_tool tool_call · Read
```

Fallback when parse fails AND not truncated:

```
decision  (not JSON)
  ┃ I'll start by reading inspect.ts to see
  ┃ how the current renderer dumps each tab.
```

Fallback when parse fails AND `opts.truncated === true`:

```
decision  (truncated · view raw)
  ┃ The user is asking about pretty-printing. I need to:
  ┃ 1. Check the existing
```

**cost** — `{tokens, latency_ms, cost_cents, tags}`

```
cost
  tokens     128 in · 64 out · 1.2k cached read · 0 cache create
  latency    312 ms
  cost       $0.0021
  tags       simulate_miss, fork_origin
```

Empty `tags` → `—`. Uses `fmtTokens` / `fmtCents` from `@spool/shared`.

## CLI behavior — `spool inspect`

```
spool inspect <run-id> [--at <seq>] [--show <tab>] [--diff] [--pretty-print]
```

- Default (no flag): current behavior — `JSON.stringify(x, null, 2)` per tab. **Byte-identical to pre-PR baseline.**
- `--pretty-print`: route action/outcome/decision/cost through `prettyTab` with `mode: "ansi"` (or `"plain"` when `NO_COLOR` is set).
- `--show context --pretty-print` and `--show files --pretty-print`: silent no-op for the context/files tabs (their bespoke renderers are unchanged). Documented in `--help`.
- `spool inspect` `--help` text mentions the flag and that omitting it yields raw JSON.

## Web behavior — step card toggle

In `renderStepCard` (`packages/server/src/html.ts:2820`):

1. Add a button inside the existing `<span class="row-actions">`:
   ```html
   <button class="pretty-toggle" data-step-id="…" data-run-id="…" aria-pressed="false">Pretty (all tabs)</button>
   ```
2. Render BOTH bodies for each of the four tabs at server-render time:
   ```html
   <pre class="body raw">{escaped raw JSON}</pre>
   <pre class="body pretty" style="display:none">{server-rendered HTML spans}</pre>
   ```
   Pretty body uses `prettyTab(kind, value, { mode: "html", … })` and emits `<span class="p-…">…</span>` markup.
3. New CSS rules (add near the existing `.step-card` block in `html.ts`):
   ```css
   .body.pretty .p-section { color: var(--text-primary); font-weight: 600; }
   .body.pretty .p-key { color: var(--text-tertiary); }
   .body.pretty .p-val { color: var(--text-primary); }
   .body.pretty .p-str { color: var(--violet-400); }
   .body.pretty .p-num { color: var(--cerulean-400); }
   .body.pretty .p-status-error   { color: var(--coral-400); }
   .body.pretty .p-status-pending { color: var(--amber-400); }
   ```
4. Client JS handler:
   - On click: flip `display` between `.raw` and `.pretty` for all four tabs in the step, flip `aria-pressed`, write `localStorage.setItem('spool:pretty:' + runId + ':' + stepId, '1')` (or remove key on toggle-off).
   - On `DOMContentLoaded`: iterate `.step-card[data-step]`, for each check `localStorage.getItem('spool:pretty:' + runId + ':' + stepId)`. If set, programmatically toggle.
   - **Live-appended step cards** (SSE fragment endpoint at `web.ts:395`): the existing append code is at `html.ts:1572`. Wrap the mount in a function that checks localStorage immediately AFTER inserting the card into the DOM, BEFORE the user can interact. The fragment endpoint must include the same dual-body markup as the initial render.
5. Tab bodies are already inside their per-tab `<div class="tab tab-decision">` etc. wrappers; the existing `showTab()` function (line 1438) toggles tabs based on `data-tab` and does not care about pretty/raw. The two layers are orthogonal.

## What truncation hint says now (N3)

- CLI pretty: `… (8392 more chars)` (no `--raw` reference; user omits `--pretty-print` for full)
- Web pretty: `… (8392 more chars)` followed by ` <a href="/api/blob/…">view raw</a>` link when the source is a blob reference (decision, tool_result)

## Payload sentinel (A3)

Add to `web.ts` after `renderRun` returns:

```ts
if (process.env.SPOOL_DEBUG && html.length > 2_000_000) {
  console.warn(`spool: run page is ${(html.length / 1024 / 1024).toFixed(1)}MB — consider lazy pretty`);
}
```

User-facing: nothing. If a developer profiles a real run and trips the sentinel, we switch to lazy fetch.

## Implementation shape — file by file

```
packages/shared/src/format.ts          NEW — fmtCents, fmtTokens moved from cli/util.ts
packages/shared/src/index.ts           updated — export ./format
packages/cli/src/util.ts               trimmed — fmtCents/fmtTokens are now re-exports from @spool/shared
packages/server/src/pretty.ts          NEW — prettyTab, prettyValue, prettyMultilineString, reformatJsonString
packages/server/src/pretty.test.ts     NEW — unit tests (node:test)
packages/server/src/index.ts           updated — export pretty.ts public surface
packages/server/src/html.ts            modified — dual <pre> rendering, button, new CSS, replace 2 prettyJson copies with reformatJsonString import, JS handler for toggle + load + live-append
packages/server/src/web.ts             modified — loadDecisionPreviews slice 4000 → 32000, payload sentinel
packages/cli/src/commands/inspect.ts   modified — --pretty-print flag, route tabs through prettyTab, replace prettyJson with reformatJsonString import
packages/server/src/web_v0_3.test.ts   modified — assert dual-body markup, button + aria, CSS class declarations
packages/server/src/e2e/pretty.spec.ts NEW — Playwright E2E (toggle, persistence, reload, live mount)
playwright.config.ts                   NEW — at repo root, headless chrome by default
package.json                           modified — devDep @playwright/test, npm scripts test:e2e
SPEC.md                                modified — note --pretty-print + web toggle in inspector section
README.md                              modified — one-liner under `spool inspect`
```

## Test coverage diagram (output of Section 3)

```
CODE PATHS                                                          STATUS
[+] packages/server/src/pretty.ts (new)
    ├── prettyTab(kind, value, opts)
    │   ├── kind="action"   → renderAction                          [add] unit ★★★
    │   ├── kind="outcome"  → renderOutcome (with toolResultText)   [add] unit ★★★
    │   ├── kind="decision" → JSON.parse OR not-JSON OR truncated   [add] unit ★★★
    │   └── kind="cost"     → renderCost                            [add] unit ★★★
    ├── prettyValue all branches (null/bool/num/str/array/obj/depth) [add] unit ★★★
    ├── prettyMultilineString (\n and \r\n)                          [add] unit ★★★
    ├── reformatJsonString valid + invalid                           [add] unit ★★
    └── decision fallback (truncated vs not-JSON)                    [add] unit ★★★

[+] packages/cli/src/commands/inspect.ts
    ├── default path (no --pretty-print) → BYTE-IDENTICAL            [add] [→GOLDEN REGRESSION] integration ★★★
    └── --pretty-print path → renders pretty                         [add] integration ★★
    └── --show context --pretty-print → context unchanged            [add] integration ★

[+] packages/server/src/html.ts
    ├── renderStepCard emits both <pre.raw> + <pre.pretty>           [add] unit ★★
    ├── Pretty button rendered with aria-pressed="false"             [add] unit ★★
    ├── CSS classes .p-* present in stylesheet                       [add] unit ★
    └── reformatJsonString import (replaces 2 local copies)          [add] regression ★★

[+] packages/server/src/web.ts
    ├── loadDecisionPreviews slice 4000 → 32000                      [add] unit ★★
    └── payload sentinel triggers in SPOOL_DEBUG when >2MB           [add] unit ★

[+] Playwright E2E (packages/server/src/e2e/pretty.spec.ts)
    ├── Click Pretty → all 4 tab bodies flip                         [add] E2E ★★★
    ├── Click Pretty twice → toggles back                            [add] E2E ★★
    ├── Toggle + reload page → state restored                        [add] E2E ★★★
    ├── Toggle step A, scroll to step B → step B stays raw           [add] E2E ★★
    ├── Live-appended step honors localStorage                       [add] E2E ★★★
    ├── Pretty toggle is keyboard-accessible (Tab + Enter)           [add] E2E ★★
    └── localStorage unavailable (cookies disabled) → toggle still works [add] E2E ★

[+] Shared formatter relocation
    └── fmtCents/fmtTokens still callable from old cli/util.ts path  [add] regression ★★

COVERAGE TARGET: 100% of paths above
QUALITY: ★★★ for pretty.ts, regression-critical CLI default path, and E2E happy paths
GOLDEN: CLI default-output regression test must use stored snapshot (no manual eye check)
```

## NOT in scope

| Item | Why deferred |
|------|--------------|
| Auto-disable pretty when stdout is piped | User asked for an explicit flag, not a clever auto-switch. |
| Global config setting for pretty-by-default | Per-invocation flag + per-step web toggle covers it; a config knob is a third source of truth. |
| Bespoke diff rendering for `action.tool_input.old_string` / `new_string` | Rejected as D3-C. Multi-line `┃` block already shows both clearly. |
| `--pretty-print` for `context` and `files` tabs | Those have their own renderers. Adding pretty there is a separate feature. |
| Color-blind palette overrides | Inherit existing palette. No new palette work. |
| Lazy-fetch via `/api/steps/:id/pretty` | Deferred under A3. Sentinel will tell us if we need to flip. |
| Pretty button label customization / icon | "Pretty (all tabs)" text is plain. No icon. |
| Server-Sent Events for pretty state changes (other clients) | localStorage is single-client. No cross-tab sync. |

## What already exists (reuse vs replace)

| Item | Action |
|------|--------|
| `fmtCents` / `fmtTokens` in `cli/util.ts` | Move to `@spool/shared`. CLI re-exports for back-compat. |
| `prettyJson` at `inspect.ts:456` | Delete; replace with `reformatJsonString` import from server. |
| `prettyJson` at `html.ts:3068` | Delete; replace with `reformatJsonString`. |
| `prettyJsonMaybe` at `html.ts:3393` | Delete; replace with `reformatJsonString`. |
| `loadDecisionPreviews` (`web.ts:1235`) | Bump slice cap from 4000 to 32000. |
| Truncation marker `… (N more chars)` at `inspect.ts:452` | Move into `pretty.ts`. |
| `row-actions` markup at `html.ts:2834` | Add `Pretty (all tabs)` button alongside Fork / Annotate. |
| Tab body rendering at `html.ts:2856-2874` | Replace each `<pre class="body">` with the dual `<pre class="body raw">` + `<pre class="body pretty">` pair. |
| SSE step-card fragment endpoint (`web.ts:395`) | Returned fragment must include both bodies (already covered by single-source `renderStepCard`). |
| Live append handler (`html.ts:1572`) | Wrap with localStorage check post-insert. |
| Existing CSS palette (--cerulean-400, --violet-400, --text-tertiary, --coral-400, --amber-400) | Reuse for `.p-*` rules. No new palette tokens. |

## Implementation Tasks (refreshed estimates)

- [ ] **T1 (P1, human: ~1h / CC: ~15 min)** — Move formatters to `@spool/shared`
  - Surfaced by: N1 (codex)
  - Files: `packages/shared/src/format.ts` (new), `packages/shared/src/index.ts`, `packages/cli/src/util.ts`
  - Verify: `import { fmtCents } from '@spool/shared'` works in server; existing `import { fmtCents } from '../util.ts'` still works in CLI (re-export); existing tests pass

- [ ] **T2 (P1, human: ~4h / CC: ~40 min)** — Build `packages/server/src/pretty.ts` + unit tests
  - Surfaced by: D1, D3, C2, N2 (renderer purity), N3 (truncation hint)
  - Files: `packages/server/src/pretty.ts` (new), `packages/server/src/pretty.test.ts` (new), `packages/server/src/index.ts`
  - Verify: every branch in the coverage diagram has a test; truncated vs not-JSON paths both covered; depth-16 cap test; both `\n` and `\r\n` paths tested

- [ ] **T3 (P1, human: ~30 min / CC: ~10 min)** — Delete 3 `prettyJson` copies; export `reformatJsonString` from server
  - Surfaced by: C1
  - Files: `packages/server/src/pretty.ts` (function lives here), `packages/cli/src/commands/inspect.ts`, `packages/server/src/html.ts` (both copies)
  - Verify: `rg 'function prettyJson|function prettyJsonMaybe' packages/` returns zero hits; existing tests pass

- [ ] **T4 (P1, human: ~45 min / CC: ~10 min)** — Wire `--pretty-print` flag + golden regression test
  - Surfaced by: D2, A5, test diagram REGRESSION row
  - Files: `packages/cli/src/commands/inspect.ts`, `packages/cli/src/inspect.test.ts` (new — golden snapshot for default path)
  - Verify: `spool inspect <id> --at 0 --show all` output byte-identical to stored snapshot; `--pretty-print` output renders pretty; `--show context --pretty-print` is a no-op for context

- [ ] **T5 (P1, human: ~1.5h / CC: ~25 min)** — Web step card dual-body rendering + CSS + toggle button
  - Surfaced by: D4, D5, A2, A3, N4
  - Files: `packages/server/src/html.ts` (renderStepCard, CSS, inline JS)
  - Verify: rendered HTML contains both `<pre class="body raw">` and `<pre class="body pretty">` per tab; button has `aria-pressed="false"`; new CSS class declarations present; `web_v0_3.test.ts` assertions pass

- [ ] **T6 (P1, human: ~45 min / CC: ~10 min)** — Decision blob truncation bump + sentinel + truncation badge
  - Surfaced by: A3 (sentinel), A4 (32 kB + truncation detection)
  - Files: `packages/server/src/web.ts` (loadDecisionPreviews slice + sentinel)
  - Verify: `loadDecisionPreviews` slice is 32000; SPOOL_DEBUG warning fires when synthetic >2MB page is rendered; truncation badge appears in pretty mode when decision blob hits the cap

- [ ] **T7 (P1, human: ~1h / CC: ~20 min)** — Live-appended step card honors localStorage
  - Surfaced by: D5, codex's "live-update underspecified"
  - Files: `packages/server/src/html.ts` (inline JS at line 1572 area)
  - Verify: manual test — open run page, toggle Pretty on existing step, send new step via SSE (or use `/api/runs/:id/step-card/:seq` test); new step mounts in raw, existing toggled step stays pretty

- [ ] **T8 (P1, human: ~3h / CC: ~45 min)** — Add Playwright + write E2E suite
  - Surfaced by: T1 eng review decision (full E2E)
  - Files: `playwright.config.ts` (new), `package.json` (devDep + script), `packages/server/src/e2e/pretty.spec.ts` (new), `.github/workflows/*.yml` (if CI exists)
  - Verify: `npm run test:e2e` passes all 7 scenarios from the coverage diagram E2E rows

- [ ] **T9 (P2, human: ~30 min / CC: ~10 min)** — Documentation
  - Surfaced by: codex "documentation misplaced"
  - Files: `SPEC.md` (inspector section), `README.md` (one-liner under spool inspect), `--help` text in inspect.ts (auto from commander option string)
  - Verify: search for `--pretty-print` in user-facing docs returns at least 3 hits (README, SPEC, --help)

**Realistic effort total**: human ~12h / CC ~3.5h. Original estimate was fantasy as codex noted.

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
|------|----------------|------------|
| T1 (move formatters) | shared/, cli/ | — |
| T2 (build pretty.ts) | server/pretty.ts | T1 |
| T3 (delete 3 copies) | server/html.ts, cli/inspect.ts | T2 |
| T4 (CLI flag + golden) | cli/inspect.ts | T2, T3 |
| T5 (web step card) | server/html.ts | T2, T3 |
| T6 (truncation + sentinel) | server/web.ts | T2 |
| T7 (live append JS) | server/html.ts | T5 |
| T8 (Playwright) | new e2e dir | T5, T7 |
| T9 (docs) | SPEC.md, README.md | — |

- **Lane A** (sequential): T1 → T2 → T3 → (T4 ∥ T5 ∥ T6)
- **Lane B** (parallel after T5): T7 → T8
- **Lane C** (independent): T9 (docs, can land anytime)

T4, T5, T6 can run in parallel worktrees once T2 + T3 land; they share no source files. T7 must follow T5 (both touch html.ts JS). T8 must follow T7 (E2E asserts the live-mount behavior). **Conflict flag:** T5 and T7 both edit `html.ts` — must serialize.

## Failure modes

| New codepath | Failure scenario | Test? | Error handling? | User sees? |
|--------------|------------------|-------|-----------------|------------|
| `prettyValue` recursion | Malicious nested decision blob > 16 depth | ✅ unit | ✅ depth cap | "… (deeper structure)" marker |
| `JSON.parse` in decision tab | Decision is partial JSON (truncated) | ✅ unit | ✅ truncation detection | "(truncated · view raw)" badge |
| `JSON.parse` in decision tab | Decision is non-JSON (bare text) | ✅ unit | ✅ not-JSON fallback | "(not JSON)" badge |
| Caller-resolved `toolResultText` | Blob fetch fails (missing/corrupt) | ✅ unit | ✅ undefined → omitted | result row absent or "(missing)" |
| Server pre-render of pretty | A 1000-step run produces 5+ MB HTML | ⚠️ sentinel (dev-only) | ⚠️ profile-then-switch | nothing user-facing; team alerted via SPOOL_DEBUG |
| Client localStorage write | localStorage disabled (private/strict) | ✅ E2E | ✅ try/catch silently | toggle still works in-session, state lost on reload |
| Live-append step card mount | Race: localStorage check runs before card inserted | ✅ E2E | ✅ check post-insert in same tick | step mounts in correct state |
| CLI default output | A future tweak accidentally changes raw output | ✅ golden snapshot | n/a — snapshot guards | snapshot test fails in CI |
| `--show context --pretty-print` | User expects pretty context | ✅ integration test | ⚠️ silent no-op | context renders as usual; `--help` covers it |

**No silent failure paths.** Every failure mode either has a test + error handling, or trips a developer-visible sentinel.

## Open implementation risks

1. **`┃` rendering across terminals**: works on every modern terminal we know of, but if telemetry shows complaints, swap to `|` when `NO_COLOR` is set. Defer until reported.
2. **Decision blob shape varies across adapters** (Anthropic vs OpenAI): the field-ordering rule (known first, unknown alphabetical) handles this, but the unit tests must include real samples from both adapters.
3. **Playwright in CI** (T8): first E2E framework on this repo. CI workflow will need an `npx playwright install --with-deps chromium` step. Verify the team's CI runner supports it.
4. **Re-export shim in cli/util.ts** (T1): re-exporting from `@spool/shared` works for runtime imports, but if any caller uses `import type` from `cli/util.ts` for the formatter type signatures, those need to come from shared too. Quick `rg 'import type.*fmt' packages/` to confirm.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | ISSUES (PLAN via /plan-eng-review) | 16 critiques surfaced; 8 absorbed into plan, 5 cross-model tensions resolved via AskUserQuestion, 3 already covered |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 8 issues found (5 architecture, 1 code quality, 1 test strategy, 1 cross-model); 0 critical gaps; 0 unresolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (PLAN) | score: 2/10 → 9/10, 5 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX**: codex caught 8 NEW issues the design review missed (formatter location, renderer purity, truncation hint string, button placement, localStorage key scoping, decision-arrives-as-string-vs-parsed contract, field ordering for unknown shapes, byte-identical needs golden test). All 8 absorbed into the plan via N1–N5 + doc/spec updates.
- **CROSS-MODEL**: codex and Claude eng review independently surfaced the dependency-direction bug (A1), 3-copy DRY violation (C1), and HTML payload doubling concern (A3 / codex pushback). Strong agreement on those three; the 8 codex-only catches strengthened the plan further.
- **UNRESOLVED**: 0 decisions outstanding. 4 implementation risks tracked under "Open implementation risks".
- **VERDICT**: ENG + DESIGN + OUTSIDE VOICE CLEARED — ready to implement. T1–T9 sequenced with parallelization plan. Recommend starting with T1 (formatter move) to unblock T2.
