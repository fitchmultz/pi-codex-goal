# Platform smoke testing

`pi-codex-goal` uses a Crabbox-backed local platform smoke gate to prove the package on macOS, Ubuntu Linux, and native Windows before release-sensitive changes ship.

Ordinary hosted CI only runs `npm run verify` on Node 24 for push and pull request checks. It does not run this Crabbox release matrix, lease targets, secrets, or model-backed platform smoke.

This setup reuses the portable Crabbox platform-testing lessons without copying provider-specific smoke flows from another project. The gate includes a real model-backed pi run so release checks catch platform-specific extension failures before completion is claimed.

## Required gate

Release-sensitive changes use a doctor-first gate:

```sh
npm run check:platform-smoke
npm run smoke:platform:doctor
npm run smoke:platform:all
```

`smoke:platform:all` runs the same doctor before any target suite starts, so a full release run still fails before syncing targets or spending model tokens when local setup is not ready. Run `smoke:platform:doctor` directly when diagnosing setup.

Per-target commands are for diagnosis. They run a lightweight local artifact preflight before Crabbox sync, but they do not replace the full doctor readiness check:

```sh
npm run smoke:platform:macos
npm run smoke:platform:ubuntu
npm run smoke:platform:windows-native
```

## Targets

| Target | Crabbox provider | Shell contract |
| --- | --- | --- |
| `macos` | `ssh` static localhost | POSIX shell on macOS |
| `ubuntu` | `local-container` | POSIX shell in an Ubuntu Node container |
| `windows-native` | `parallels` | native Windows PowerShell |

## Required environment

Install Crabbox `0.26.0` or newer with Homebrew so `crabbox` is on `PATH`. Use `PLATFORM_SMOKE_CRABBOX=/path/to/crabbox` only when testing a non-default binary. The supported package runtime floor is Node 24, matching the local and Crabbox platform validation baseline.

```sh
PLATFORM_SMOKE_MAC_HOST=localhost
PLATFORM_SMOKE_MAC_USER="$USER"
PLATFORM_SMOKE_MAC_WORK_ROOT="/Users/$USER/crabbox/pi-codex-goal"
PLATFORM_SMOKE_UBUNTU_IMAGE="cimg/node:24.16"

PLATFORM_SMOKE_WINDOWS_VM="pi-extension-windows-template"
PLATFORM_SMOKE_WINDOWS_SNAPSHOT="crabbox-ready"
PLATFORM_SMOKE_WINDOWS_USER="<windows-ssh-user>"
PLATFORM_SMOKE_WINDOWS_WORK_ROOT="C:\\crabbox\\pi-codex-goal"

# Real runtime smoke defaults.
PLATFORM_SMOKE_MODEL="zai/glm-5.2"
PLATFORM_SMOKE_AUTH_ENV="ZAI_API_KEY,Z_AI_API_KEY"
```

`platform-smoke.config.mjs` owns the project defaults: required targets/suites, Crabbox minimum version, Ubuntu image, macOS work root, shared Parallels template/snapshot, Node validation major, default model, and explicit auth env names. Use `PLATFORM_SMOKE_*` variables only as local machine knobs or one-off overrides.

Use `PLATFORM_SMOKE_MODEL` to run the real runtime smoke against another provider/model, and `PLATFORM_SMOKE_AUTH_ENV` to tell Crabbox which auth variables to forward to each target. Do not broad-allow secrets; forward only the named variables needed by `goal-runtime-smoke`.

The doctor fails when any required platform setup is missing. It verifies the Crabbox binary/version, `ssh`, `local-container`, and `parallels` provider availability, provider-specific readiness, Docker, macOS SSH, Windows source VM/snapshot state, artifact-root writability, forbidden source/package artifacts, and model auth presence. It also fails when the real runtime smoke suite is required and none of the configured model auth environment variables is present. Doctor does not install missing target tools; reusable tool drift should be fixed in the local target image/template.

Local `.env` / `.env.*` files and packed `.tgz` artifacts are forbidden at the repository top level. They are ignored by both Git and Crabbox sync, and the platform-smoke `run` command rejects them before target sync so diagnostic per-target runs cannot forward local secrets accidentally.

For Windows, `pi-extension-windows-template` must be stopped and `crabbox-ready` must be a known-good power-off snapshot. Standalone doctor warms a disposable Crabbox clone when the stopped template has no live IP, then probes `node`, `npm`, `git`, `tar`, and SSH identity. The full `smoke:platform:all` gate skips that disposable doctor probe because the immediately following Windows target run validates the same SSH/tool path on the real test lease. If a reusable Windows tool is missing, update the template and refresh/promote `crabbox-ready`; do not add one-off installers to per-run smoke scripts.

## What the suites prove

Each required target runs `platform-build` and `goal-runtime-smoke`.

### `platform-build`

1. Verify Node major version is at least the configured Node 24 validation baseline.
2. Run `npm ci` in the synced checkout.
3. Run `npm run verify`, the repo's ordinary local/hosted verification command.
4. Run `npm pack`.
5. Create a clean target-local pi project.
6. Install the packed tarball into that project with `npm install --no-save`.
7. Run `pi install -l ./node_modules/pi-codex-goal --approve` from the clean project so supported Pi 0.84.0-or-later hosts can read and write project-local package settings for this isolated command.
8. Run `pi list --approve` and assert `pi-codex-goal` is registered from the packed install.
9. Assert the smoke never used the source shortcut `pi -e .` or `pi --extension .`.

### `goal-runtime-smoke`

1. Re-pack and install the package into a clean target-local pi project.
2. Run real `pi --approve --model <model> -p <prompt>` against that packed install so non-interactive Pi 0.84.0-or-later hosts load the isolated project-local package settings.
3. Prompt the model to call the actual goal tools, create a marker file, verify it with the built-in `read` tool, call `update_goal`, and confirm completion.
4. Capture pi stdout/stderr and session JSONL.
5. Assert the final marker, verified file, `pi-codex-goal` custom entries, built-in `read` tool evidence, and complete goal status.

## Artifact contract

Every target writes artifacts under:

```text
.artifacts/platform-smoke/<run-id>/<target>/<suite>/
```

Required files include:

```text
summary.json
artifact-manifest.json
target.json
suite.json
command.txt
exit-code.txt
crabbox.stdout.txt
crabbox.stderr.txt
crabbox.timing.json
node-version.txt
packed-tarball.txt
packed-node-install.stdout.txt
packed-node-install.stderr.txt
pi-install.stdout.txt
pi-install.stderr.txt
pi-list.stdout.txt
pi-list.stderr.txt
assertions.json
failures.md            # only when assertions fail
```

`goal-runtime-smoke` also writes `goal-runtime-result.json`, `pi-run.stdout.txt`, `pi-run.stderr.txt`, and `session.jsonl`.

Interactive `/goal` smoke checks are manual by default and are release evidence, not a replacement for `goal-runtime-smoke`. Record manual interactive `/goal` evidence for release-sensitive changes that touch slash-command parsing, TUI submission, goal command behavior, hidden continuation, or post-tool completion. The evidence record must include the prompt submitted, model, session directory, final assistant evidence, and confirmation that the session JSONL contains the `/goal` command path, file verification, and `update_goal` completion.

If you automate them through tmux, send the prompt as literal text and submit with CSI-u Enter (`ESC [ 13 u`). This fast example intentionally uses shell `cat`; change the prompt to require the built-in `read` tool when that path is under test:

```sh
tmux send-keys -t "$TMUX_SESSION" -l '/goal Create /tmp/pi-codex-goal-fast.txt containing PI_GOAL_FAST_OK; verify with cat; mark complete; report final status.'
tmux send-keys -t "$TMUX_SESSION" -l $'\033[13u'
```

Normal `tmux send-keys Enter` works in many environments, but CSI-u Enter is the robust scripted path through Pi's TUI key parser.

The suites record failures as artifacts before reporting failure so the host can inspect the real target evidence. If a multi-suite target run fails before any suite starts, it writes a `warmup-failure` artifact directory with Crabbox stdout/stderr, timing, exit-code, and assertion evidence. `target.json` records the Crabbox provider, target, work root, and image/template identifiers used for the run. Each target also writes a `lease-cleanup` artifact directory with `crabbox.stop.*` files; cleanup failure is a failing test result. Ubuntu and Windows runs also invoke Crabbox cleanup for stale provider-owned state after stopping the owned lease. Static macOS SSH cleanup remains host-owned because Crabbox can only remove its local claim there.

## Lessons carried forward

- Treat Crabbox as the lease/sync/run layer; this repo owns the assertions that make a run meaningful.
- Use Crabbox targets instead of a one-OS local script.
- Keep `platform-build` behavior in the shared Node orchestrator; native Windows may use only a thin PowerShell wrapper to launch it.
- Run the repository's existing validation command on every required target.
- Test the packed package, not `pi -e .`.
- Pass `--approve` for isolated project-local package smoke commands and non-interactive runtime smokes; Pi 0.84.0-or-later hosts otherwise skip project-local settings and packages when no saved trust decision exists.
- Include a real model-backed pi run so release claims are not based on unit tests alone.
- Assert built-in `read` evidence in the model-backed runtime smoke so post-tool goal completion stays covered.
- Keep project-specific defaults in `platform-smoke.config.mjs`; use environment variables only for local overrides.
- Make doctor fail before expensive or long target runs, and enforce doctor-before-all in the release entrypoint.
- Preserve artifacts on failure and use `assertions.json` as the pass/fail source of truth.
- Record lease stop evidence for every target and fail cleanup problems.
- Treat missing platform setup as blocked, not skipped-ready.
- Redact persisted artifacts and fail scans that find raw secret values.

## Source of truth

- Config: [`platform-smoke.config.mjs`](../platform-smoke.config.mjs)
- Sync exclusions: [`.crabboxignore`](../.crabboxignore)
- CLI: [`scripts/platform-smoke.mjs`](../scripts/platform-smoke.mjs)
- Target commands: [`scripts/platform-smoke/targets.mjs`](../scripts/platform-smoke/targets.mjs)
- Platform-build suite body: [`scripts/platform-smoke/platform-build.mjs`](../scripts/platform-smoke/platform-build.mjs)
- Windows wrapper: [`scripts/platform-smoke/platform-build-windows.ps1`](../scripts/platform-smoke/platform-build-windows.ps1)
