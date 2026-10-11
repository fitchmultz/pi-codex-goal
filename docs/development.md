# Development and release checks

[Back to the README](../README.md)

## Local setup

Use Node.js 24 (`.nvmrc`) and the npm version in `packageManager`.

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` type-checks with TypeScript 7 and runs the Node test suite with native type stripping, including source, Git-production, and packed-artifact loading, tool persistence, and SDK compaction/continuation tests. It also runs an `npm pack` dry run. Run it with an empty HOME/agent profile and a short TMPDIR outside your real home ancestry, with no project markers in its ancestors. The selected host must be installed in this checkout's dependency graph; changing only a CLI on PATH does not select its SDK types. No live model is called.

To load a development checkout in Pi:

```sh
npm install --ignore-scripts
pi install .
```

Install the checkout in only one Pi configuration scope at a time. Different local, npm, or Git sources can try to register the same `get_goal`, `create_goal`, and `update_goal` tools, causing conflicts. For install-path release checks, use an isolated temporary project/config directory or remove the project-local entry immediately afterward.

On this maintainer machine, the active global/user Git package already points at `~/.pi/agent/git/github.com/fitchmultz/pi-codex-goal`. Do not also leave a project-local install in this repository's `.pi/` settings. See [AGENTS.md](../AGENTS.md) for machine-specific install policy and the module map.

## Compatibility qualification

Pull-request CI runs `check:compat` against the latest stable official Pi and latest maintained fork `main` on Ubuntu/Node 24. Version/commit identities are resolved once per workflow run and retained with exact SDK/CLI evidence. Both hosts are required. Qualification also checks clean Git and npm consumer installs through the native Pi CLI. Hosted CI does not call a model.

Run the shared native Git/packed consumer qualification locally:

```sh
git clone https://github.com/fitchmultz/.github.git /tmp/pi-goal-automation
git -C /tmp/pi-goal-automation checkout 9b08d65d70a01c74c4e01477ccf9473e86be33ee
node /tmp/pi-goal-automation/scripts/qualify.mjs --repo pi-codex-goal --source "$PWD" \
  --host official --target latest --output /tmp/pi-goal-evidence
```

The helper revision above matches `.github/workflows/pi-compatibility.yml`; update them together when qualification changes. Qualification does not publish, install into live settings, restart active sessions, merge, or tag.

## Interactive smoke tests

These checks exercise the interactive `/goal` command, hidden continuation, bridged goal tools, filesystem verification, and final `update_goal` completion.

Release-sensitive changes touching slash-command parsing, TUI submission, goal command behavior, hidden continuation, or post-tool completion require manual interactive `/goal` evidence before release. Record the command, model, session directory, final assistant evidence, and confirmation that the session JSONL contains the `/goal` command path, file verification, and `update_goal` completion.

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

`/goal` is an interactive editor command. Do not use `pi -p '/goal ...'` as a slash-command smoke path; print mode sends an initial model prompt and does not reliably exercise this extension command. For headless automation, prompt the model to call `create_goal`, `get_goal`, and `update_goal` instead.

### TUI automation and troubleshooting

For tmux-driven interactive smoke automation, send literal text and submit with CSI-u Enter (`ESC [ 13 u`). Normal `tmux send-keys Enter` works in many setups; CSI-u is the robust scripted submit path through Pi's TUI key parser. This example uses shell `cat`; require the built-in `read` tool in the prompt when testing that path:

```sh
tmux send-keys -t "$TMUX_SESSION" -l '/goal Create /tmp/pi-codex-goal-fast.txt containing PI_GOAL_FAST_OK; verify with cat; mark complete; report final status.'
tmux send-keys -t "$TMUX_SESSION" -l $'\033[13u'
```

If a run appears stuck on `Working...` after a built-in `read` result, capture the session JSONL and TUI pane before retrying. A healthy path includes a `toolName: "read"` tool result, an `update_goal` tool result with `status: "complete"`, and a final assistant message. If only the TUI path stalls, treat it as a Pi host/tool-resume reproduction before changing goal continuation logic.

## Automatic npm releases

Follow the [shared release procedure](https://github.com/fitchmultz/.github#automatic-npm-releases): merge a reviewed PR into `main` with an intentional `package.json` version bump and a matching versioned `CHANGELOG.md` section. Once configured and enabled, publication is unattended after compatibility checks and candidate-tarball qualification pass. Complete package-specific evidence before merging a bump, including [interactive smoke tests](#interactive-smoke-tests) for release-sensitive changes. Automation never bumps versions, overwrites releases, or republishes an existing version; existing manual publisher instructions remain valid.

Failed or unpublished candidates retry daily at 12:17 UTC or through manual dispatch of `npm release` on `main`, without another bump. Set `NPM_RELEASE_ENABLED` to anything other than `true` to stop new release plans; cancel pending runs separately when needed. Workflow validation alone does not prove a completed OIDC publication. Documentation-only changes do not need a new version or release.
