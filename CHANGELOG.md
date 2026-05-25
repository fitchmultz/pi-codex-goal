# Changelog

## Unreleased

- Bounds hidden goal continuation provider context by superseding older active-goal continuations with short bookkeeping markers, refreshing only the latest continuation, and using compact auto-continuation prompts after `/goal` start or resume.
- Stops provider-error continuation retry storms by skipping immediate hidden requeues on `stopReason: "error"`, auto-compacting on context-window overflow when available, using bounded backoff for transient failures, and pausing with a recoverable `/goal resume` path when recovery is exhausted.
- Makes goal lifecycle transitions terminal and idempotent: duplicate `update_goal complete` calls no longer append extra session entries, completed goals cannot be paused or resumed, and runtime/compaction skips unchanged goal snapshots.
- Allows `create_goal` to replace a completed goal and clarifies recovery via `/goal <objective>` or `/goal clear`.
- Surfaces failed goal tool calls as real pi tool errors by throwing from tool handlers.

## 0.1.12 - 2026-05-23

- Updated the local pi development baseline to `@earendil-works/*` `0.75.5`, refreshed Node/tsx tooling, and regenerated the npm lockfile.
- Reviewed the pi `0.75.5` changelog and package guidance; the goal extension remains compatible with current extension lifecycle and package install/update behavior.

## 0.1.11 - 2026-05-21

- Cancels stale hidden goal continuations before they can reach the model after a goal is completed, cleared, or replaced.
- Keeps stale abort cleanup from charging tokens, pausing active replacement goals, persisting extra entries, or requeueing continuations during compaction and shutdown.
- Allows normal interactive and RPC prompts that paste continuation marker text to pass through instead of being treated as hidden extension follow-up work.
- Adds regression coverage for stale queued work across missing or delayed `agent_end`, late stale terminal events, compaction cleanup, and pasted marker input sources.

## 0.1.10 - 2026-05-18

- Updated the local pi package baseline to `@earendil-works/*` `0.75.3` and refreshed the npm lockfile.
- Removed tracked CueLoop runtime state from the package and ignored local `.cueloop/` artifacts.


## 0.1.9 - 2026-05-09

- Escapes goal objectives in hidden continuation and budget-limit prompts before embedding them in XML-style untrusted blocks.
- Keeps budget-limited goals from being paused or resumed back to active while they remain at or over budget.
- Sends a one-shot hidden budget-limit steering message when token accounting crosses the configured budget.
- Keeps ordinary user prompts from silently reactivating paused goals; session resume now prompts before restarting a paused goal.
- Returns Codex-shaped goal tool responses with `remainingTokens` and completion budget reports.
- Prevents tokens from an old in-flight turn from being charged to a replacement goal.
- Updates `/goal` summary and footer labels toward Codex-style status wording while retaining this package's 8000-character objective limit.

## 0.1.8 - 2026-05-07

- Migrates the local pi development baseline and peer metadata from deprecated `@mariozechner/*` packages to maintained `@earendil-works/*` `0.74.0`.
- Regenerates the npm lockfile against the current stable dependency graph.

## 0.1.7 - 2026-05-07

- Keeps active goals continuing after auto-compaction, including length-stop compactions.
- Prevents stale queued goal continuations from running after a goal is completed or changed.
- Strengthens completion-audit prompts and update-goal guidance so goals are marked complete only after verified completion.
- Avoids duplicate persisted completion entries from `update_goal`.

## 0.1.6 - 2026-05-06

- Clarifies README install commands for npm, pinned npm, GitHub, and pinned GitHub package installs.

## 0.1.5 - 2026-05-06

- Counts goal tokens from completed assistant input plus output usage instead of `usage.totalTokens`.
- Excludes cache read and cache write accounting channels from goal token budgets so cached provider tokens do not inflate sent and received totals.

## 0.1.4 - 2026-05-06

- Pauses active goals when pi reports an aborted assistant turn, including user Esc aborts.
- Resumes paused goals automatically on the next user-driven agent start, while keeping `/goal resume` available.
- Prevents aborted turns from immediately queueing hidden continuation messages.

## 0.1.3 - 2026-05-06

- Corrects the README behavior summary to describe completed assistant turn token accounting.

## 0.1.2 - 2026-05-06

- Counts completed assistant turn usage via pi's `usage.totalTokens` instead of using context-window deltas, so goal token totals track tokens sent and received across compaction.
- Keeps elapsed-time accounting stable before and after compaction while continuing to persist active goal state.

## 0.1.1 - 2026-05-06

- Marks pi runtime peer dependencies as optional so `pi install npm:pi-codex-goal` stays lightweight while still documenting the extension runtime contract.

## 0.1.0 - 2026-05-06

- Initial public release.
- Adds Codex-style `/goal` tracking for pi.
- Adds model-callable `get_goal`, `create_goal`, and `update_goal` tools.
- Persists goal state in pi session custom entries for resume, reload, fork, tree navigation, and compaction.
- Starts and resumes goals with hidden follow-up messages so active objectives keep moving.
- Shows live elapsed active time and compact/exact token counts in the pi footer.
