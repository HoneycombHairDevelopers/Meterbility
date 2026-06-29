# Regression suite

Productized version of Boris Cherny's `CLAUDE.md` line-per-mistake (SPEC §7.3). Promote a known-good run, derive assertions, run them against new runs whenever a prompt / tool / model changes.

## Quick tour

```bash
# 1. You have a canonical run you're happy with.
meter list
#   → run_abc12345  ok  18 steps  $0.42  main  Refactor user-auth

# 2. Create a test from it.
meter test create user-auth-refactor --from run_abc12345 \
   --description "must use git, no AskUserQuestion, finish under 30 steps"

# 3. The test now has auto-derived assertions.
meter test show user-auth-refactor

# 4. Run it against a candidate run.
meter test run user-auth-refactor run_def45678
#   → PASS  (or FAIL with itemized reasons)

# 5. Run it across every captured run.
meter test run user-auth-refactor
```

## Assertion kinds

| Kind                       | Value type | Meaning                                                       |
| -------------------------- | ---------- | ------------------------------------------------------------- |
| `includes_tool_call`       | string     | Run must call this tool at least once.                        |
| `excludes_tool_call`       | string     | Run must NOT call this tool.                                  |
| `tool_call_count`          | number     | Total tool calls must equal N.                                |
| `output_contains`          | string     | Final assistant message contains substring.                   |
| `output_does_not_contain`  | string     | Final assistant message does not contain substring.           |
| `min_steps`                | number     | At least N steps.                                             |
| `max_steps`                | number     | At most N steps.                                              |
| `final_status`             | "ok"\|"error"\|… | Exact run status.                                       |
| `max_cost_cents`           | number     | Total cost ≤ N cents.                                         |
| `no_error_step`            | 0          | No step has status=error.                                     |
| `step_status_at`           | "ok"\|...  | The step at `--at <seq>` has the given status.                |

## Auto-derived starter set

`meter test create <name> --from <run-id>` populates a starting test with:

- `final_status` = the canonical's status
- `no_error_step`
- `min_steps` = 50% of canonical step count (floor)
- `max_steps` = 150% of canonical step count (ceil)
- `max_cost_cents` = 150% of canonical cost (ceil)
- `includes_tool_call` for every tool actually used in the canonical

You should tighten or relax these by hand — they're a starting point, not a final gate.

## Hand-add assertions

```bash
meter test add-assertion user-auth-refactor includes_tool_call git_commit
meter test add-assertion user-auth-refactor output_does_not_contain "I cannot"
meter test add-assertion user-auth-refactor max_cost_cents 50
```

Numeric values are auto-cast; string values pass through. Use `--at <seq>` for `step_status_at`.

## Round-trip

```bash
# Save a test as a portable JSON file.
meter test export user-auth-refactor -o tests/user-auth.json

# Recreate it elsewhere.
meter test create user-auth-refactor --from-file tests/user-auth.json
```

Useful for committing tests to a repo so they version with your prompts.

## Results history

```bash
meter test results                       # last 25 results across all tests
meter test results user-auth-refactor    # filtered to one test
```

Every `meter test run` writes a `regression_results` row that survives across sessions.

## What's missing in v0.1

- LLM-judge assertions (e.g. "the answer is correct"). Deferred to v1.
- Scheduled runs (cron, on-model-upgrade). The CLI surface is the building block; scheduling is the operator's choice for v0.1 (`launchd`, `cron`, GitHub Actions).
- Live execution against a fresh agent. v0.1 only checks captured runs. To test "does the agent still work?", first re-run the agent (Claude Code, your SDK script, etc.), then check the new run with `meter test run`.
