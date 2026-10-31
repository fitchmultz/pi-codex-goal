# Development and release checks

[Back to the README](../README.md)

## Local setup

Use Node.js 24 (`.nvmrc`) and the npm version in `packageManager`.

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` type-checks source, tests and all TypeScript probes with TypeScript 7 and runs the Node test suite with native type stripping, including source, Git-production, and packed-artifact loading, tool persistence, and SDK compaction/continuation tests. It also runs an `npm pack` dry run. Run it with an empty HOME/agent profile and a short TMPDIR outside your real home ancestry, with no project markers in its ancestors. The selected host must be installed in this checkout's dependency graph; changing only a CLI on PATH does not select its SDK types. No live model is called.

To load a development checkout in Pi:

```sh
npm install --ignore-scripts
pi install .
```

Install the checkout in only one Pi configuration scope at a time. Different local, npm, or Git sources can try to register the same `get_goal`, `create_goal`, and `update_goal` tools, causing conflicts. For install-path release checks, use an isolated temporary project/config directory or remove the project-local entry immediately afterward.

On this maintainer machine, the active global/user Git package already points at `~/.pi/agent/git/github.com/fitchmultz/pi-codex-goal`. Do not also leave a project-local install in this repository's `.pi/` settings. See [AGENTS.md](../AGENTS.md) for machine-specific install policy and the module map.

## Objective-row UI checks

The below-editor objective row is display-only: it must not create goals, queue model work, or replace the existing footer. Keep multiline objectives on one terminal row, remove control sequences with Pi's `stripTerminalSequences()`, and truncate with `truncateToWidth()` rather than character counts. `test/goal-runtime-status.test.ts` covers OSC/ANSI input, wide characters, resize, themes, non-TUI modes, and goal/session transitions.

Host-supplied runtime imports belong in optional wildcard peers **and** pinned direct development dependencies from the selected host cohort. Update the lockfile and retain the offline production-install test; an optional peer left only as a transitive development dependency can become `devOptional` and pull packages into a production install.

## Compatibility qualification

Pull-request CI runs `check:compat` against the latest stable official Pi and latest maintained fork `main` on Ubuntu/Node 24. Version/commit identities are resolved once per workflow run and retained with exact SDK/CLI evidence. Both hosts are required. Qualification also checks clean Git and npm consumer installs through the native Pi CLI, then packs the pull-request source and runs the delivery-identity, role, and regular, draft-restoration and fullscreen PTY probes against that tarball on both hosts. The compatibility workflow does not call a model.

Run the shared native Git/packed consumer qualification locally:

```sh
git clone https://github.com/fitchmultz/.github.git /tmp/pi-goal-automation
node /tmp/pi-goal-automation/scripts/qualify.mjs --repo pi-codex-goal --source "$PWD" \
  --host official --target latest --output /tmp/pi-goal-evidence
```

The compatibility workflow uses this qualification tool for both Pi hosts. Qualification does not publish, install into live settings, restart active sessions, merge, or tag.

## Cache/compaction regressions

`test/provider-context.test.ts` and `test/native-lifecycle.test.ts` check unchanged provider prefixes across normal continuations and goal transitions. Old sent controls must remain verbatim, not be rewritten or deduplicated to satisfy older tests. `test/goal-compaction.test.ts` checks copy-only filtering, custom summarizer opt-in, and one full saved goal on the first normal metadata-owned custom automatic continuation after successful compaction. User deliveries and custom command start/resume must not consume that refresh.

Native tests also check public custom-message start/resume, exhausted recovery without a manufactured user reset, native queue/editor restoration, same-goal stale generations and pending genuine images, duplicates/reload, and host-normalized image/caption blocks on an owned refresh. All automated sends go through `goal-delivery.ts`; genuine user text has no ownership semantics. Do not reintroduce marker/passthrough matching or private queue/renderer access. The inferred Terminal adapter includes `setProgramStatus` so current and older supported hosts can check it at the same public boundary.

## Delivery ownership and native evidence

The owner [accepted public custom-message automation](delivery-ownership-proposal.md), with two intentional changes: automated follow-ups are not Alt+Up editable and cannot reset exhausted native overflow recovery. The PR's merge hold remains until exact-head independent review and required CI pass; contract approval alone is not implementation approval.

`test/native-lifecycle.test.ts` owns native delivery/normalization/reload/overflow acceptance in the regular suite. In addition, run `scripts/delivery-identity-proof.ts` against the selected exact host graph: its original leading-envelope + real resized-image failure must now pass without changing the input or expected provider count. Run `scripts/delivery-ownership-pty.py` for real regular/fullscreen bubble, queue, draft restoration and resubmission evidence. Both probes assert acceptance, not just process completion. `scripts/delivery-role-proof.ts` independently retains the native custom/user overflow distinction. All probes use offline providers and isolated sessions; none touches the live install. Commands and the evidence manifest are linked in the [accepted contract](delivery-ownership-proposal.md#reproduce-without-changing-the-live-installation).

## Paid compaction smoke

`scripts/compaction-smoke.ts` is an explicit, bounded live check, not part of `npm test`. It requires configured Bedrock models, but no Pi changes. Select an existing installed SDK and its companion graph without replacing the development dependencies:

```sh
PI_SDK_PACKAGE="$(npm root -g)/@earendil-works/pi-coding-agent/package.json" \
node --import ./scripts/host-sdk.ts scripts/compaction-smoke.ts --live \
  --models global.openai.gpt-6-luna,global.anthropic.claude-haiku-5-5 \
  --output /tmp/pi-goal-compaction-smoke
```

The script uses isolated sessions, forces one threshold compaction, checks four written/read-back artifacts, verifies one full goal in the next normal continuation, and asserts unchanged request prefixes between compactions. It lowers the local context limit only to trigger the checkpoint, then restores the model's real capacity so an indivisible retained tool result does not clamp subsequent output. The report includes provider usage and request traces; inspect it, then remove the temporary output directory. It does not modify the live Pi installation or settings.

## Interactive smoke tests

These checks exercise the interactive `/goal` command, hidden continuation, bridged goal tools, filesystem verification, and final `update_goal` completion.

Release-sensitive changes touching slash-command parsing, TUI submission, goal command behavior, hidden continuation, or post-tool completion require real interactive `/goal` evidence before release. Record the command, model, session directory, final assistant evidence, and confirmation that the session JSONL contains the `/goal` command path, file verification, and `update_goal` completion.

Pi must be authenticated to a capable model in your local setup. Start Pi from this repository:

```sh
rm -f /tmp/pi-codex-goal-fast.txt /tmp/pi-codex-goal-slash-smoke.txt
rm -rf /tmp/pi-codex-goal-slash-smoke-session
pi --model <model-id> \
  --session-dir /tmp/pi-codex-goal-slash-smoke-session
```

### Fast manual smoke

For a short confidence check, paste:

```text
/goal Create /tmp/pi-codex-goal-fast.txt containing PI_GOAL_FAST_OK; verify with cat; mark complete; report final status.
```

This intentionally uses shell `cat`; use the full smoke for built-in `read` tool coverage. Expected final evidence:

```text
Verified file path: /tmp/pi-codex-goal-fast.txt
Verified content: PI_GOAL_FAST_OK
Final goal status: complete
```

### Full manual smoke

For the fuller end-to-end path, paste:

```text
/goal Create /tmp/pi-codex-goal-slash-smoke.txt containing PI_GOAL_SLASH_OK, verify the file content from the filesystem, inspect the current goal, and mark the goal complete only after verification. Final reply must include the verified file path, verified content, and final goal status.
```

Expected final evidence:

```text
Verified file path: /tmp/pi-codex-goal-slash-smoke.txt
Verified content: PI_GOAL_SLASH_OK
Final goal status: complete
```

Print mode dispatches `/goal` commands and can change saved goal state. It can exit before a queued goal turn finishes; an aborted active goal becomes paused. Run these smoke tests in interactive Pi. For headless automation, prompt the model to call `create_goal`, `get_goal`, and `update_goal`.

### TUI automation and troubleshooting

For tmux-driven interactive smoke automation, send literal text and submit with CSI-u Enter (`ESC [ 13 u`). Normal `tmux send-keys Enter` works in many setups; CSI-u is the robust scripted submit path through Pi's TUI key parser. This example uses shell `cat`; require the built-in `read` tool in the prompt when testing that path:

```sh
tmux send-keys -t "$TMUX_SESSION" -l '/goal Create /tmp/pi-codex-goal-fast.txt containing PI_GOAL_FAST_OK; verify with cat; mark complete; report final status.'
tmux send-keys -t "$TMUX_SESSION" -l $'\033[13u'
```

If a run appears stuck on `Working...` after a built-in `read` result, capture the session JSONL and TUI pane before retrying. A healthy path includes a `toolName: "read"` tool result, an `update_goal` tool result with `status: "complete"`, and a final assistant message. If only the TUI path stalls, treat it as a Pi host/tool-resume reproduction before changing goal continuation logic.

## Automatic npm releases

The [shared release workflow](https://github.com/fitchmultz/.github#automatic-npm-releases) creates a reviewed patch-version PR after changes merge to `main`, then publishes matching npm and GitHub releases. Compatibility checks and candidate-tarball qualification must pass before publication.

The package release qualification checks the prepared tarball and source identities, rebuilds the two selected host graphs, and matches their CLI, SDK, cohort, companion, lockfile and runtime-graph identities to the candidate receipt. The delivery-identity and role probes and the regular, draft-restoration and fullscreen PTY probes run against that tarball on both hosts. A comparison with the previous published source records whether live interactive evidence is required; an unavailable or incomparable baseline requires it.

When required, `scripts/release-interactive-pty.py` drives the actual interactive Pi TUI with `/goal` and CSI-u Enter on both selected hosts. The calling workflow passes `ZAI_API_KEY` by name; the main-protected `release` environment supplies its value for the direct Z.ai `glm-5.3-flash` model. The retained evidence includes the candidate hash, requested and responding models, command, native session JSONL, file read, `update_goal` completion and final response. This is the interactive smoke path, not print-mode or an offline-provider substitute; non-runtime metadata-only releases do not require a paid model call.

Follow the shared procedure for retries. Set `NPM_RELEASE_ENABLED` to anything other than `true` to stop new version and release plans; cancel pending runs separately when needed. Verify the actual npm and GitHub releases; workflow validation alone is not evidence of a completed OIDC publication.
