# pi-codex-goal — agent notes

Pi extension: Codex-style `/goal` command and `get_goal` / `create_goal` / `update_goal` tools. State lives in pi session custom entries.

## Local pi install policy

On this machine, the canonical active install is the global/user Git package `git:github.com/fitchmultz/pi-codex-goal`, checked out at:

```text
~/.pi/agent/git/github.com/fitchmultz/pi-codex-goal
```

Do not leave project-local installs of this package in this repo. In particular, avoid release verification commands such as:

```sh
pi install -l npm:pi-codex-goal
pi install -l https://github.com/fitchmultz/pi-codex-goal@vX.Y.Z
```

Those write duplicate package entries under `.pi/` for the current project, causing `get_goal`, `create_goal`, and `update_goal` tool-registration conflicts with the global local-checkout install. For install-path release verification, use an isolated temp project/config directory or remove the project-local entries immediately after the check. Pass `--approve` for isolated project-local package install/list/non-interactive smoke commands when those commands must load `.pi/settings.json`. If conflicts appear, inspect `pi list --approve` and `.pi/settings.json`, then remove any project-local `pi-codex-goal` npm/GitHub installs so only the global local-checkout package remains active.

## Verify before finishing

```sh
npm run check
```

Runs the full Node test suite (`test/*.test.ts`, via Node's native type stripping), `tsc`, and an `npm pack` dry run. Relative imports use `.ts`; there is no build step, and the npm artifact ships `extensions/` and `src/` as TypeScript.

## Pi 1.0 contracts

Official Pi 1.0.0 is the exact development baseline and intended floor. Development TypeBox is 1.3.34; the Pi 1.0.0 host still supplies TypeBox 1.3.27. Check both graphs rather than inferring runtime compatibility from a development bump. Preserve native custom-entry recovery, per-loop guarded continuation and final settlement; do not replace `agent_end` with notification-only `agent_settled`. Use native finalized events/tool correlation for exact-once usage and never assume `message_end` or boundary drafts have already appended. No removed fork checkpoint, recordUsage or metadata/revision API is a supported requirement. Rerun host-sensitive native suites/packed CLI qualification against the final fork 1.0 artifact when available.

Historical release channels are owned npm `pi-codex-goal` plus GitHub releases; proposed new version 0.6.0. Parent controls independent review/merge/release; no live activation.

## Layout

| Area | Modules |
|------|---------|
| Wiring | `src/index.ts`, `goal-runtime-controller.ts` |
| User / model API | `commands.ts`, `tools.ts`, `prompts.ts`, `format.ts`, `clipboard.ts`, `prompts/create-goal.md` |
| Runtime events | `goal-runtime-event-handlers.ts`, `goal-runtime-*-handlers.ts` |
| Transitions | `goal-transition.ts`, `goal-transition-effects.ts`, `goal-state-controller.ts` |
| Stale continuations | `stale-queued-work-*.ts` |
| Recovery | `recovery*.ts` |
| Domain | `state.ts`, `types.ts`, `goal-persistence.ts` |
