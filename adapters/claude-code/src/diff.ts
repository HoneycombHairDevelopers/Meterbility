/**
 * `diffLines` moved to `@meterbility/shared` (eng review 3A,
 * copilot-squad-adapter design): three adapters consume it and the
 * cross-adapter import direction (cursor → claude-code-adapter) was
 * flagged in TODOS as belonging in shared. This module re-exports for
 * back-compat so existing imports of `@meterbility/claude-code-adapter`
 * keep resolving; new code should import from `@meterbility/shared`.
 */
export { diffLines, type DiffResult, type DiffStats } from "@meterbility/shared";
