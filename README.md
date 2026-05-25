# pi-codex-goal

Codex-style goal tracking for pi.

This package adds a `/goal` command plus three model-callable tools:

- `get_goal`
- `create_goal`
- `update_goal`

Goal state is stored in pi session custom entries, so it follows session history, resume, fork, tree navigation, reload, and compaction behavior without an external database.

## Install

Install from npm:

```sh
pi install npm:pi-codex-goal
```

Install a pinned npm version:

```sh
pi install npm:pi-codex-goal@0.1.11
```

Install from GitHub:

```sh
pi install https://github.com/fitchmultz/pi-codex-goal
```

Install a pinned GitHub release:

```sh
pi install https://github.com/fitchmultz/pi-codex-goal@v0.1.11
```

For local development from this repository:

```sh
npm install
pi install .
```

## User Commands

```text
/goal
/goal Build the requested feature and verify it end to end
/goal pause
/goal resume
/goal clear
```

`/goal` with no arguments reports the current objective, status, token budget, token usage, and elapsed active time. A plain `/goal <objective>` starts a new goal or replaces the current one after confirmation.

This intentionally matches Codex TUI behavior: token budgets are set through the model tool rather than parsed from `/goal --tokens`. This package keeps its objective size limit at 8000 Unicode characters.

## Model Tools

`create_goal` starts a goal with an objective and optional positive token budget. It fails if a non-complete goal already exists. After a goal is complete, `create_goal` replaces it with a new active goal.

`get_goal` returns the current goal state and usage.

`update_goal` only accepts `status: "complete"`, matching Codex's model-side contract. Calling it on an already-complete goal is idempotent and does not append duplicate session entries. The extension reports final token and elapsed-time usage before marking the goal complete.

Completed goals are terminal for automatic transitions: pause, resume, and hidden continuations do not reopen them. To recover from premature completion, use `/goal <objective>` to replace the goal or `/goal clear` before starting again.

In bridged MCP environments such as `pi-cursor-sdk`, pi may expose these tools under namespaced MCP names like `pi__get_goal`, `pi__create_goal`, and `pi__update_goal`. Prompt guidance tells models to call whichever goal-tool name is actually exposed in the current run, not display or transcript labels.

## Behavior

While a goal is active, the extension:

- tracks elapsed active time between turns and tool completions
- adds completed assistant turn input plus output token usage when the active model reports it
- pauses when an active assistant turn is aborted, such as when you press Esc
- recovers from provider assistant errors without immediate hidden continuation loops: context-window overflow triggers automatic compaction and then resumes the active goal, transient errors use bounded backoff retries, and repeated unrecoverable failures pause with a clear `/goal resume` path
- prompts on session resume before reactivating a paused goal, and resumes explicitly with `/goal resume` (only from paused)
- rejects `/goal pause` unless the goal is active and `/goal resume` unless the goal is paused
- treats completed goals as terminal for automatic transitions while allowing `/goal <objective>` to replace them without extra friction
- marks the goal `budgetLimited` when a positive token budget is reached
- sends hidden steering messages when budget is reached or when the agent is idle but the goal is still active
- compacts repeated hidden goal continuations before provider context so only the latest active continuation stays runnable, older ones become short bookkeeping markers, and auto-queued continuations use a compact prompt after `/goal` start or resume
- shows Codex-style status labels with compact token or elapsed-time usage in the pi footer when UI is available

Token counts are formatted with commas and compact abbreviations, for example `123M (123,456,789) tokens`. Token totals use pi's completed assistant turn input plus output usage. Cache read and cache write channels are excluded because they are provider cache accounting fields, not extra sent and received text tokens. Pi does not currently expose a separate extension usage total for automatic compaction summary calls.
