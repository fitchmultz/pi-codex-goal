# Changelog

## Unreleased

- Precompile the published npm extension to NodeNext ESM during `npm pack` and `npm publish`, so Pi loads `dist/index.js` instead of transpiling the TypeScript module graph at startup.
- Exclude runtime TypeScript sources from the npm artifact while retaining declarations, source maps, prompts, documentation, and release-smoke tooling.
- Keep Git and local directory installs build-free using Pi's native directory index selection, with exactly one source extension even when local build output exists.

## 0.2.0 - 2026-08-06

- Raise the minimum supported Pi version to 0.84.0 and pin the development/type-validation baseline to the exact 0.84.0 release.
- Align the SDK runtime smoke with Pi 0.84.0's public `Agent.streamFunction` API and use current pi-ai root exports instead of the compatibility subpath.
- Align the extension test harness with Pi 0.84.0's `registerMarkdownTransformer()` and read-only `scopedModels` context contracts, and serialize the mutating goal tools because they share one session state machine.
- Audit the full repository against every Pi 0.84.0 breaking change; the extension does not use JSON/RPC streaming, model-auth forwarding, dynamic providers, pi-agent-core harness sessions, custom harness filesystems, or remote sessions, so those migrations require no runtime compatibility code.
- Require Pi 0.84.0 or later in install and compatibility documentation while retaining optional wildcard Pi peers as required by Pi package loading.
- Refresh the development lockfile, including the patched `protobufjs` 7.6.5 transitive dependency.

### Validation

- Ran `npm run verify` and a clean public-registry `npm ci && npm run verify` under Pi 0.84.0: `tsc --noEmit`, 6 platform-smoke checks, and 333 regular tests passed in each run.
- Ran `npm audit --omit=optional` with no vulnerabilities and `npm publish --dry-run --ignore-scripts --registry=https://registry.npmjs.org`; both passed.
- Packed the release and installed it project-locally with an isolated Pi 0.84.0 executable/config, verified extension and prompt discovery over RPC, and completed a tmux model-backed `/goal` flow that created and read an exact file, called `get_goal`, called `update_goal`, and rendered the final fullscreen `Goal achieved` status.
- The Crabbox macOS/Ubuntu/native-Windows matrix could not start on this shared host: its doctor stopped before every product suite because Crabbox, model-auth environment, localhost SSH, and Parallels `prlctl` were unavailable. No Crabbox product test ran or failed; the matrix remains required and unchanged for capable environments.

## 0.1.39 - 2026-07-28

- Pause active goals when a hidden continuation run only calls `get_goal` / namespaced `*__get_goal` and makes no actionable progress, so blocked status-inspection loops stop and surface `/goal resume` attention instead of spinning forever (#47).
- Document that goal token budgets intentionally count only active-goal assistant-turn `input`+`output`, and do not track Pi 0.81+ host session totals that also include tool, compaction, and branch-summary usage.

### Validation

- Ran `npm run verify` under Pi 0.80.10: `tsc --noEmit`, 6 platform-smoke checks, and 333 regular tests passed.
- Ran the Crabbox release matrix on macOS, Ubuntu, and native Windows; every packed-package build/install, model-backed goal runtime smoke, and lease-cleanup assertion passed.
- Ran `npm audit --omit=optional` (2 transitive advisories in optional Pi-hosted deps, no direct package deps), `npm publish --dry-run --ignore-scripts`, and an isolated Pi install from the packed tarball; dry-run and install checks passed.

## 0.1.38 - 2026-07-19

- Make Pi the sole compaction owner: remove the extension's hardcoded 50k `turn_end` trigger so Pi's effective compaction settings determine threshold behavior and host/extension races cannot produce `Already compacted` or interrupt an active goal.
- Preserve goal accounting, persistence, recovery, and guarded continuation through Pi's `session_before_compact` and `session_compact` lifecycle events, including host overflow retries and late pre-compaction results.
- On Pi hosts that only check thresholds between low-level runs, a large mid-run tool result can still cause one overflow request before Pi compacts and retries; the extension no longer preempts that request because Pi 0.80.10 exposes no atomic ownership or active-settings API.
- Update the development and documented compatibility baseline to Pi 0.80.10.

### Validation

- Ran `npm run verify` under Pi 0.80.10: `tsc --noEmit`, 6 platform-smoke checks, and 329 regular tests passed.
- Ran the Crabbox release matrix on macOS, Ubuntu, and native Windows; every packed-package build/install, model-backed goal runtime smoke, and lease-cleanup assertion passed.
- Ran `npm audit --omit=optional`, `npm publish --dry-run --ignore-scripts`, and an isolated Pi install from the packed tarball; all passed.

## 0.1.37 - 2026-07-16

- Migrate the SDK runtime smoke from removed `AuthStorage`/`ModelRegistry` session options to the Pi 0.80.9 `ModelRuntime` contract with an in-memory credential store, and refresh the local development lock while preserving wildcard runtime peers.

## 0.1.36 - 2026-07-14

- Refresh the local development lock and documented compatibility baseline to Pi 0.80.7; deliberate per-run `agent_end` continuation handling remains unchanged.

## 0.1.35 - 2026-07-11

- Update the development and documented compatibility baseline to Pi 0.80.6 after auditing current lifecycle, tool, persistence, session replacement, compaction, queued-work, concurrency, and TUI contracts.
- Preserve deliberate per-low-level-run `agent_end` continuation handling; add regression coverage proving `agent_settled` does not replace that hook.

## 0.1.34 - 2026-07-06

- Proactively compact mid-run: when a tool-use turn ends during an active goal with estimated context usage within 50k tokens of the context window, trigger host compaction immediately instead of waiting for the run boundary. Closes the gap where long autonomous runs grew past the context window mid-run and died on hard overflow errors (the pi host only checks its compaction threshold between runs). The compaction-triggered abort does not pause the goal; the existing `session_compact` continuation path resumes it, and a failed proactive compaction pauses the goal for user attention.
- Add a guarded continuation fallback for `session_compact({ willRetry: true })` when the host promises a retry but no `agent_start` arrives, including an SDK runtime smoke test that exercises the real extension runner.

### Validation

- Ran `npm run verify` under pi `0.80.3`: `tsc --noEmit`, 6 platform-smoke checks, and 332 regular tests, all passing.
- Ran `npm run smoke:platform:all` under pi `0.80.3`; doctor passed and macOS, Ubuntu, and native Windows target suites completed successfully.
- Ran `npm audit --omit=optional` and `npm publish --dry-run`, both passing.

## 0.1.33 - 2026-07-01

- Execute the structural audit remediation backlog: consolidate runtime reload/resume boundaries, simplify stale queued-work cleanup paths, centralize platform-smoke build orchestration, and reduce prompt/test source-of-truth drift.
- Add minimal GitHub Actions verification for Node 24 `npm ci` plus `npm run verify` on `push` and `pull_request`, while keeping Crabbox as the local release platform gate.
- Update the local pi development baseline to `@earendil-works/*` `0.80.3`.

### Validation

- Ran `npm run verify` under pi `0.80.3`: `tsc --noEmit`, 6 platform-smoke checks, and 318 regular tests, all passing.
- Ran `npm run smoke:platform:all` under pi `0.80.3`; doctor passed and macOS, Ubuntu, and native Windows target suites completed successfully.

## 0.1.32 - 2026-06-26

- Auto-resume goals paused by recognized provider usage-limit or quota errors with a conservative runtime-only retry timer.
- Add `/goal resume cancel` to stop a pending provider-limit auto-resume while leaving manual `/goal resume` available.
- Keep auto-resume safe across busy sessions, user input, session shutdown, goal replacement, completion, and repeated provider-limit failures.

### Validation

- Ran `npm run verify` under pi `0.80.2`: `tsc --noEmit`, 6 platform-smoke checks, and 312 regular tests, all passing.
- Ran `npm run smoke:platform:all` under pi `0.80.2`; doctor passed and macOS, Ubuntu, and native Windows target suites completed successfully.

## 0.1.31 - 2026-06-24

- Update the local pi development baseline to `@earendil-works/*` `0.80.2` so typecheck fidelity matches the installed runtime pi release.
- Stop hard-coding the published npm version in the README compatibility note so reproducibility guidance does not drift between releases; update the baseline to Pi `0.80.2`.
- Re-baseline the structural audit record to `0.1.30` / `0.80.2` and refresh its summary and validation evidence.
- Document the intentional steady-state cost of the 1 Hz footer status refresh for active goals.

### Validation

- Ran `npm run verify` under pi `0.80.2`: `tsc --noEmit`, 6 platform-smoke checks, and 304 regular tests, all passing.
- Ran `npm run smoke:platform:doctor` and `npm run smoke:platform:all` (macOS, Ubuntu, native Windows) under pi `0.80.2`; doctor reported 0 failures and every platform-build, goal-runtime-smoke, and lease-cleanup assertion suite passed on all three targets.

## 0.1.30 - 2026-06-23

- Update the local pi development baseline to `@earendil-works/*` `0.80.1` after reviewing the Pi 0.80.0 and 0.80.1 changelogs plus current extension/package/security docs.
- Move `@earendil-works/pi-ai` source imports to `@earendil-works/pi-ai/compat`, matching the Pi 0.80 source typechecking migration guidance.
- Refresh README compatibility notes for the Pi `0.80.1` / Node 24 release baseline.

### Validation

- Package published to npm as `0.1.30`. Reproduce the release gate with `npm run verify` and `npm run check:platform-smoke` under the `0.80.1` baseline recorded above.

## 0.1.29 - 2026-06-22

- Remove a stale exact Pi version from a recovery-code comment so source guidance points at the current host retryable-error contract instead of an old Pi baseline.

### Validation

- Ran `npm run verify` under pi `0.79.10`.

## 0.1.28 - 2026-06-22

- Update the local pi development baseline to `@earendil-works/*` `0.79.10` after reviewing the Pi `0.79.10` changelog, extension docs/types, package docs, project-trust docs, and compaction docs.
- Use Pi `0.79.10` `session_compact.willRetry` metadata so overflow compactions that will be retried by the host do not schedule extension fallback continuations.
- Refresh compact/shutdown runtime test fixtures to include current Pi compaction retry metadata and shutdown reasons.
- Fix the platform-smoke Crabbox runner/test harness so fake `.cmd` Crabbox binaries and warmup-secret redaction checks work during native Windows verification.
- Refresh vulnerable dev transitive lockfile entries flagged by `npm audit`.
- Remove the obsolete `.pi-fleet-tested-version` marker; the release baseline now lives in package metadata and docs.
- Update README compatibility notes for the Pi `0.79.10` / Node 24 release baseline.

### Validation

- Ran `npm run verify` under pi `0.79.10`.
- Ran `npm run typecheck` under pi `0.79.10`.
- Ran `npm test` under pi `0.79.10`.
- Ran `npm run check:platform-smoke` under pi `0.79.10`.
- Ran `npm run smoke:platform:doctor` and `npm run smoke:platform:all` under pi `0.79.10`.
- Ran `npm audit --omit=optional`.

## 0.1.27 - 2026-06-15

- Raise the source-tree package Node engine floor to Node 24 so package metadata matches the platform-smoke validation baseline for the next release.
- Refresh the structural audit to the current 0.1.26 baseline and align README/AGENTS audit links.
- Avoid duplicate platform-smoke test execution during `npm run verify` by moving the platform-smoke assertion file under the `check:platform-smoke` script only.
- Narrow runtime event registration typing to the event-handler interface.
- Update the local pi development baseline to `@earendil-works/*` `0.79.4` and refresh the platform-smoke model baseline to `zai/glm-5.2`.

### Validation

- Ran `npm run verify` under pi `0.79.4`.

## 0.1.26 - 2026-06-10

- Resume active goals after host context-overflow auto-compaction when Pi compacts successfully but no host retry turn starts, avoiding sessions that only continue again after `/reload`.
- Add regression coverage for the host-overflow post-compaction fallback and for avoiding duplicate continuations when the host retry turn does start.
- Update the documented Pi release baseline to `@earendil-works/*` `0.79.1`.
- Add a fast interactive `/goal` smoke path and tmux CSI-u Enter automation guidance to the README and platform smoke docs.
- Strengthen the model-backed platform runtime smoke so it requires built-in `read` tool verification before goal completion.

## 0.1.25 - 2026-06-08

- Update the local pi development baseline to `@earendil-works/*` `0.79.0` and refresh the npm lockfile after reviewing the Pi `0.79.0` changelog, extension docs, package docs, SDK/RPC docs, and current project-trust examples.
- Make release smoke commands explicit about Pi `0.79.0` project trust by passing `--approve` for isolated project-local package install, list, and non-interactive runtime smoke paths.
- Update platform-smoke regression checks and docs so future release gates catch missing trust approval flags before packed package validation runs.

## 0.1.24 - 2026-06-04

- Update the local pi development baseline to `@earendil-works/*` `0.78.1` and refresh the npm lockfile after reviewing the Pi `0.78.1` changelog, extension docs, package docs, and current examples.
- Add the new Pi extension context fields to the runtime test harness so tests stay aligned with Pi `0.78.1` `ctx.mode` and command `ctx.getSystemPromptOptions()` APIs.
- Confirm the goal extension remains forward-open for pi installs through optional wildcard pi runtime peers; Pi `0.78.1` is documented as the tested suggested floor, not a hard install requirement.

## 0.1.23 - 2026-06-04

- Add `/goal copy` to copy the current goal objective for active, paused, budget-limited, or completed goals.
- Allow explicit `create_goal` replacement of non-complete goals and teach `/create-goal` to use it so users do not have to clear existing goals first.
- Strengthen Windows doctor readiness with a disposable Crabbox clone SSH/tool probe when the stopped Parallels template has no live IP, while skipping that extra disposable probe during the full platform-smoke gate so the real Windows test lease is opened only once.

## 0.1.22 - 2026-06-02

- Tighten test-only TypeScript casts around goal state and recovery runtime harnesses.
- Make the recovery runtime generic over its context so tests can use the minimal status context they exercise.
- Add a type-hygiene regression check for banned TypeScript escape hatches such as double assertions, `as any`, `as never`, `any` annotations, and suppression comments.

## 0.1.21 - 2026-06-01

- Add a Crabbox-backed release gate for macOS, Ubuntu Linux, and native Windows.
- Prove releases through packed package install, `pi install`, `pi list`, and a real model-backed goal runtime smoke on every required platform.
- Add `check:platform-smoke` to the normal verification path and make `smoke:platform:all` run doctor before any target suite.
- Strengthen platform doctor checks for Crabbox providers, Windows Parallels template/snapshot readiness, repository hygiene, package contents, auth presence, artifact redaction, and lease cleanup evidence.

## 0.1.20 - 2026-05-31

- Defer active-goal continuations queued by `session_compact` until the compaction event has unwound, avoiding nested prompt/auto-compaction races in Pi’s compaction lifecycle.
- Accelerate pending idle continuation retries after compaction so length-stop recovery resumes promptly once the host is idle.
- Ignore stale compact usage snapshots during reconstruction so old runtime entries cannot rewind usage, reactivate completed goals, or downgrade budget-limited goals.
- Expand regression coverage for reported long-session failures: host retry cancellation, duplicate `session_compact` coalescing, shutdown cancellation, host overflow suppression, and stale runtime usage entries.

## 0.1.19 - 2026-05-31

- Add the `/create-goal` prompt template to the package and document it as the recommended way to create high-quality goals from plain tasks.
- Treat `exceeded request buffer limit while retrying upstream` as a retryable transient provider failure so active goals stay active with pending recovery instead of being paused.
- Allow `/goal resume` to queue a user-start continuation when an already-active goal is waiting for post-overflow user-start recovery, avoiding misleading “Only paused goals can be resumed” dead ends.
- Suppress duplicate hidden continuations while an extension-injected user continuation is passing through compaction, avoiding nested prompt errors like “Agent is already processing a prompt.”
- Persist runtime-only usage updates as compact usage snapshot entries after the initial goal snapshot so long active sessions no longer append the full objective on every runtime flush.

## 0.1.18 - 2026-05-29

- Updates the local pi development baseline to `@earendil-works/*` `0.78.0` and refreshes the npm lockfile after reviewing the Pi `0.78.0` changelog.
- Confirms the goal extension remains compatible with Pi `0.78.0` extension and package APIs; no runtime code changes were needed.

## 0.1.17 - 2026-05-29

- Aligns the budget-limit steering prompt with the public `budgetLimited` status spelling.
- Documents that default-branch source installs may include unreleased changes beyond the latest npm/tagged release.
- Adds a copy-pasteable interactive Cursor Composer 2.5 `/goal` smoke test and documents that `pi -p '/goal ...'` is not a reliable slash-command smoke path.
- Stops refreshing the latest active hidden goal continuation during provider-context rewriting, preserving prompt-cache stability while still superseding older continuations.
- Includes README-linked `AGENTS.md` and `docs/CODEBASE_AUDIT.md` in npm packages, switches pinned install examples to version placeholders, and synchronizes audit/recovery baseline notes with Pi `0.77.0`.

## 0.1.16 - 2026-05-28

- Adds `docs/CODEBASE_AUDIT.md` with a 2026-05-28 structural health report and remediation record.
- Adds project `AGENTS.md` and documents `npm run verify` in the README Development section.
- Extracts stale queued-work reducer lifecycle default tables into `stale-queued-work-reducer-defaults.ts`.
- Ignores local `.debug/` Cursor SDK event artifacts in `.gitignore`.
- Updates the local pi development baseline to `@earendil-works/*` `0.77.0`, keeps pi runtime packages as optional wildcard peers, and leaves no pi/Node upper-bound metadata that would block future pi releases at install time.

## 0.1.15 - 2026-05-27

- Refactors the goal runtime monolith into focused modules for clearer lifecycle ownership, event handling, and continuation orchestration.
- Narrows runtime handler dependency interfaces so input/context, turn, agent, and session handlers only receive the lifecycle ports they use.
- Moves goal transition effect application into a focused effect module so transition planning stays centered on goal snapshots and persistence decisions.
- Reworks the stale queued-work reducer around per-lifecycle default transition tables and focused state reducers, keeping no-op handling centralized while preserving explicit exceptional transitions.
- Removes the queued provider-context rewrite type assertion by returning typed provider-context rewrite intersections and clarifies the message normalization boundary comments.
- Hardens stale queued-work cleanup across abort, delayed terminal events, and continuation boundaries so stale work is consumed without mutating replacement-goal accounting.
- Tightens runtime continuation scheduling, recovery sequencing, and persistence/accounting handoff behavior with expanded regression coverage around lifecycle edge cases.
- Updates the local pi development baseline to `@earendil-works/*` `0.76.0` and refreshes the npm lockfile.
- Aligns recovery retry classification with Pi 0.76.0 so terminal quota, billing, and provider-limit errors do not stay pending for host retries even when they include `429` wording.
- Validates the cutover with the existing typecheck/test suite plus package metadata and dry-run pack checks.

## 0.1.14 - 2026-05-26

- Widens the package Node engine range to support Node 22.19.0 through Node 26.x.

## 0.1.13 - 2026-05-26

- Bounds hidden goal continuation provider context by superseding older active-goal continuations with short bookkeeping markers, refreshing only the latest continuation, and using compact auto-continuation prompts after `/goal` start or resume.
- Stops provider-error continuation retry storms by skipping immediate hidden requeues on `stopReason: "error"`, auto-compacting on context-window overflow when available, using bounded backoff for transient failures, and pausing with a recoverable `/goal resume` path when recovery is exhausted.
- Makes goal lifecycle transitions terminal and idempotent: duplicate `update_goal complete` calls no longer append extra session entries, completed goals cannot be paused or resumed, and runtime/compaction skips unchanged goal snapshots.
- Coalesces runtime goal persistence so repeated tool completions and unchanged compaction snapshots do not append full goal entries on every event; live footer usage stays current, and turn boundaries, shutdown, budget crossings, and bounded long-run intervals flush pending accounting to session history.
- Allows `create_goal` to replace a completed goal and clarifies recovery via `/goal <objective>` or `/goal clear`.
- Surfaces failed goal tool calls as real pi tool errors by throwing from tool handlers.

## 0.1.12 - 2026-05-23

- Updated the local pi development baseline to `@earendil-works/*` `0.75.5`, refreshed Node/tsx tooling, and regenerated the npm lockfile.
- Reviewed the pi `0.75.5` changelog and package guidance; the goal extension remains compatible with current extension lifecycle and package install/update behavior.

## 0.1.11 - 2026-05-21

- Cancels stale hidden goal continuations before they can reach the model after a goal is completed, cleared, or replaced.
- Keeps stale abort cleanup from charging tokens, pausing active replacement goals, persisting extra entries, or requeueing continuations during compaction and shutdown.
- Allows normal interactive and RPC prompts that paste continuation marker text to pass through instead of being treated as hidden extension follow-up work.
- Adds regression coverage for stale queued work across missing or delayed `agent_end`, late stale terminal events, compaction cleanup, and pasted marker input sources.

## 0.1.10 - 2026-05-18

- Updated the local pi package baseline to `@earendil-works/*` `0.75.3` and refreshed the npm lockfile.
- Removed tracked CueLoop runtime state from the package and ignored local `.cueloop/` artifacts.


## 0.1.9 - 2026-05-09

- Escapes goal objectives in hidden continuation and budget-limit prompts before embedding them in XML-style untrusted blocks.
- Keeps budget-limited goals from being paused or resumed back to active while they remain at or over budget.
- Sends a one-shot hidden budget-limit steering message when token accounting crosses the configured budget.
- Keeps ordinary user prompts from silently reactivating paused goals; session resume now prompts before restarting a paused goal.
- Returns Codex-shaped goal tool responses with `remainingTokens` and completion budget reports.
- Prevents tokens from an old in-flight turn from being charged to a replacement goal.
- Updates `/goal` summary and footer labels toward Codex-style status wording while retaining this package's 8000-character objective limit.

## 0.1.8 - 2026-05-07

- Migrates the local pi development baseline and peer metadata from deprecated `@mariozechner/*` packages to maintained `@earendil-works/*` `0.74.0`.
- Regenerates the npm lockfile against the current stable dependency graph.

## 0.1.7 - 2026-05-07

- Keeps active goals continuing after auto-compaction, including length-stop compactions.
- Prevents stale queued goal continuations from running after a goal is completed or changed.
- Strengthens completion-audit prompts and update-goal guidance so goals are marked complete only after verified completion.
- Avoids duplicate persisted completion entries from `update_goal`.

## 0.1.6 - 2026-05-06

- Clarifies README install commands for npm, pinned npm, GitHub, and pinned GitHub package installs.

## 0.1.5 - 2026-05-06

- Counts goal tokens from completed assistant input plus output usage instead of `usage.totalTokens`.
- Excludes cache read and cache write accounting channels from goal token budgets so cached provider tokens do not inflate sent and received totals.

## 0.1.4 - 2026-05-06

- Pauses active goals when pi reports an aborted assistant turn, including user Esc aborts.
- Resumes paused goals automatically on the next user-driven agent start, while keeping `/goal resume` available.
- Prevents aborted turns from immediately queueing hidden continuation messages.

## 0.1.3 - 2026-05-06

- Corrects the README behavior summary to describe completed assistant turn token accounting.

## 0.1.2 - 2026-05-06

- Counts completed assistant turn usage via pi's `usage.totalTokens` instead of using context-window deltas, so goal token totals track tokens sent and received across compaction.
- Keeps elapsed-time accounting stable before and after compaction while continuing to persist active goal state.

## 0.1.1 - 2026-05-06

- Marks pi runtime peer dependencies as optional so `pi install npm:pi-codex-goal` stays lightweight while still documenting the extension runtime contract.

## 0.1.0 - 2026-05-06

- Initial public release.
- Adds Codex-style `/goal` tracking for pi.
- Adds model-callable `get_goal`, `create_goal`, and `update_goal` tools.
- Persists goal state in pi session custom entries for resume, reload, fork, tree navigation, and compaction.
- Starts and resumes goals with hidden follow-up messages so active objectives keep moving.
- Shows live elapsed active time and compact/exact token counts in the pi footer.
