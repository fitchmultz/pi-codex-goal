# pi-codex-goal

Give [Pi](https://github.com/earendil-works/pi) a goal to keep working toward across turns and session restarts. This extension tracks the objective, tokens, and active time, and asks the agent to continue until it finishes or needs your attention.

![A task becomes an active Pi goal, which continues across turns, saves its state in session history, and stops when complete, paused, blocked, or out of budget.](.github/readme/goal-workflow.png)

*Set one objective; Pi carries it forward, saves progress in the session, and stops at completion or a goal stop condition.*

## Install and start

Requires **Pi 1.0.0+** (official releases or the maintained fork) and **Node.js 24+**.

```sh
pi install npm:pi-codex-goal
pi
```

In Pi's editor, describe the work you want done:

```text
/create-goal Add CSV export to the reports page, test it, and document how to use it
```

The included `/create-goal` prompt turns your task into an objective with verification steps and asks the agent to create it. It replaces any existing goal, so include all requirements you want to keep. Type `/goal` at any time to see the current objective, status, token usage, budget, and active time.

Already running Pi? Use `/reload` after installation. Prefer a Git checkout or a pinned version? See [installation options](docs/reference.md#installation-options).

## Everyday controls

| Command | What it does |
| --- | --- |
| `/create-goal <task>` | Turn a task into a goal with completion and verification requirements. |
| `/goal <objective>` | Start a goal with your exact wording; confirm before replacing an unfinished goal. |
| `/goal` | Show the current goal and usage. |
| `/goal pause` | Pause an active goal. |
| `/goal resume` | Continue a paused or blocked goal. |
| `/goal resume cancel` | Cancel a scheduled provider-limit retry. |
| `/goal copy` | Copy the objective to the system clipboard. |
| `/goal clear` | Remove the current goal. |

You can also press **Esc** to abort the current assistant turn and pause its active goal. Completed goals stay complete; start a new goal to work again.

## What happens while it runs

- **The agent gets follow-ups.** When it finishes a run with the goal still active, the extension queues a hidden continuation. The prompt asks it to verify the work before marking the goal complete.
- **Progress stays with the session.** Goals use Pi's session history, so they survive resume, reload, fork, tree navigation, and compaction without a separate database. The Pi footer shows goal status and live usage when a UI is available.
- **Stops are visible.** A blocked goal keeps the unfinished objective and the reason it needs help. Resolve the dependency, then use `/goal resume`; ordinary messages and reopening the session do not reactivate it. Paused goals also need an explicit resume, or confirmation when Pi offers it on session resume.
- **Recovery follows Pi.** Pi owns compaction. The extension handles overflow recovery and bounded transient retries, and recognized provider usage limits can schedule an automatic retry. Use `/goal resume cancel` to cancel that retry.

These continuations make additional model calls under your existing Pi setup. New goals are **unlimited by default**. To limit one, ask the agent to create it with an explicit token budget; the default minimum is **500,000 tokens**. When reached, the goal becomes `budgetLimited` and automatic continuation stops.

Goal tokens count active-goal assistant input plus output. Cache accounting, compaction, branch summaries, and nested-tool costs are excluded, so this counter does not measure your total provider bill. See [budgets and accounting](docs/reference.md#model-tools) for configuration and exact rules.

## Tools and automation

The extension gives the agent three tools:

| Tool | Purpose |
| --- | --- |
| `create_goal` | Set an objective with an optional token budget. |
| `get_goal` | Inspect status and usage. |
| `update_goal` | Mark verified work complete, or mark it blocked with a reason. |

For headless runs, ask the model to use these tools. `/goal` is an interactive editor command; `pi -p '/goal …'` does not exercise that command. See the [tool and runtime reference](docs/reference.md) for replacement rules, budget policy, recovery, and MCP tool names.

## More

- [Reference](docs/reference.md): installation choices, model tools, budgets, and runtime behavior.
- [Development](docs/development.md): local checks, compatibility qualification, interactive smoke tests, and release procedure.
- [Changelog](CHANGELOG.md): version history.
- [Issues](https://github.com/fitchmultz/pi-codex-goal/issues): report a problem or suggest an improvement.

## Credits and license

The goal-writing template follows OpenAI's [Codex follow-goals guide](https://developers.openai.com/codex/use-cases/follow-goals) and [Using goals in Codex cookbook](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex).

Created by [Mitch Fultz](https://github.com/fitchmultz). Licensed under [MIT](LICENSE).
