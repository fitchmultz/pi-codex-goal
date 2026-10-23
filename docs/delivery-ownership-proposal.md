# Accepted Goal delivery contract

## Owner decision

Mitch accepted the public custom-message redesign on 2026-10-23: **“Your recommendation is accepted.”** The [maintainer announcement](https://github.com/fitchmultz/pi-codex-goal/pull/109#issuecomment-6371873515) records that decision. This supersedes the earlier proposal to add host-owned user-delivery references. No new host API, fork-only capability or support-floor change is required or implemented.

Two intentional behavior changes apply to **all Goal-generated automated follow-ups**, including command start/resume and recovery:

1. They use Pi's existing public custom-message API and are not editable or restored through Alt+Up. Use `/goal pause`, `/goal resume`, and objective replacement to control them. Genuine user input, image input and pending editor drafts retain native behavior.
2. They retain native **custom-message** overflow behavior: they cannot reset an exhausted user-recovery allowance. Goal pauses with a clear explanation instead of impersonating new user input or forcing another retry. After reducing context or switching models, send a genuine user message; native recovery remains available to that message, then `/goal resume` can restart automation.

The PR remains subject to independent review of its exact implementation head and green required CI. Owner approval of this contract is not approval of an unreviewed implementation or permission to activate the live installation.

## Implementation and ownership

`src/goal-delivery.ts` is the sole automated Goal delivery owner. It uses public `sendMessage` with `customType: "pi-codex-goal"`, `display: false`, `triggerTurn: true`, and `deliverAs: "followUp"`. Supported native `details` carry `{ goalId, generation, deliveryId, kind, lifecycle }`; none of that identity is serialized into model text. Native role remains `custom` even though Pi converts custom content into provider-user content.

- Each actual send gets a fresh delivery ID. A runtime activation generation changes on goal/status transitions, clear/replacement, session reload/tree navigation and shutdown. The in-memory pending registry admits only a matching goal, generation, kind and delivery ID. Neither equal text nor a repeated goal ID can establish ownership.
- Native `message_start` admits the specific delivery. Supported `message_end` finalizes it as delivered or replaces stale/duplicate work once with an inert cancellation and cancelled metadata. Historical provider messages and stored content are never rewritten later.
- Genuine input is never classified from content, timestamps, turn FIFO, object identity, or old envelopes. Legacy marker parsing, transport headers, text exemptions and user-follow-up dispatch strategies are removed. Literal envelope text, captions and normalization notes remain user data.
- Cancellation aborts only when doing so cannot discard genuine pending input. The public pending-input guard lets native queued work drain behind an inert cancellation. Native abort is not a selective queue-cancellation API.
- Native Alt+Up can discard hidden custom queue work while restoring real user text. At native `agent_end`, unstarted owned sends are retired; an active valid goal can schedule a fresh delivery with a fresh ID. Retired start/resume work retains full-objective intent. Goal never reads, patches or clears private queues or renderers.
- On reload, old pending ownership is invalid. Old native custom deliveries cannot be replayed into a new activation. Compact Goal state and native custom-entry history remain authoritative; no JSONL migration is performed.

## Cache and compaction

Provider prefixes remain append-only. Cancellation is persisted at initial finalization only. Metadata-owned repetitive custom controls are filtered only from copies of compaction input, not transcript/provider history. Objectives, genuine user messages, tool results, retained boundaries and file tracking survive.

After successful native compaction, the first valid normal automatic continuation includes the full saved objective, status, budget and current usage once. Start/resume controls, stale work and genuine input do not consume that intent. Refresh modifies only Goal's own produced prompt inside the metadata-owned delivery; accompanying text blocks, native image bytes, captions and coordinate notes remain intact. Later continuations are compact. Native compaction entries and a delivered `objectiveRefresh` detail recover pending/consumed intent across reload; no text scan is used to infer ownership.

Custom summarizers must load after Goal or synchronously emit `pi-codex-goal:compaction-input` before consuming preparation. Goal does not replace the chosen summarizer.

## Qualification and acceptance

Current selected hosts (resolved once for this round):

- Official Pi **1.4.0**, source `4a080252f06caf63a525d7873c5d94d3c23887e0`, actual official companion graph (TypeBox 1.3.27).
- Maintained fork **`b02d6a8e6d3e4b9b4c4ae45b371bfed95c71dc8e`**, actual bundled companion graph (TypeBox 1.3.37).
- Node **24.22.1**, isolated agent/HOME/session directories. No live provider credentials, package installation or runtime selector changes.

| Contract | Native proof |
| --- | --- |
| Bubble / pending queue | Real CLI PTY: in-flight pause/resume, regular and fullscreen; no ownership envelope or automated native user row; genuine follow-up row remains |
| Alt+Up / resubmission | Real PTY keyboard flow restores genuine queued input plus existing editor draft, never Goal automation; resubmitted text reaches provider |
| Genuine normalization | Leading literal legacy envelope, caption and real 3000×8 PNG reaches provider once with native resize note; text-only and ordinary-prefix controls retained |
| Owned normalization | Actual finalized custom continuation includes native normalized caption/image/coordinate-note blocks; full objective changes only the owned control block |
| Identity | Pause/resume same goal, stale generations, newer queued delivery, genuine pending image, duplicates and replay after reload; only current activation delivers, real input survives |
| Queue discard | Actual native editor queue restoration discards custom work without making it editable; active Goal requeues valid work, paused Goal stays paused |
| Overflow | Actual native exhausted recovery pauses Goal without a manufactured reset; later genuine input receives native recovery, including after reload |
| Cache / refresh | Stable provider-history prefixes; one-time persisted cancellation; pending and consumed full-objective refresh survive native compaction/reload |

`test/native-lifecycle.test.ts` is the primary native lifecycle owner. Existing guard tests retain separate per-delivery terminal-correlation/order coverage. `scripts/delivery-identity-proof.ts` exercises the original concrete lost-input case, not a substitute mock. `scripts/delivery-role-proof.ts` independently verifies native custom/user overflow differences without Goal.

## Reproduce without changing the live installation

Set `HOST` to an exact installed `pi-coding-agent` package directory, `NODE` to the Node executable and `EVIDENCE` to a fresh directory. Run SDK probes with isolated HOME/agent configuration. `scripts/host-sdk.ts` selects the host's actual companions; changing PATH alone does not select its SDK.

```sh
PI_SDK_PACKAGE="$HOST/package.json" "$NODE" --import ./scripts/host-sdk.ts --test test/*.test.ts
python3 scripts/delivery-ownership-pty.py --node "$NODE" --host "$HOST" --output "$EVIDENCE/deliver"
python3 scripts/delivery-ownership-pty.py --node "$NODE" --host "$HOST" --output "$EVIDENCE/restore" --restore
python3 scripts/delivery-ownership-pty.py --node "$NODE" --host "$HOST" --output "$EVIDENCE/fullscreen" --restore --tui-mode fullscreen
PI_SDK_PACKAGE="$HOST/package.json" "$NODE" --import ./scripts/host-sdk.ts scripts/delivery-role-proof.ts "$EVIDENCE/role"
PI_SDK_PACKAGE="$HOST/package.json" "$NODE" --import ./scripts/host-sdk.ts scripts/delivery-identity-proof.ts "$EVIDENCE/identity"
```

PTY and identity probes assert acceptance and exit nonzero on failure. Raw ANSI, native journals, provider contexts and editor snapshots are retained. The role probe intentionally expects different native recovery for custom/user delivery; it does not relabel custom delivery as user recovery. See the [evidence manifest](delivery-ownership-evidence.json) for current receipts.

## Historical failure (not current implementation evidence)

The original `d6a2c67` PTY proof on official 1.4.0 and fork `5eaa155` exposed `<pi_goal_delivery id="…">` in the bubble, follow-up row and restored editor. Author `6837d4b` removed that header but restored text-plus-turn matching. Native image normalization then caused genuine leading-envelope input to be aborted before any provider call. `da4e9ff` recorded the failed acceptance and proposed a new public host identity API; it did not fix production logic. Those failures and the unchanged native role probe motivated the owner-approved contract change above. They remain historical RED evidence, not green proof of this implementation. Historical artifacts remain under `/tmp/pi-goal-pr109-ownership/`; no Pi session journal is deleted.
