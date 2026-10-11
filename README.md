# pi-codex-goal

Keep [Pi](https://github.com/earendil-works/pi) working on a task across turns. pi-codex-goal saves the objective in your session and sends follow-up prompts while the goal is active.

![A task becomes an active Pi goal, which continues across turns, saves its state in session history, and stops when complete, paused, blocked, or out of budget.](.github/readme/goal-workflow.png)

*The goal stays with your session; completion, a pause, a blocker, or a token limit stops the follow-ups.*

## Install and start

You'll need Pi 1.0.0 or later (official releases or the maintained fork) and Node.js 24 or later.

```sh
pi install npm:pi-codex-goal
pi
```

In Pi's editor, describe the work you want done:

```text
/create-goal Add CSV export to the reports page, test it, and document how to use it
```

`/create-goal` asks the agent to turn your task into an objective with checks for completion, then create the goal. It replaces any existing goal, so include all requirements you want to keep.

If Pi is already running, use `/reload` after installation. [Installation options](docs/reference.md#installation-options) covers Git checkouts and pinned versions.

## Control the goal

| Command | What it does |
| --- | --- |
| `/create-goal <task>` | Turn a task into a goal with completion checks. |
| `/goal <objective>` | Start a goal using your wording; confirm before replacing an unfinished goal. |
| `/goal` | Show the objective, status, token budget, usage, and active time. |
| `/goal pause` | Pause an active goal. |
| `/goal resume` | Continue a paused or blocked goal. |
| `/goal resume cancel` | Cancel a scheduled provider-limit retry. |
| `/goal copy` | Copy the objective to the system clipboard. |
| `/goal clear` | Remove the current goal. |

Pressing Esc aborts the current assistant turn and pauses its active goal. When you're ready to continue, use `/goal resume`. Pi can also offer to resume a paused goal when you reopen the session.

If the agent needs input or external work before it can continue, it can mark the goal blocked and record the reason. Use `/goal` to see what's missing. Resolve it, then run `/goal resume`; sending an ordinary message won't unblock the goal.

## While Pi works

When a run ends with the goal still active, the extension queues a hidden follow-up. The agent is asked to verify the work before marking the goal complete. Completed goals stay complete; start a new one to work again.

The objective and usage live in Pi's session history. They survive reload, resume, fork, tree navigation, and compaction. You can check progress with `/goal` or watch the status in Pi's footer.

Pi handles compaction. The extension follows its recovery events and retries transient provider errors with bounded backoff. Recognized provider usage limits can schedule an automatic retry; `/goal resume cancel` cancels it. The [runtime reference](docs/reference.md#behavior) covers the recovery details.

## Tokens and cost

Leaving a goal running makes more model calls under your existing Pi setup. New goals have no token limit by default. To set one, ask the agent to use `create_goal` with an explicit token budget. The default minimum is 500,000 tokens. Reaching the limit sets the status to `budgetLimited` and stops automatic continuation.

Goal tokens count assistant input and output while the goal is active. Cache accounting and host maintenance costs are excluded, so this isn't a measure of your total provider bill. See [budget policy and accounting](docs/reference.md#model-tools) for the exact rules and configuration.

## Headless use

Ask the model to use `create_goal`, `get_goal`, and `update_goal` to create, inspect, and complete or block a goal. `/goal` is an interactive editor command; `pi -p '/goal …'` doesn't exercise it. The [tool reference](docs/reference.md#model-tools) includes replacement rules and MCP tool names.

## More

See the [reference](docs/reference.md) for options and runtime details, or the [development guide](docs/development.md) for local checks, compatibility qualification, smoke tests, and releases. Version history is in the [changelog](CHANGELOG.md). Report problems in [Issues](https://github.com/fitchmultz/pi-codex-goal/issues).

## License

Created by [Mitch Fultz](https://github.com/fitchmultz). Licensed under [MIT](LICENSE).
