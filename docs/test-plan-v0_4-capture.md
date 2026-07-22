# Manual test checklist — v0.4 file side-effect capture

Repeatable verification for the two capture paths that automated tests
can't fully reach: **hook capture** (`meter capture`, exact, Claude
Code) and the **FileSentinel** (`meter watch --files`, heuristic,
cross-vendor). Run before tagging a release that touches capture.

Every step below uses **`meter-dev`** — a global shim for the working
tree (created in §0) — so you're always testing the checkout, never a
published install. A globally installed `meter` can report the same
version while silently running old code.

What's already automated (don't re-test by hand): the full pipeline
logic for both paths, cross-path dedup in both directions, drain over
a real transcript fixture, CLI stdin/exit-code contracts, and a real
`fs.watch` round-trip — see `packages/server/src/file_sentinel.test.ts`,
`packages/server/src/hook_capture.test.ts`,
`packages/cli/src/commands/capture.test.ts` (`npm test`, 1000+ tests).

What only these manual runs prove: real Claude Code hook invocation
and payload shape, ingest/hook timing under real agent latency, both
paths racing under real timing, and platform behavior.

---

## 0. Setup (once per machine)

- [ ] **Create the `meter-dev` shim.** Save this as `meter-dev` in a
      directory on your PATH (e.g. `$(dirname "$(which node)")` under
      your Node 24 install) and `chmod +x` it, substituting your
      checkout path and Node 24 binary:

      ```bash
      #!/usr/bin/env bash
      # meter-dev — runs the Meterbility WORKING TREE from any cwd.
      REPO="$HOME/development/Spool-demo"
      # tsx only auto-discovers the repo tsconfig (which maps
      # @meterbility/* -> packages/*/src) when cwd is inside the repo;
      # pin it or imports silently resolve to stale built dist/.
      export TSX_TSCONFIG_PATH="$REPO/tsconfig.json"
      exec "$HOME/.nvm/versions/node/v24.18.0/bin/node" \
        --import "$REPO/node_modules/tsx/dist/esm/index.mjs" \
        "$REPO/packages/cli/src/index.ts" "$@"
      ```

      The pinned node binary matters (repo needs Node 24 for
      `better-sqlite3`; hooks may run from shells whose default `node`
      is older), and so does `TSX_TSCONFIG_PATH` (without it, running
      from outside the repo loads stale `dist/` builds — versions can
      match while the code doesn't).
- [ ] **Shim sanity, from a cwd outside the repo:**
      `cd /tmp && meter-dev --version && meter-dev capture --help` —
      both succeed (`capture` existing at all proves you're on the
      working tree, not a published install).
- [ ] A scratch git repo to sacrifice, e.g. `~/tmp/capture-lab`, with a
      few text files committed.
- [ ] **Isolate test data (recommended):**
      `export METERBILITY_HOME=~/tmp/meter-test-home` in every terminal
      you use below — keeps test runs out of your real `~/.meter`
      corpus. The hook commands inherit whatever the agent session's
      environment has, so export it before launching Claude Code too
      (or accept mixed-in test data).
- [ ] Baseline sanity: `meter-dev doctor` passes; `npm test` green in
      the repo.

---

## 1. Hook capture — real Claude Code session (exact path)

Setup: in the scratch repo run `meter-dev init --hooks`, then point the
installed hook commands at the shim (the installer writes plain
`meter capture …`, which would resolve to a published install):

```bash
perl -pi -e 's/\bmeter capture/meter-dev capture/g' .claude/settings.json
```

- [ ] Confirm `.claude/settings.json` has `PreToolUse`/`PostToolUse`
      groups, `matcher: "Bash"`, commands `meter-dev capture pre|post`.
- [ ] Re-run `meter-dev init --hooks` and confirm it prints
      `already present` — idempotency must survive the `meter-dev`
      rewrite (no duplicate groups appended).
- [ ] **1.1 Basic exact capture.** Start a Claude Code session in the
      repo. Prompt: *"Run exactly this bash command:
      `echo hello > generated.txt && sed -i '' 's/hello/goodbye/' generated.txt`"*
      (drop the `''` after `-i` on Linux). After the turn completes:
      `meter-dev ingest claude-code --limit 1`, note the run id from
      `meter-dev list`, then `meter-dev files <run-id>`.
      **Expect:** `generated.txt` rows with
      `derived_from = filesystem_watch`, attached to the *correct Bash
      step(s)*, `tool_call_id` populated, diff showing the final
      content — alongside the adapter's partial `(shell)` stub for the
      same step.
- [ ] **1.2 Web UI.** `meter-dev web`, open the run: the Bash step's
      Files tab shows the captured row with a real diff; the `(shell)`
      stub still carries its `partial` badge.
- [ ] **1.3 Ambient-edit guard.** While the session sits idle between
      turns, change a file from OUTSIDE the agent — run
      `echo manual >> notes.md` in a separate terminal, or save an edit
      from any editor. (Do NOT ask the agent to run it — an agent Bash
      edit SHOULD be captured; that's §1.1.) Then have the agent run
      any other Bash command (`ls`). **Expect:** `notes.md` is NOT
      attributed to that Bash step — the `pre` hook folded it into the
      manifest silently. Zero rows for `notes.md`.
- [ ] **1.4 Deletes + renames.** Prompt the agent to run
      `mv generated.txt renamed.txt`. **Expect:** a `delete` row for
      `generated.txt` (with before-bytes) and a `create` row for
      `renamed.txt` — documented v0.4 behavior, no `rename` op.
- [ ] **1.5 Transcript lag / drain.** Have the agent run a Bash write
      and exit the session immediately. Run
      `meter-dev capture drain --json`. **Expect:** either
      `inserted: [...]` now, or `pending: 1` followed by a successful
      drain after `meter-dev ingest claude-code --limit 1`. Nothing
      ever double-inserts on repeated drains.
- [ ] **1.6 Do-no-harm.** `chmod 000 "$METERBILITY_HOME"`. Ask the
      agent to run a Bash command. **Expect:** the agent proceeds
      normally — no hook error surfaces in the session;
      `claude --debug` shows the capture stderr line. If `meter-dev
      web` is up, its pages must degrade (probe panel absent, ingest
      errors logged + retried) — never 500 or crash. After
      `chmod 755`, the next live tick re-ingests anything missed;
      capture rows for the blackout window are honestly absent (the
      store was unwritable — nothing to attribute). ⚠ restore required.
- [ ] **1.7 Parallel Bash.** Prompt the agent to run two file-writing
      Bash calls in one turn (parallel tool use). Claude Code emits
      sibling calls in ONE assistant message, which ingest collapses
      into a single step carrying only the first call's input — so the
      sibling's observation can't input-match any step. **Expect:**
      both deltas land on that collapsed step; the first with
      `normalizer_notes.match = "exact"` (or `"command"`), the sibling
      via the temporal tier with `match = "temporal"`. None vanish,
      none duplicate, nothing left pending after
      `meter-dev capture drain --json`.
- [ ] **1.8 Rows survive re-ingest.** After §1.1 passes, keep the
      session going for several more turns (any commands), and/or
      toggle GO LIVE in `meter-dev web` so the backfill re-ingests the
      session. Then re-check `meter-dev files <run-id>`. **Expect:**
      the captured `filesystem_watch` rows are still there. (Regression:
      `insertStep`'s old `INSERT OR REPLACE` cascade-deleted them on
      every re-ingest tick; found live in the first checklist run.)

## 2. FileSentinel — external observation (heuristic path)

Remove or disable the hooks first (`.claude/settings.json`) so you're
testing the sentinel alone.

- [ ] **2.1 Basic capture.** Terminal A: `meter-dev watch --files` in
      the scratch repo — note the `watching files under … (N files
      primed)` line and that N is plausible (ignores excluded).
      Terminal B: run a Claude Code session that does Bash writes.
      **Expect:** `file:captured <run-id> M path (+a −r)` lines within
      a few seconds; rows visible via `meter-dev files <run-id>` with
      `normalizer_notes.attributed_by = "temporal_proximity"`.
- [ ] **2.2 No active run → no row.** Stop the agent, wait >120s (or
      restart `meter-dev watch --files`), save a file by hand.
      **Expect:** `file:unattributed … (no-active-run)` or
      `(no-recent-step)`, and no row inserted.
- [ ] **2.3 Ignore stack.** `touch node_modules/x .env dist/y`.
      **Expect:** silence — no events, no rows.
- [ ] **2.3b Sensitive paths via tool calls.** Have the agent
      explicitly Write or Edit `.env` (any capture path active).
      **Expect:** a row records the FACT (`path`, `op`, sizes,
      `redacted: true`, `normalizer_notes.redacted_reason:
      "sensitive-path"`) but carries no blobs, no patch, and no
      tool_input echo — the contents never enter the corpus. Applies
      to the `SENSITIVE_METERBILITYIGNORE` set (.env*, keys, pem,
      credentials); non-sensitive ignored paths (node_modules/) still
      get full capture when edited explicitly.
- [ ] **2.4 Attribution window honesty (known limit).** While a run is
      active and inside the 120s window, save a file by hand.
      **Expect:** it IS attributed (heuristic path has no way to tell)
      and the row's `normalizer_notes` mark it heuristic. This is
      accepted behavior; the fix is using hooks for Claude Code.
- [ ] **2.5 JSON mode.** Re-run with `--json` piped to `jq .type` —
      every sentinel event parses as one JSON line.

## 3. Both paths at once (the race)

`meter-dev` hooks installed AND `meter-dev watch --files` running in
the same repo.

- [ ] **3.1 Exactly one row.** Have the agent run a single Bash write.
      Repeat **at least 5×** (the winner is timing-dependent: sentinel
      debounce ~2s vs. hook drain at post). **Expect every time:**
      exactly one row per changed path per step — either path may win,
      never both. `meter-dev files <run-id>` per run to confirm.
- [ ] **3.2 Winner identity.** When the hook wins, the row has
      `tool_call_id` set; when the sentinel wins, it doesn't but the
      notes say `temporal_proximity`. Both are acceptable; note the
      observed split.

## 4. Platform & stress

- [ ] **4.1 Linux pass.** Repeat §0 (shim paths differ), then §1.1,
      §2.1, and §3.1 on Linux (inotify semantics differ from macOS
      FSEvents; drop the `''` after `sed -i`). CI covers unit tests on
      both platforms but not these live flows.
- [ ] **4.2 Prime cost.** In a large repo (10k+ files):
      `time meter-dev watch --files` to first `sentinel:ready`, and
      time the first hooked Bash call (`pre` primes the manifest).
      **Expect:** seconds, not minutes; record the numbers. Check
      manifest size under `$METERBILITY_HOME/capture/` — it rewrites
      per capture, so >10 MB warrants a follow-up issue.
- [ ] **4.3 Rapid writes.** Agent runs a loop touching one file 20×
      quickly. **Expect:** coalesced capture (few rows, correct final
      content), not 20 rows.
- [ ] **4.4 Oversize + binary.** Agent creates a >5 MB file and a
      small PNG. **Expect:** `partial_diff` stub with sizes for the
      big file; `patch_format = binary`, no patch text, byte-exact
      blob for the PNG.
- [ ] **4.5 Blob integrity spot-check.** For one captured row,
      `meter-dev files <run-id>` → grab the after ref →
      `meter-dev web` → `/api/blob/<ref>` matches the on-disk file
      byte-for-byte.

---

## Recording results

Copy this file into the release notes / PR description with boxes
ticked, and note: platform + Node version, the §3.1 winner split, the
§4.2 timings, and any deviation — a deviation in §1.x or §3.1 blocks
release (exactness and no-double-capture are the v0.4 promises); §2.4
and §1.7 deviations are documented limits, fix-forward.

Cleanup after a full pass: remove the scratch repo, unset
`METERBILITY_HOME`, and restore `.claude/settings.json` if you tested
in a repo you keep. The `meter-dev` shim is safe to leave installed —
it never shadows the published `meter`.
