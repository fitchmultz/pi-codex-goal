# pi-codex-goal

Codex-style goal tracking for pi.

This package adds a `/goal` command plus three model-callable tools:

- `get_goal`
- `create_goal`
- `update_goal`

Goal state is stored in pi session custom entries, so it follows session history, resume, fork, tree navigation, reload, and compaction behavior without an external database.

## Install

Requires Pi 0.84.0 or later.

Install from npm:

```sh
pi install npm:pi-codex-goal
```

Install a pinned npm version:

```sh
pi install npm:pi-codex-goal@<version>
```

Install from GitHub:

```sh
pi install https://github.com/fitchmultz/pi-codex-goal
```

Install a pinned GitHub release:

```sh
pi install https://github.com/fitchmultz/pi-codex-goal@v<version>
```

For local development from this repository, install the checkout only in one Pi config scope at a time:

```sh
npm install
pi install .
```

On this maintainer machine, the active install is a global/user package that already points at this checkout; do not also leave a project-local install under this repository's `.pi/` settings. Duplicate local and global installs both try to register `get_goal`, `create_goal`, and `update_goal`, which causes tool-registration conflicts. For install-path release checks, use an isolated temp project/config directory or remove the project-local entry immediately after the check.

Compatibility note: this package supports Pi 0.84.0 or later on Node 24. The latest published npm artifact remains the reproducible source of truth for its own published version's metadata. Pi-bundled runtime packages remain optional wildcard peers as required by Pi package loading; the support floor is declared here and validated by the source tree's exact Pi 0.84.0 development dependencies.

Release note: npm installs and pinned GitHub tags are the reproducible release artifacts. Installing from the repository default branch can include unreleased changes that will ship in a future package release, even when `package.json` still identifies the latest published version.

## Best way to create goals

Use the included `/create-goal` prompt template instead of writing a goal by hand. Agents write better goal completion contracts than humans do because they can expand a plain task into outcome, verification, constraints, iteration, audit, and blocked-stop requirements before calling the `create_goal` tool.

```text
/create-goal insert task and requirements here
```

The template follows the Codex goal-writing practices from:

- <https://developers.openai.com/codex/use-cases/follow-goals>
- <https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex>

## Development

Validate types and tests before committing or opening a PR:

```sh
npm run verify
```

GitHub Actions runs this same ordinary hosted CI gate on Node 24 for `push` and `pull_request`. It does not run the Crabbox platform matrix.

Cross-platform release-sensitive changes should also pass the local Crabbox platform smoke gate:

```sh
npm run check:platform-smoke
npm run smoke:platform:all
```

`smoke:platform:all` runs the doctor before any target suite.

That local gate runs `npm run verify`, packs the package, installs the packed package into a clean pi project, checks `pi list`, and runs a real model-backed goal-tool smoke on macOS, Ubuntu Linux, and native Windows. Pi 0.84.0-or-later project trust is handled explicitly with `--approve` inside the isolated smoke projects so project-local package settings and the packed extension load in non-interactive runs. The runtime smoke defaults to `zai/glm-5.2`; override it with `PLATFORM_SMOKE_MODEL` and configure forwarded auth env vars with `PLATFORM_SMOKE_AUTH_ENV`. Setup and artifact details: [docs/platform-smoke.md](docs/platform-smoke.md).

Project agent notes and module map: [AGENTS.md](AGENTS.md).
Historical 0.1.33 structural audit and remediation record: [docs/CODEBASE_AUDIT.md](docs/CODEBASE_AUDIT.md).

## Interactive smoke tests

These smoke tests exercise the interactive `/goal` command, hidden continuation, bridged goal tools, filesystem verification, and final `update_goal` completion.

Release-sensitive changes that touch slash-command parsing, TUI submission, goal command behavior, hidden continuation, or post-tool completion must record manual interactive `/goal` evidence before release. The model-backed platform smoke covers goal tools through non-interactive `pi -p`; it intentionally does not prove the real TUI slash-command submit path. Required evidence is: command used, model, session directory, final assistant evidence, and confirmation that the session JSONL contains the `/goal` command path, file verification, and `update_goal` completion.

Prerequisites:

- Pi can authenticate to any capable model available in your local setup.

Start pi from this repository:

```sh
rm -f /tmp/pi-codex-goal-fast.txt /tmp/pi-codex-goal-slash-smoke.txt
rm -rf /tmp/pi-codex-goal-slash-smoke-session
pi --model <model-id> \
  --session-dir /tmp/pi-codex-goal-slash-smoke-session
```

### Fast manual smoke

Paste this first when you want the shortest interactive confidence check. This intentionally uses shell `cat`; use the full smoke or platform smoke when you need built-in `read` tool coverage:

```text
/goal Create /tmp/pi-codex-goal-fast.txt containing PI_GOAL_FAST_OK; verify with cat; mark complete; report final status.
```

Expected final evidence:

```text
Verified file path: /tmp/pi-codex-goal-fast.txt
Verified content: PI_GOAL_FAST_OK
Final goal status: complete
```

### Full manual smoke

Paste this when you want the fuller end-to-end path:

```text
/goal Create /tmp/pi-codex-goal-slash-smoke.txt containing PI_GOAL_SLASH_OK, verify the file content from the filesystem, inspect the current goal, and mark the goal complete only after verification. Final reply must include the verified file path, verified content, and final goal status.
```

Expected final evidence:

```text
Verified file path: /tmp/pi-codex-goal-slash-smoke.txt
Verified content: PI_GOAL_SLASH_OK
Final goal status: complete
```

`/goal` is an interactive editor command. Do not use `pi -p '/goal ...'` as a slash-command smoke path; print mode sends an initial model prompt and is not a reliable way to exercise this extension command. For headless automation, prompt the model to call the `create_goal`, `get_goal`, and `update_goal` tools instead of relying on slash-command parsing.

For tmux-driven interactive smoke automation, send the prompt as literal text and submit with CSI-u Enter (`ESC [ 13 u`). Normal `tmux send-keys Enter` works in many setups, but CSI-u is the robust scripted submit path through Pi's TUI key parser. This fast example intentionally uses shell `cat`; change the prompt to require the built-in `read` tool when that path is under test:

```sh
tmux send-keys -t "$TMUX_SESSION" -l '/goal Create /tmp/pi-codex-goal-fast.txt containing PI_GOAL_FAST_OK; verify with cat; mark complete; report final status.'
tmux send-keys -t "$TMUX_SESSION" -l $'\033[13u'
```

If an interactive run appears stuck on `Working...` after a built-in `read` tool result, capture the session JSONL and TUI pane before retrying. A healthy read-verification path includes a `toolName: "read"` tool result, an `update_goal` tool result with `status: "complete"`, and a final assistant message. The package's model-backed platform smoke now asserts that the built-in `read` tool was used; if only the TUI path stalls, treat it as a Pi host/tool-resume repro rather than changing goal continuation logic without more evidence.

## User Commands

```text
/create-goal Build the requested feature and verify it end to end
/goal
/goal Build the requested feature and verify it end to end
/goal pause
/goal resume
/goal resume cancel
/goal copy
/goal clear
```

`/create-goal <task>` is the recommended way to start a goal. It expands the task into a strict objective and asks the model to call the `create_goal` tool with explicit replacement enabled, so you do not need to run `/goal clear` before setting a new goal.

`/goal` with no arguments reports the current objective, status, token budget, token usage, and elapsed active time. A plain `/goal <objective>` starts a new goal or replaces the current one after confirmation. `/goal copy` copies the current goal objective to the system clipboard, including active, paused, budget-limited, and completed goals.

This intentionally matches Codex TUI behavior: token budgets are set through the model tool rather than parsed from `/goal --tokens`. This package keeps its objective size limit at 8000 Unicode characters.

## Model Tools

`create_goal` starts a goal with an objective and optional positive token budget. It fails if a non-complete goal already exists unless `replace_existing: true` is provided. After a goal is complete, `create_goal` replaces it with a new active goal.

`get_goal` returns the current goal state and usage.

`update_goal` only accepts `status: "complete"`, matching Codex's model-side contract. Calling it on an already-complete goal is idempotent and does not append duplicate session entries. The extension reports final token and elapsed-time usage before marking the goal complete.

Completed goals are terminal for automatic transitions: pause, resume, and hidden continuations do not reopen them. To recover from premature completion, use `/goal <objective>` to replace the goal, call `create_goal` with `replace_existing: true`, or `/goal clear` before starting again.

In bridged MCP environments, pi may expose these tools under namespaced MCP names like `pi__get_goal`, `pi__create_goal`, and `pi__update_goal`. Prompt guidance tells models to call whichever goal-tool name is actually exposed in the current run, not display or transcript labels.

## Behavior

While a goal is active, the extension:

- tracks elapsed active time between turns and tool completions
- adds completed assistant turn input plus output token usage when the active model reports it
- coalesces runtime goal custom-entry writes so unchanged status and usage are not appended on every tool completion; live footer usage stays current, and meaningful usage is flushed at turn boundaries, shutdown, compaction, budget crossings, and bounded intervals during long tool-heavy runs
- leaves threshold and overflow compaction decisions to pi, so the user's effective pi compaction settings remain authoritative while goal accounting and continuation follow host compaction events
- pauses when an active assistant turn is aborted, such as when you press Esc
- recovers from provider assistant errors without immediate hidden continuation loops: context-window overflow triggers automatic compaction and then resumes the active goal, transient errors use bounded backoff retries, and recognized provider usage-limit pauses schedule a conservative auto-resume retry; use `/goal resume cancel` to stop the scheduled retry
- prompts on session resume before reactivating a paused goal, and resumes explicitly with `/goal resume` from paused goals
- rejects `/goal pause` unless the goal is active and rejects `/goal resume` unless the goal is paused, except when an active goal is waiting for a user-start recovery turn after host overflow recovery; in that recovery state, `/goal resume` sends the required user follow-up instead of changing goal status
- treats completed goals as terminal for automatic transitions while allowing `/goal <objective>` and explicit `create_goal` replacement to replace goals without extra friction
- marks the goal `budgetLimited` when a positive token budget is reached
- sends hidden steering messages when budget is reached or when the agent is idle but the goal is still active
- compacts repeated hidden goal continuations before provider context so only the latest active continuation stays runnable, older ones become short bookkeeping markers, and auto-queued continuations use a compact prompt after `/goal` start or resume
- shows Codex-style status labels with compact token or elapsed-time usage in the pi footer when UI is available

Token counts are formatted with commas and compact abbreviations, for example `123M (123,456,789) tokens`. Goal token totals intentionally count only completed assistant-turn `input` plus `output` while the goal is active. That is a goal-scoped progress budget, not a copy of pi session billables. Cache read/write channels are excluded because they are provider cache accounting fields, not extra sent and received text tokens. Pi 0.81+ also folds tool, compaction, and branch-summary usage into host session totals/footer stats; those host maintenance and nested-tool costs stay out of goal budgets so a token budget still measures agent turn work toward the objective rather than whole-session spend.
