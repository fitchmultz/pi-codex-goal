# Delivery ownership: blocked host contract proposal

Status: **proposed, not implemented or approved**. PR [#109](https://github.com/fitchmultz/pi-codex-goal/pull/109) must not merge on this evidence. This document does not change the Pi 1.0 support floor, switch message roles, authorize host changes, or waive the [maintainer hold](https://github.com/fitchmultz/pi-codex-goal/pull/109#issuecomment-6356960005).

## Decision

Preserve native user-role delivery, queue editing, and overflow recovery. Before shipping owned Goal user deliveries, add a supported **host-owned delivery identity and lifecycle channel**, separately from text/images, on both official Pi and the maintained fork. Neither inspected host provides that complete channel. A numeric support floor cannot be named until such an API ships and is qualified.

Removing the header is necessary but insufficient. Do not merge the text-plus-turn fallback at `6837d4b` as a complete ownership fix. Do not replace user delivery with custom messages, strip user-authored text, intercept private queues/renderers, hide IDs with Unicode, or fix only Markdown rendering.

## Inspected hosts and new native evidence

Evidence was collected on macOS arm64, Node 24.22.1, using isolated HOME, agent, project, and session directories, without credentials or model network calls. Both actual bundled CLIs report 1.4.0; they are different distributions:

| Distribution | Exact identity | Companion TypeBox |
| --- | --- | --- |
| Official npm Pi | 1.4.0, source `4a080252f06caf63a525d7873c5d94d3c23887e0` | 1.3.27 |
| Maintained fork, requested historical target | `5eaa155bb7c837aba37f823b007c25279f7b58d6`, immutable local artifact catalog `555dfb5611779ccf6d433cc2454ded27f2050a4d8745c0dc5d3f06fa4d55a7be` | 1.3.37 |

The current fork main was separately resolved as `b02d6a8e6d3e4b9b4c4ae45b371bfed95c71dc8e`; it is not substituted for the requested `5eaa155` proof. CI continues to select latest official/fork hosts under repository policy.

### Original head: `d6a2c67b5a462e84d6e21c52d2be8385a8ff9139`

A real native CLI/PTTY response is held by an offline faux provider. Type `/goal pause`, then `/goal resume` while it is running:

- Native `Follow-up:` displays `<pi_goal_delivery id="…">`.
- Releasing the response delivers a native user bubble containing that header.
- In a separate run, native Alt+Up restores the header into the editor. A supported extension shortcut records `ctx.ui.getEditorText()`; no private restore method is invoked.
- Submitting that editor value removes the header later, before provider/persistence. That later cleanup does not undo the three earlier exposures.

Both pinned hosts reproduce all three exposures with exit 0. Raw ANSI, native session JSONL, provider contexts, editor snapshots, invocations and exit receipts are retained in `/tmp/pi-goal-pr109-ownership/d6-{official,fork}-{deliver,restore}/` on the maintainer machine. These are native terminal captures, not screenshot or backend-cache claims.

### Author revision: `6837d4b3a091bb3cb3fc1eb88033303d494356f1`

The branch advanced while remediation started. It was fast-forwarded, not overwritten. Its header removal cleans bubble, queue and Alt+Up/resubmission on both hosts. Regular-mode delivery/restoration and fullscreen restoration were exercised through native keys.

However, `scripts/delivery-identity-proof.ts` supplies **genuine interactive** input to a paused goal: a literal continuation envelope plus a caption. With no image it reaches the provider once. With the same text and a real 3000×8 PNG, native normalization appends its image-coordinate note. The text-plus-turn exemption no longer matches the normalized user message; Goal mistakes the genuine input for stale queued work and aborts before the provider:

| Host | Text-only provider calls | Resized-image provider calls | Expected |
| --- | ---: | ---: | --- |
| Official 1.4.0 | 1 | **0** | 1 in both cases |
| Fork `5eaa155` | 1 | **0** | 1 in both cases |

The caption and native resize note remain stored, the goal stays paused, but the input is unanswered. The standalone acceptance probe exits **1**, intentionally, on both hosts. A passing normal test suite does not cover or rebut this failure. The existing image test puts ordinary text *before* the literal envelope, so it does not exercise a leading envelope's exemption through normalization.

The same resized image with ordinary text before the literal envelope reaches the provider once on both hosts, isolating the leading-marker ownership failure from image/provider support. Reports and native sessions are retained in `/tmp/pi-goal-pr109-ownership/final-identity-{official,fork}/`. Header-free CLI captures are in `final-{official,fork}-{deliver,restore,fullscreen}/` under the same evidence root. The committed [evidence manifest](delivery-ownership-evidence.json) records reports, host companion graphs and artifact SHA256 values.

### Custom delivery is not equivalent

`scripts/delivery-role-proof.ts` exhausts one native overflow compact/retry, then sends identical follow-up content as either custom or user input. There is no Goal extension in this independent host-boundary probe:

| Native route, both hosts | Total provider calls | Total summaries | Additional summaries after new delivery |
| --- | ---: | ---: | ---: |
| Custom | 3 | 1 | 0 |
| User | 4 | 2 | 1 |

The user route resets the host's exhausted recovery allowance; the custom route does not. Custom messages are converted to provider-user content, but retain different native roles, compaction span boundaries and editable-queue behavior. Reports and native sessions are in `role-{official,fork}/`. This is not a proposal to manipulate private recovery flags.

## Why the current public contract cannot meet acceptance

The version-matched declarations and executable owners agree on both inspected hosts:

- `sendUserMessage(content, { deliverAs, expandPromptTemplates })` accepts text/images and returns no delivery handle to extensions. `InputEvent` exposes text, images, source and streaming behavior; its transform result can return text/images, not opaque delivery metadata.
- Public `UserMessage` has role, content and timestamp. It has no supported extension provenance field. Text signatures are provider-owned, not an ownership escape hatch.
- Input events are not linked to the later normalized message by a supported token or object identity. Text blocks are joined, images normalized, and coordinate notes appended. A WeakMap keyed on an input event cannot identify the eventual message.
- The native queue display and Alt+Up restore owner consumes user strings. The extension context offers no per-delivery queue-discard/edit callback or owned-item cancellation primitive. SDK-owner `clearQueue()` clears unrelated input too and is not a selective extension API.
- `message_start` creates the user bubble before `message_end`; user `message_end` does not reconstruct that bubble. Markdown transformation cannot affect the raw queue/editor owners.
- `message_end` replacements must preserve role. Custom `details` cannot be smuggled across that boundary as native user metadata.

Immutable sources: official [extension API](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/extensions/types.ts), [session delivery/recovery](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/agent-session.ts), [queue/render/restore](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/interactive/interactive-mode.ts), [user types](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/types.ts); fork [extension API](https://github.com/fitchmultz/pi/blob/5eaa155bb7c837aba37f823b007c25279f7b58d6/packages/coding-agent/src/core/extensions/types.ts), [session](https://github.com/fitchmultz/pi/blob/5eaa155bb7c837aba37f823b007c25279f7b58d6/packages/coding-agent/src/core/agent-session.ts), [interactive owner](https://github.com/fitchmultz/pi/blob/5eaa155bb7c837aba37f823b007c25279f7b58d6/packages/coding-agent/src/modes/interactive/interactive-mode.ts).

Without a supported identity channel, two equal texts from different sources can become indistinguishable after normalization, queue removal, joining and re-entry. A parallel text/turn/FIFO record cannot observe all invalidations, and cannot establish per-delivery ownership. Expanding prefix matching would still confuse genuine input and stale/replaced work. The image counterexample makes this a demonstrated failure, not merely a theoretical objection.

## Proposed host contract (not an existing API)

Names and signatures below are design requirements, **not callable APIs**. A companion host proposal must settle them before Goal implements them.

1. **Allocate on send.** A supported owned-user send allocates a host-owned delivery reference, bound to session generation and originating extension. Goal attaches `{ goalId, kind, goalGeneration }` as non-model sidecar data. The ordinary content argument remains clean text/images and the native role remains `user`. Interactive/RPC text cannot forge ownership by spelling a marker or ID.
2. **Propagate out of band.** The same reference survives input-handler composition, normalization, queue reordering, steering/follow-up scheduling, `before_agent_start`, message start/finalization, chained message copies and terminal events. Consumers query a public event/reference API, never guess from text, timestamps, array positions or object identity. A finalization replacement must not transfer another delivery's provenance.
3. **Queue lifecycle and scoped cancellation.** Emit acknowledged queued, delivered, handled/rejected, cancelled, dequeued-for-edit and invalidated outcomes, exactly once per delivery. Support atomic cancellation of an extension's own pending reference only, with a delivered/already-terminal result for races. Never clear genuine pending input or another extension's queue. Pause, clear, completion, replacement and session shutdown retire matching pending ownership; stale deliveries cannot regain validity through a reused goal ID.
4. **Editing severs ownership.** Alt+Up joins only clean text and preserves the host's native attachment policy. It retires all constituent references before returning editor content, including mixed genuine/owned steering and follow-up queues. Editing or resubmitting allocates a fresh genuine-user delivery, even when every byte is unchanged. Tree/fork editor restoration follows the same rule. No old token is restored, hidden, stripped or rediscovered by parsing text.
5. **Rendering and provider isolation.** Bubble, queue preview, editor, history/export and provider serialization never receive the sidecar as text. They continue using native user rendering and queue affordances. Captions, image blocks and native normalization notes remain intact; Goal rewrites only its own structured control portion before the first visible delivery/provider submission, through a supported host phase.
6. **Durability and lifecycle.** If a host restores pending deliveries across reload/restart, it restores or explicitly invalidates their ownership atomically with queue restoration. A delivered message has durable, branch-relative provenance keyed to its native entry identity when later terminal correlation needs it. No JSONL content migration or retroactive ownership inference from old user text. Session replacement invalidates old references; recovered custom Goal state remains authoritative.
7. **Recovery is native.** Owned sends that retain the user role use native user overflow-reset, retry and compaction-span behavior. A genuine subsequent interactive/RPC user always gets its native recovery allowance. Goal must not set host recovery flags or synthesize receipts. Existing per-loop continuation and final settlement ordering remains intact.

Goal then indexes its state by the host delivery reference. It validates the associated goal generation at the supported pre-delivery boundary, cancels stale work by reference, consumes a pending full-goal refresh only for a valid owned delivery, and retains terminal correlation after cancellation without scanning genuine text. Historical provider messages stay append-only.

## Support and rollout decision required

Preferred: land and qualify the public host contract on official Pi and the maintained fork first, then implement Goal against it. Keep Pi 1.0 support for the currently published extension; do **not** claim this stronger delivery guarantee on existing hosts. Before activating the new behavior, approve an explicit capability/support policy: either require a newly qualified host for the affected user-delivery feature with a clear unsupported-host error, or approve a broader support-floor change. Neither policy is implemented by this PR update.

A custom-only redesign is a different product contract, not a portability shim: it must explicitly remove editable native Goal user follow-ups and redesign overflow restart behavior, documentation and tests. That material behavior change requires separate approval. It is not the proposed remedy here. The text-based fallback is not an acceptable third route.

## Acceptance gates for a future implementation

| Contract | Required native proof on each qualifying host |
| --- | --- |
| Bubble and pending queue | In-flight pause/resume, steer/follow-up, regular/fullscreen: no sidecar text, native user affordances retained |
| Alt+Up and resubmission | Single/multiple/mixed queued items and existing editor draft; native restore retires each old reference; unchanged/edited resubmissions are genuine |
| Normalization | Leading literal marker, captions, multiple text blocks, images, resized-image coordinate notes, and input-handler composition; genuine user input reaches provider unchanged except native normalization |
| Identity | Equal owned/genuine text in both orders, reverse steering order, handled/rejected input, queue discard, pause/complete/clear/replace, cancelled finalization, copies, reload/restart/fork/session replacement; no ownership transfer or leftover slot |
| Recovery | Exhausted native overflow attempt, owned user delivery and true-user next input; preserve retry count, compaction spans, queue order and final settlement |
| Cache/history | Provider prefixes remain unchanged after first delivery; cancellation persisted once; full objective refreshed once on the first valid continuation after compaction |

Green ordinary CI alone does not satisfy these gates. Do not resolve the CHANGES_REQUESTED finding until the contract is approved, implemented and passes these native checks. There are currently no inline review threads to resolve; the blocking review is a top-level review.

## Reproduce without touching the live installation

Set `HOST` to an installed exact `pi-coding-agent` package directory, `NODE` to its absolute Node executable, and `EVIDENCE` to a fresh path. Use a clean agent/HOME outside the real home ancestry for SDK probes. `scripts/host-sdk.ts` selects that host's actual companion graph; a PATH-only CLI change does not.

```sh
python3 scripts/delivery-ownership-pty.py --node "$NODE" --host "$HOST" --output "$EVIDENCE/deliver"
python3 scripts/delivery-ownership-pty.py --node "$NODE" --host "$HOST" --output "$EVIDENCE/restore" --restore
python3 scripts/delivery-ownership-pty.py --node "$NODE" --host "$HOST" --output "$EVIDENCE/fullscreen" --restore --tui-mode fullscreen
PI_SDK_PACKAGE="$HOST/package.json" "$NODE" --import ./scripts/host-sdk.ts scripts/delivery-role-proof.ts "$EVIDENCE/role"
PI_SDK_PACKAGE="$HOST/package.json" "$NODE" --import ./scripts/host-sdk.ts scripts/delivery-identity-proof.ts "$EVIDENCE/identity"
```

The last command is an explicit **failing acceptance probe** on `6837d4b`, not part of `npm run check`. Its exit 1 and report must not be relabeled as a pass. The role probe's paired native assertion passes. The PTY script reports observations; a successful process exit proves completion of the probe, not ownership correctness. Preserve native JSONL evidence; no probe installs a package, modifies live settings, migrates history, or calls a paid provider.
