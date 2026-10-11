# pi-codex-goal

pi-codex-goal adds a persistent goal to [Pi](https://github.com/earendil-works/pi). The extension prompts Pi to continue an active goal across turns.

![Goal flow: create a task, work in Pi, save session state, and stop at completion, pause, a blocker, or a token limit.](.github/readme/goal-workflow.png)

*Completion, pause, a blocker, or a token limit stops automatic continuation.*

## Install and start

Use Pi 1.0.0 or later and Node.js 24 or later. The extension supports official Pi releases and the [fitchmultz Pi fork](https://github.com/fitchmultz/pi).

```sh
pi install npm:pi-codex-goal
pi
```

Run `/reload` if Pi is already open. Enter a task in the Pi editor:

```text
/create-goal Add CSV export to the reports page. Test the export. Document its use.
```

`/create-goal` expands your task into an objective with completion checks. The new goal replaces the old one. Include every requirement you want to keep.

## Goal controls

| Command | Action |
| --- | --- |
| `/goal` | Show the objective, status, token budget, usage, and active time. |
| `/goal <objective>` | Set the exact objective. Confirm replacement of an unfinished goal. |
| `/goal pause` | Pause the active goal. |
| `/goal resume` | Continue a paused or blocked goal. |
| `/goal resume cancel` | Cancel a scheduled provider-limit retry. |
| `/goal copy` | Copy the objective to the system clipboard. |
| `/goal clear` | Remove the current goal. |

Press Esc to stop the current assistant turn and pause its active goal.

A blocked goal needs input or external work. Run `/goal` to read the reason. Resolve the dependency. Run `/goal resume`.

Completed goals stay complete. Create a new goal for more work.

## Limits and cost

Active goals cause extra model calls. Use `/goal pause` to stop automatic continuation.

New goals have no token limit. Ask the agent to set `token_budget` through `create_goal` to limit a goal. The default minimum is 500,000 tokens. The goal stops automatic continuation when it reaches the budget.

Goal tokens count assistant input and output. This count excludes provider cache accounting and host maintenance costs. It does not show total provider charges.

## Sessions and recovery

The goal survives resume, reload, fork, tree navigation, and compaction. The Pi footer shows goal status and usage when a UI is available.

Pi controls compaction. The extension uses bounded retries for transient provider errors. Recognized provider usage limits can schedule an automatic retry.

## Headless use

Ask the agent to use `create_goal`, `get_goal`, and `update_goal` for headless runs.

`pi -p '/goal …'` runs the command and can change saved goals. Print mode can exit before the goal turn finishes and leave the goal paused.

## Details

Read the [reference](docs/reference.md) for installation options, budget policy, tools, and recovery.

Read the [development guide](docs/development.md) for checks, compatibility qualification, smoke tests, and releases.

See the [changelog](CHANGELOG.md) for version history. Report problems in [Issues](https://github.com/fitchmultz/pi-codex-goal/issues).

## License

[Mitch Fultz](https://github.com/fitchmultz) publishes this project under the [MIT license](LICENSE).
