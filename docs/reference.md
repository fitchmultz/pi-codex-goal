# Goal reference

[Back to the README](../README.md)

## Installation options

Requires Pi 1.0.0 or later (official releases and the [fitchmultz Pi fork](https://github.com/fitchmultz/pi)) and Node.js 24 or later.

```sh
# Latest npm release
pi install npm:pi-codex-goal

# Current GitHub default branch
pi install https://github.com/fitchmultz/pi-codex-goal
```

The GitHub default branch can include unreleased changes even when `package.json` still identifies the latest published version.

npm, Git, and local directory installs all load the TypeScript source (`extensions/index.ts` and `src/`) through Pi's extension loader. There is no build step or production TypeScript dependency. See [development setup](development.md#local-setup) for local checkouts and duplicate-install precautions.

## User commands

The [README command table](../README.md#goal-controls) covers the usual controls.

`/create-goal <task>` expands the task into an objective covering outcome, verification, constraints, iteration, a completion audit, and a blocked-stop condition. It asks the model to call `create_goal` with explicit replacement enabled, so you do not need to run `/goal clear` before setting a new goal.

The template follows the goal-writing practices in OpenAI's [Codex follow-goals guide](https://developers.openai.com/codex/use-cases/follow-goals) and [Using goals in Codex cookbook](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex).

`/goal` with no arguments reports the current objective, status, token budget, token usage, and elapsed active time. A plain `/goal <objective>` starts a new unlimited goal or replaces the current one after confirmation. `/goal copy` copies the objective for active, paused, blocked, waiting, budget-limited, and completed goals.

Objectives are limited to 8000 Unicode characters. Token budgets are set through the model tool; `/goal --tokens` is not a budget option.

## Model tools

### `create_goal`

Starts a goal with an `objective` and an optional `token_budget`. It fails if a non-complete goal already exists unless `replace_existing: true` is provided. After a goal is complete, `create_goal` replaces it with a new active goal.

Omit `token_budget` for an unlimited goal. By default, new explicit budgets must be safe integers of at least 500,000 tokens, including replacements. Smaller budgets are rejected rather than raised automatically. Existing saved goals retain their original budgets and usage.

Set `PI_CODEX_GOAL_TOKEN_BUDGET_POLICY` before starting Pi to choose a different minimum or reject all explicit budgets:

```sh
PI_CODEX_GOAL_TOKEN_BUDGET_POLICY=100000000 pi
PI_CODEX_GOAL_TOKEN_BUDGET_POLICY=disabled pi
```

A positive safe integer sets the minimum, including values below the default. `disabled` permits only omitted budgets. The exposed tool schema and execution boundary enforce the same policy, including replacement calls. Invalid or empty settings fail extension loading. The setting is read at extension load; restart Pi or `/reload` after changing its environment. This policy does not change saved goals, and `/goal <objective>` still creates unlimited goals.

### `get_goal`

Returns the current goal state and usage.

### `update_goal`

Accepts `status: "complete"` after verified completion, `status: "waiting"` with a non-empty `reason` naming background work that will deliver its own result message, or `status: "blocked"` with a non-empty `reason` when missing user input or external work without a self-delivered result prevents meaningful progress.

Waiting preserves the unfinished objective, `waitingReason`, and usage through reload, fork, and compaction. Like blocking, it cancels automatic continuations and provider auto-resume without interrupting a running tool; it accrues no active time while waiting. Use it only when no other actionable work remains and a named job/subagent/process will send its own message. Do not poll or sleep for that work. `/goal` and the footer show the reason. The next genuine user input, steering message, or other extension's result automatically reactivates the goal before the response is accounted, so the result turn can finish it. Goal-queued bookkeeping, compaction, and session reopening do not reactivate it. `/goal resume` explicitly reactivates it; `/goal pause` disables automatic reactivation. If no result arrives, it stays idle until new input. Reached budgets still prevent reactivation.

Blocking preserves the unfinished objective, reason, and usage through reload, fork, and compaction. It cancels automatic continuations and provider auto-resume, and does not interrupt an already-running tool. Use `/goal` to inspect the dependency and explicit `/goal resume` to reactivate the goal. Ordinary input or reopening the session cannot resume it, and completion is rejected while blocked. Reaching the token budget still stops the goal rather than allowing blocking to bypass the limit.

Calling `update_goal` on an already-complete goal is idempotent and does not append duplicate session entries. The extension accounts the assistant response calling a status change before persisting it; completion reports final token and elapsed-time usage.

Completed goals are terminal for automatic transitions: pause, resume, and hidden continuations do not reopen them. To recover from premature completion, use `/goal <objective>` to replace the goal, call `create_goal` with `replace_existing: true`, or `/goal clear` before starting again.

### MCP tool names

In bridged MCP environments, Pi may expose these tools under namespaced names such as `pi__get_goal`, `pi__create_goal`, and `pi__update_goal`. Prompt guidance tells models to call whichever goal-tool name is actually exposed in the current run, rather than display or transcript labels.

## Behavior

While a goal is active, the extension:

- Tracks elapsed active time between turns and tool completions.
- Adds completed assistant turn input plus output token usage when the active model reports it.
- Coalesces runtime goal custom-entry writes so unchanged status and usage are not appended on every tool completion. Live footer usage stays current, and meaningful usage is flushed at turn boundaries, shutdown, compaction, budget crossings, and bounded intervals during long tool-heavy runs.
- Leaves threshold and overflow compaction decisions to Pi. The user's effective compaction settings remain authoritative while goal accounting and continuation follow host compaction events.
- Pauses when an active assistant turn is aborted, such as when you press Esc.
- Recovers from provider assistant errors without immediate hidden continuation loops. Context-window overflow triggers automatic compaction and then resumes the active goal; transient errors use bounded backoff retries; recognized provider usage-limit pauses schedule a conservative auto-resume retry. Use `/goal resume cancel` to stop the scheduled retry.
- Prompts on session resume before reactivating a paused goal when a UI is available, and supports explicit `/goal resume`.
- Pauses a hidden continuation that only inspects goal status with `get_goal` without doing actionable work.
- Rejects `/goal pause` unless the goal is active or waiting and rejects `/goal resume` unless the goal is paused, blocked, or waiting. An exception is an active goal waiting for a user-start recovery turn after host overflow recovery: `/goal resume` sends the required user follow-up without changing goal status.
- Treats completed goals as terminal for automatic transitions while allowing `/goal <objective>` and explicit `create_goal` replacement to replace goals.
- Marks the goal `budgetLimited` when a positive token budget is reached.
- Sends hidden steering messages when budget is reached or when the agent is idle but the goal is still active.
- Compacts repeated hidden goal continuations before provider context so only the latest active continuation stays runnable. Older ones become short bookkeeping markers, and auto-queued continuations use a compact prompt after `/goal` start or resume.
- Shows Codex-style status labels with compact token or elapsed-time usage in the Pi footer when a UI is available. The terminal UI also shows the current unfinished objective in a separate single-line widget below the editor. Paused, blocked, waiting, and budget-limited goals retain an explicit state label; completed or cleared goals hide the widget. Terminal control sequences are removed, whitespace is condensed, and long text is truncated to the available display width. Use `/goal` for the full objective.

Token counts use commas and compact abbreviations, for example `123M (123,456,789) tokens`. Goal totals count only completed assistant-turn `input` plus `output` while the goal is active. Cache read/write channels are excluded because they are provider cache accounting fields rather than extra sent and received text tokens. Pi 0.81+ also folds tool, compaction, and branch-summary usage into host session totals/footer stats. Those host maintenance and nested-tool costs stay out of goal budgets, so goal tokens measure assistant turn work toward the objective rather than whole-session spend.

## Durable recovery and accounting

Native custom entries remain the source of truth across resume, tree/fork, reload, and compaction. Existing goal formats and historical saved budgets are retained without migration or journal rewriting. Paused headless goals require explicit `/goal resume`; blocked goals remain blocked until explicitly resumed. Waiting goals remain idle across session reopening and reactivate only on new non-goal input or explicit resume. Shutdown persists pending recovery before disposal. Neither supported 1.0 target provides the old fork checkpoint/accounting APIs; legacy session goal entries still recover normally.

Turn accounting consumes the current native response once, including a status-changing tool's calling response. Native `ctx.executeTool()` child calls are correlated to their calling response, and repeated tool-call IDs are correlated to the latest response rather than older entries. Multiple children do not charge that response again; the completion receipt is not goal work. Accounting uses persisted `turn_end` messages rather than reading the not-yet-appended `message_end`, and does not assume boundary drafts are committed inside handlers.

## Compatibility contract

The extension uses the shared public Pi 1.0 extension API. Pi-bundled runtime packages remain optional wildcard peers supplied by the host. Locked development dependencies are reproducible snapshots rather than validation targets. Qualification selects the latest stable official Pi cohort and the latest maintained fork's actual graph, including host-supplied TypeBox; a development update does not change the host's bundled dependencies.

Per-loop `agent_end` drives guarded goal continuation; it is not final completion. Native `waitForIdle`/`agent_settled` includes queued goal work, tool receipts, and host compaction/retry. No checkpoint, `recordUsage`, metadata/revision, or extra fork RPC/TUI API is required. Each run qualifies the maintained fork's exact current revision; historical coverage does not certify a new host.
