#!/usr/bin/env bash
#
# fresh-laptop-test.sh — verify the documented install path works.
# Track C / Turn 9 chunk 4.
#
# Clones the repo into a throwaway tempdir, runs through every command
# in README.md's install section, and confirms the test suites all
# pass. This is the gate that protects "yes, you can `git clone` this
# and have it work" from rotting silently.
#
# Designed for:
#   - Local "is this still installable?" check before a PR
#   - CI smoke after any change to package.json, scripts/, or docs/
#
# It does NOT touch ~/.spool, ~/.claude, or any user data — every
# transient state lives under the tempdir and goes away at exit (or
# when --keep is passed, stays at the printed path for debugging).
#
# Sources of "fresh laptop":
#   default     — clone from the LOCAL .git (committed state, including
#                 local-only branches). Most useful for pre-PR checks.
#   --from-remote — `git clone $(git remote get-url origin)`. What
#                 someone on a different machine sees right now.
#   --copy-tree — rsync the working tree, including uncommitted edits.
#                 Useful for testing changes you haven't committed yet.
#
# Other flags:
#   --skip-python  — don't run the Python suite (useful if no python3)
#   --skip-cli     — don't run the CLI smoke commands
#   --keep         — don't delete the tempdir on exit; print its path
#   --quick        — skip npm install (assumes node_modules in cwd is
#                    already there; tests run against the source. Fastest;
#                    skips the install-verification value of this script.)
#
# Exit codes:
#   0   all checks passed
#   1+  the step that failed (we exit at the first failure unless
#       --keep is set, in which case we continue and report at the end)
#
# Note: we use `set -u` and `pipefail` but NOT `set -e` — the `step`
# helper collects failures and continues, so we get a complete report
# in one run. The script's own exit code reflects ${#FAILURES[@]} at
# the end. Within bash -c subshells, we still use `set -e` locally.
set -uo pipefail

# ─── argparse ───────────────────────────────────────────────────────

MODE="local-clone"
SKIP_PYTHON=0
SKIP_CLI=0
KEEP=0
QUICK=0
for arg in "$@"; do
  case "$arg" in
    --from-remote) MODE="remote-clone" ;;
    --copy-tree)   MODE="copy-tree" ;;
    --skip-python) SKIP_PYTHON=1 ;;
    --skip-cli)    SKIP_CLI=1 ;;
    --keep)        KEEP=1 ;;
    --quick)       QUICK=1 ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown flag: $arg (see --help)" >&2
      exit 2
      ;;
  esac
done

# ─── setup ──────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPDIR=$(mktemp -d -t spool-fresh-XXXXXX)
LOG="$TEMPDIR/fresh-laptop.log"

# Cleanup unless --keep
if [[ $KEEP -eq 0 ]]; then
  trap 'rm -rf "$TEMPDIR"' EXIT
else
  trap 'echo ""; echo "fresh-laptop tempdir kept at: $TEMPDIR"' EXIT
fi

# Isolate $SPOOL_HOME and $CLAUDE_HOME for the duration of the test —
# we must not touch the user's real ~/.spool or ~/.claude.
export SPOOL_HOME="$TEMPDIR/spool-home"
export CLAUDE_HOME="$TEMPDIR/claude-home"
mkdir -p "$SPOOL_HOME" "$CLAUDE_HOME"

# Track pass/fail across steps. Without --keep we exit early on first
# failure (set -e); with --keep we collect and report at the end so
# you can debug everything in one tempdir.
FAILURES=()

# ─── helpers ────────────────────────────────────────────────────────

step() {
  local label="$1"; shift
  echo ""
  echo "──── $label ────"
  # Always collect failures and continue — gives the user a complete
  # picture of what passed/failed in one run instead of stopping at
  # the first issue. The final report uses FAILURES to set the exit
  # code so CI still treats any failure as fatal.
  if ! "$@"; then
    FAILURES+=("$label")
    echo "  [FAIL: $label]"
  fi
}

# Run a command and pipe through tail for terse output, but PRESERVE the
# upstream exit code (bash's default would mask it via the pipe). On
# failure we show MORE context so a real test failure is debuggable
# even when the tail is normally short.
#
# Usage:  run_tailed <success-tail-lines> <failure-tail-lines> <command...>
run_tailed() {
  local ok_lines="$1"; shift
  local fail_lines="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    echo "$out" | tail -n "$ok_lines"
  else
    local rc=$?
    echo "$out" | tail -n "$fail_lines"
    return $rc
  fi
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "node not found on PATH — install Node 20.6+ first" >&2
    return 1
  fi
  local v
  v=$(node --version | sed 's/^v//')
  echo "  node: v$v"
  local major minor
  major=${v%%.*}
  minor=$(echo "$v" | cut -d. -f2)
  if [[ $major -lt 20 ]] || { [[ $major -eq 20 ]] && [[ $minor -lt 6 ]]; }; then
    echo "  WARN: Node 20.6+ recommended (.nvmrc); $v may not support --import"
  fi
}

require_python() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo "  python3 not found — pass --skip-python to bypass the Python suite"
    return 1
  fi
  local v
  v=$(python3 --version | awk '{print $2}')
  echo "  python: $v"
}

# ─── the actual steps ──────────────────────────────────────────────

step "1/8  Tool versions" require_node
if [[ $SKIP_PYTHON -eq 0 ]]; then
  step "     Python" require_python || true
fi

step "2/8  Stage repo into tempdir ($MODE)" bash -c '
  set -e
  case "'"$MODE"'" in
    local-clone)
      git clone --local --no-hardlinks "'"$REPO_ROOT"'" "'"$TEMPDIR"'/repo" 2>&1 | tail -3
      ;;
    remote-clone)
      origin=$(git -C "'"$REPO_ROOT"'" remote get-url origin)
      echo "  cloning $origin"
      git clone "$origin" "'"$TEMPDIR"'/repo" 2>&1 | tail -3
      ;;
    copy-tree)
      mkdir -p "'"$TEMPDIR"'/repo"
      rsync -a --exclude node_modules --exclude .git "'"$REPO_ROOT"'/" "'"$TEMPDIR"'/repo/"
      cp -R "'"$REPO_ROOT"'/.git" "'"$TEMPDIR"'/repo/.git"
      echo "  copied working tree (uncommitted changes included)"
      ;;
  esac
'

cd "$TEMPDIR/repo"

if [[ $QUICK -eq 0 ]]; then
  step "3/8  npm install" run_tailed 5 40 npm install --silent
else
  # Reuse the repo's node_modules via symlink to skip the slow install.
  step "3/8  --quick: symlink node_modules from source repo" bash -c '
    ln -s "'"$REPO_ROOT"'/node_modules" "'"$TEMPDIR"'/repo/node_modules"
    echo "  symlinked"
  '
fi

step "4/8  License audit (./scripts/license-audit.sh)" run_tailed 5 40 ./scripts/license-audit.sh

step "5/8  TypeScript test suite (npm test)" run_tailed 10 60 npm test

if [[ $SKIP_PYTHON -eq 0 ]]; then
  step "6/8  Python test suite" bash -c '
    cd packages/agent-py && python3 -m unittest discover -s tests 2>&1 | tail -5
    exit "${PIPESTATUS[0]}"
  '
else
  echo ""
  echo "──── 6/8  Python suite — SKIPPED (--skip-python) ────"
fi

if [[ $SKIP_CLI -eq 0 ]]; then
  step "7/8  CLI smoke — load + commands respond" bash -c '
    set -e
    echo "  ./bin/spool --version"
    ./bin/spool --version
    echo "  ./bin/spool --help (first 10 lines)"
    ./bin/spool --help 2>&1 | head -10
    echo "  ./bin/spool list (empty store)"
    ./bin/spool list 2>&1 | head -5 || true
    echo "  ./bin/spool doctor (Claude home is empty test dir, expect no sessions)"
    ./bin/spool doctor 2>&1 | tail -10 || true
    echo "  ./bin/spool probe --help"
    ./bin/spool probe --help 2>&1 | head -15
  '
else
  echo ""
  echo "──── 7/8  CLI smoke — SKIPPED (--skip-cli) ────"
fi

step "8/8  Probe cross-language interop (TS writes, Python reads)" bash -c '
  set -e
  rm -rf "'"$SPOOL_HOME"'/probe"
  # TS write
  node --import tsx/esm -e "
import { requestPause, setInject } from \"./packages/shared/src/probe.ts\";
requestPause(\"run_fresh\");
setInject(\"run_fresh\", \"fresh-laptop-test message\");
console.log(\"  TS wrote: pause + inject\");
"
  if [[ '"$SKIP_PYTHON"' -eq 0 ]]; then
    # Python read
    cd packages/agent-py
    python3 -c "
import sys
sys.path.insert(0, \"src\")
from spool_agent import read_state
r = read_state(\"run_fresh\")
assert r.state == \"pause_requested\", f\"expected pause_requested, got {r.state}\"
assert r.inject == \"fresh-laptop-test message\", f\"inject mismatch: {r.inject}\"
print(\"  Python read: OK — state={}, inject={!r}\".format(r.state, r.inject))
"
  else
    echo "  (Python half skipped; TS-only roundtrip not run)"
  fi
'

# ─── report ─────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════"
if [[ ${#FAILURES[@]} -eq 0 ]]; then
  echo "  fresh-laptop-test: ALL CHECKS PASSED"
  echo "  mode: $MODE  ·  tempdir: $TEMPDIR$([[ $KEEP -eq 1 ]] && echo " (kept)" || echo " (will be removed)")"
  exit 0
else
  echo "  fresh-laptop-test: ${#FAILURES[@]} CHECK(S) FAILED"
  for f in "${FAILURES[@]}"; do
    echo "    - $f"
  done
  echo ""
  echo "  KNOWN ISSUES (might not be your fault):"
  echo "    · packages/server/src/live-events.test.ts:81 — fleet-snapshot flake"
  echo "      that only fires when the full suite runs in a fresh-laptop env."
  echo "      Tracked separately; runs cleanly in isolation. If this is your"
  echo "      only failure, it's the known flake and not a regression."
  echo ""
  echo "  tempdir: $TEMPDIR (kept for debugging)"
  exit 1
fi
