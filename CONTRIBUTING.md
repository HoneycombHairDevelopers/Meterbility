# Contributing to Spool

Thanks for the interest. This doc covers what you need to know to get a
working dev environment, what we expect in a PR, and how the open-core
licensing split affects where your code lands.

If anything below is unclear or out of date, that's a bug — open an
issue or PR.

---

## TL;DR

```bash
git clone https://github.com/HoneycombHairDevelopers/spool
cd spool
nvm use && npm install            # Node 20.6+ via .nvmrc
npm test                          # TypeScript suite (~250 tests)
cd packages/agent-py && python3 -m unittest discover tests   # Python suite (~50 tests)
```

If both suites pass, you're set up. The hardest part is `better-sqlite3`
needing a native rebuild on first install — give it 60 seconds.

---

## Dev environment

### Required

- **Node 20.6+** — pinned in `.nvmrc`. The repo uses `node --import tsx/esm`,
  which needs the `--import` flag added in 20.6.
- **Python 3.9+** — for the `spool-agent` SDK. Stdlib only at runtime.
- **A C toolchain** — `better-sqlite3` builds a native module on
  install. macOS ships one; on Linux you'll need `build-essential`.

### Recommended

- **`nvm`** or another Node version manager so `.nvmrc` picks the right
  version automatically.
- **`uv`** or **`pipx`** for running Python tests in isolation, but the
  vanilla `python3 -m unittest` invocation works fine.

### First-run verification

```bash
./scripts/fresh-laptop-test.sh
```

This is what CI runs. It clones into a tempdir, installs, runs both
test suites, exercises every documented CLI command, and tears down.
If this passes on your machine, the docs are accurate and your
environment is good.

**Known flake:** `live-events.test.ts:81` fires intermittently when the
TypeScript suite runs in a fresh-laptop env (passes 5/5 in isolation).
The script reports it as `1 CHECK(S) FAILED` with a `KNOWN ISSUES`
note pointing at it. If this is your only failure, you're not blocked
— it'll be cleaned up in a follow-up. Anything else failing IS your
bug to fix before you push.

Useful flags:

- `--copy-tree` — test your local working tree, including uncommitted edits.
- `--from-remote` — test what's actually on `origin/main` right now.
- `--quick` — skip `npm install`, symlink the source repo's `node_modules`.
  Trades install-verification fidelity for ~90 seconds of wall time.
- `--keep` — don't delete the tempdir on exit (prints the path).
- `--skip-python` / `--skip-cli` — bypass those steps individually.

---

## How the codebase is organized

See the [README §Repo layout](README.md#repo-layout). The mental model:

- `packages/shared/` — types + small pure helpers everyone depends on.
- `packages/spec/` — trace format + pricing tables. No runtime logic.
- `packages/collector/` — SQLite + blob store. The data layer.
- `adapters/*/` — turn a vendor's session format into Spool Steps.
- `packages/agent/` and `packages/agent-py/` — SDKs for instrumenting
  custom agents.
- `packages/proxy/` — HTTP proxy that captures Anthropic/OpenAI traffic.
- `packages/server/` — replay engine, fork engine, web UI (Hono),
  live inspector, regression suite, Live Probe panel.
- `packages/cli/` — `spool` command surface.
- `packages/store-postgres/` — optional Postgres backend.
- `packages/web/` — placeholder for a future SPA.
- `ee/` — Enterprise Edition modules. Empty today. **Different
  license** (ELv2) than the rest of the repo.

Workspace deps are wired through npm workspaces — `@spool-ai/*` packages
import each other by name without a build step.

---

## Running the tests

### TypeScript

```bash
npm test                  # full suite, one process, ~60s
```

We use `node:test` (stdlib). Tests live alongside source: `foo.ts` →
`foo.test.ts`. No test runner config; `scripts/run-tests.ts` discovers
`*.test.ts` files across all workspaces.

To run one test file:

```bash
node --import tsx/esm --test packages/shared/src/probe.test.ts
```

### Python

```bash
cd packages/agent-py
python3 -m unittest discover -s tests -v
```

Each test isolates `$SPOOL_HOME` to a tempdir, so the suite never
touches the real `~/.spool`. The TS and Python probe tests share a
file format — if you change either, run both suites.

### Cross-language smoke

If you change `packages/shared/src/probe.ts` OR
`packages/agent-py/src/spool_agent/probe.py`, run a manual interop
check:

```bash
SMOKE=$(mktemp -d) SPOOL_HOME=$SMOKE
node --import tsx/esm -e 'import { requestPause, setInject } from "./packages/shared/src/probe.ts"; requestPause("run_x"); setInject("run_x", "from-ts");'
cd packages/agent-py
python3 -c 'import sys; sys.path.insert(0, "src"); from spool_agent import read_state; print(read_state("run_x"))'
rm -rf "$SMOKE"
```

The Python read should show the TS-set state.

---

## License audit

Every new direct dependency must pass:

```bash
./scripts/license-audit.sh
```

The audit fails closed on any non-allowlist license. Allowed:
`MIT`, `ISC`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`,
`0BSD`, `CC0-1.0`, `Unlicense`, `BlueOak-1.0.0`, multi-OR strings
containing one of these.

If you need a dep that doesn't fit, open an issue first.

---

## PR conventions

- **Branch** from `main`. We don't have a long-lived `develop` branch.
- **Commit style**: subject under 70 chars, imperative mood ("Add probe
  panel", not "Added probe panel" or "Adding probe panel"). Body
  explains the WHY when not obvious.
- **One concern per PR** — easier to review and to revert. Big features
  may ship as a series of incremental PRs (e.g. v0.3 Live Probe shipped
  as a 5-chunk series across one milestone).
- **Tests required.** New code without new tests will get bounced. If
  the change is genuinely untestable, say so in the PR description so
  the reviewer can confirm.
- **No formatter config to fight with** — match the surrounding style.
  TS: 2-space indent, double-quoted strings, trailing commas where ESM
  allows. Python: 4-space, PEP 8.
- **Update docs** in the same PR as the code that changes them.
  README, CONTRIBUTING, and SECURITY are the source of truth for OSS
  users; the spec files (`SPEC.md`, `SPEC-V0.2.md`) are the source of
  truth for design intent.

### What goes in the PR description

- **What changed** — one paragraph
- **Why** — one paragraph
- **How verified** — `npm test` output (or the failing test you fixed)
- **Anything that requires manual verification** — a one-line list

### What we look at first

1. Test diff (matches the source diff?)
2. Surface change (any new export? backwards-incompatible?)
3. Cross-package coupling (new `@spool-ai/*` import that creates a cycle?)
4. The actual logic

---

## Open-core licensing

Spool is open source under MIT for everything outside `/ee`. The `/ee`
directory is reserved for Enterprise Edition modules (multi-tenant
fleet orchestration, SSO, RBAC, audit logs, long-retention) and is
licensed under the **Elastic License 2.0** — see [`ee/LICENSE`](ee/LICENSE).

**As a contributor:**

- Most contributions land in MIT-licensed code. Submit a PR like
  normal.
- Contributions to `/ee` require explicit acknowledgement that the
  code will ship under ELv2. The PR template has a checkbox for this.
- If you're unsure which side your change belongs on, ask in the PR.
  Default to MIT — moving code from `/ee` to MIT later is easy;
  moving the other direction breaks history.

We don't currently require a CLA. By submitting a PR you affirm you
have the right to license your contribution under the relevant license
(MIT or ELv2 depending on path).

---

## Getting help

- **Spec questions** — read [`SPEC.md`](SPEC.md), then
  [`SPEC-V0.2.md`](SPEC-V0.2.md), then ask.
- **"How does X work today?"** — `gh issue` or open a Discussion.
- **Suspected security issue** — read [`SECURITY.md`](SECURITY.md);
  do NOT open a public issue.

Welcome aboard.
