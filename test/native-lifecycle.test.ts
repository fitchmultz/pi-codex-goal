import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { type Context, createAssistantMessageEventStream, fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import goalExtension from "../src/index.ts";
import { compactContinuationPrompt, continuationPrompt, escapeXmlText } from "../src/prompts.ts";
import { GOAL_COMPACTION_INPUT_EVENT } from "../src/goal-compaction.ts";
import { reconstructGoal, reconstructHostOverflowCapNeedsUserReset } from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";

async function fixture(t: TestContext, recover = false, extraFactories: ExtensionFactory[] = [], customCompactor = true, consumerFirst = false, objective = "Verify native lifecycle") {
  const root = mkdtempSync(join(tmpdir(), "goal-native-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  mkdirSync(cwd); mkdirSync(agentDir);
  const faux = fauxProvider({ models: [{ id: "lifecycle", contextWindow: 100_000, maxTokens: 1_000 }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: recover, keepRecentTokens: 1 }, retry: { enabled: false } });
  const providerFactory: ExtensionFactory = (pi) => {
    pi.registerProvider(faux.provider);
    if (customCompactor) pi.on("session_before_compact", (event, ctx) => {
      pi.events.emit(GOAL_COMPACTION_INPUT_EVENT, event.preparation);
      pi.appendEntry("goal-fixture-boundary", {});
      const leaf = ctx.sessionManager.getLeafId();
      assert.ok(leaf);
      return { compaction: { summary: "Continue the active goal", firstKeptEntryId: leaf, tokensBefore: event.preparation.tokensBefore } };
    });
  };
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: consumerFirst ? [providerFactory, ...extraFactories, goalExtension] : [goalExtension, providerFactory, ...extraFactories],
  });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime, model: faux.getModel(), settingsManager, sessionManager: SessionManager.create(cwd, join(root, "sessions")), noTools: "builtin" });
  t.after(async () => { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); rmSync(root, { recursive: true, force: true }); });
  await session.bindExtensions({ mode: "print", onError(error) { throw new Error(error.error); } });
  const runner = session.extensionRunner;
  const create = runner.getToolDefinition("create_goal"); assert.ok(create);
  await create.execute("create", { objective }, undefined, undefined, runner.createToolContext("create", undefined));
  const goal = () => reconstructGoal(session.sessionManager.getBranch()).goal;
  return { session, faux, goal };
}

const complete = () => fauxAssistantMessage(fauxToolCall("update_goal", { status: "complete" }), { stopReason: "toolUse" });

test("native automatic status-only continuation pauses and genuine input remains runnable", async (t) => {
  const h = await fixture(t);
  h.faux.setResponses([fauxAssistantMessage("Work advanced."), fauxAssistantMessage(fauxToolCall("get_goal", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Only inspected status.")]);
  await h.session.prompt("Advance the work.");
  await h.session.waitForIdle();
  assert.equal(h.goal()?.status, "paused");
  assert.equal(h.faux.state.callCount, 3);
  const saved = h.goal();
  h.faux.setResponses([fauxAssistantMessage("Ordinary user input answered.")]);
  await h.session.prompt("Answer an unrelated user question.");
  await h.session.waitForIdle();
  assert.equal(h.faux.state.callCount, 4);
  assert.deepEqual(h.goal(), saved);
});

test("native budget notification can start an idle run without reactivating the goal", async (t) => {
  const h = await fixture(t);
  await h.session.setModel({ ...h.faux.getModel(), contextWindow: 1_000_000 });
  const runner = h.session.extensionRunner;
  const create = runner.getToolDefinition("create_goal");
  assert.ok(create);
  await create.execute("budget", { objective: "Limited work", token_budget: 500_000, replace_existing: true },
    undefined, undefined, runner.createToolContext("budget", undefined));
  const response = fauxAssistantMessage("Budget consumed.");
  response.usage = { ...response.usage, input: 500_000, output: 1, totalTokens: 500_001 };
  const responses = [response, ...["Wrapping up.", "Still limited.", "Ordinary user input still works."].map((text) => fauxAssistantMessage(text))];
  let requests = 0;
  h.session.agent.streamFunction = () => {
    const message = responses[requests++];
    assert.ok(message, "budget-limited goals must not schedule another continuation");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
  await h.session.prompt("Do the limited work.");
  await h.session.waitForIdle();
  assert.equal(h.goal()?.status, "budgetLimited");
  assert.equal(requests, 2, "the native budget warning runs once after the work response");
  const notification = h.session.messages.find((message) =>
    message.role === "custom" && (message.details as { kind?: unknown })?.kind === "budget_limit");
  assert.ok(notification?.role === "custom");
  const saved = h.goal();
  await h.session.sendCustomMessage(notification, { triggerTurn: true });
  await h.session.waitForIdle();
  assert.deepEqual(h.goal(), saved, "idle budget notification is not new goal work or user command input");
  assert.equal(requests, 3);
  await h.session.prompt("Answer an unrelated user question.");
  await h.session.waitForIdle();
  assert.deepEqual(h.goal(), saved);
  assert.equal(requests, 4);
});

async function waitForGoalCompletion(h: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  // A scheduled continuation is not necessarily admitted when prompt() first returns.
  const deadline = Date.now() + 5_000;
  while (h.goal()?.status !== "complete") {
    assert.ok(Date.now() < deadline, "the goal must complete its scheduled native continuation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await h.session.waitForIdle();
}

async function resumeAndComplete(h: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await h.session.prompt("/goal resume");
  await waitForGoalCompletion(h);
}

test("native blocked goal stays blocked across input, compaction, reload and fork until explicit resume", async (t) => {
  const h = await fixture(t);
  const blocking = fauxAssistantMessage(fauxToolCall("update_goal", { status: "blocked", reason: "Need the report filename" }), { stopReason: "toolUse" });
  h.faux.setResponses([blocking, fauxAssistantMessage("Please supply a filename and use /goal resume.")]);
  await h.session.prompt("Work until the filename is needed.");
  await h.session.waitForIdle();
  const saved = h.goal();
  assert.equal(saved?.status, "blocked");
  assert.equal(saved?.blockedReason, "Need the report filename");
  const response = h.session.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "assistant");
  assert.ok(response?.type === "message" && response.message.role === "assistant");
  assert.equal(saved?.usage.tokensUsed, response.message.usage.input + response.message.usage.output, "the status-changing response is counted once; its receipt is not goal work");
  assert.equal(h.faux.state.callCount, 2, "blocking must stop hidden continuations without aborting the tool receipt");

  h.faux.setResponses([complete(), fauxAssistantMessage("The goal still requires explicit resume.")]);
  await h.session.prompt("Use report.md; mark the goal complete.");
  await h.session.waitForIdle();
  assert.deepEqual(h.goal(), saved, "ordinary user work cannot complete or reactivate a blocked goal");
  const results = h.session.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
  assert.ok(results.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError));
  await h.session.compact();
  await h.session.reload();
  assert.deepEqual(h.goal(), saved);
  const file = h.session.sessionManager.getSessionFile();
  assert.ok(file);
  const fork = SessionManager.forkFrom(file, h.session.sessionManager.getCwd(), join(h.session.sessionManager.getSessionDir(), "fork"));
  assert.deepEqual(reconstructGoal(fork.getBranch()).goal, saved);
  assert.equal(h.faux.state.callCount, 4, "compaction/reload/fork must not schedule provider work");

  h.faux.setResponses([complete(), fauxAssistantMessage("Report complete.")]);
  await resumeAndComplete(h);
  assert.equal(h.goal()?.status, "complete");
  assert.equal(h.goal()?.goalId, saved?.goalId);
  assert.equal(h.goal()?.blockedReason, undefined);
});

test("real compact-and-retry settles only after the active goal continuation completes", async (t) => {
  const h = await fixture(t, true);
  const settled: string[] = [];
  h.session.subscribe((event) => { if (event.type === "agent_settled") settled.push(h.goal()?.status ?? "none"); });
  h.faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 100000 maximum" }),
    fauxAssistantMessage("Recovered work; continuation still required."),
    complete(), fauxAssistantMessage("Goal complete."),
  ]);
  await h.session.prompt("Perform the goal work.");
  await h.session.waitForIdle();
  assert.equal(h.goal()?.status, "complete");
  assert.equal(h.faux.state.callCount, 4, "one failed attempt, native retry, goal continuation, and tool receipt response; no summary request");
  assert.deepEqual(settled, ["complete"]);
  const entries = h.session.sessionManager.getEntries();
  assert.equal(entries.filter((entry) => entry.type === "compaction").length, 1);
  assert.equal(entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "update_goal").length, 1);
});

test("successful stop overflow compaction without a host retry automatically continues exactly once", async (t) => {
  const h = await fixture(t, true);
  const events: Array<{ type: string; reason?: string; willRetry?: boolean }> = [];
  h.session.subscribe((event) => {
    if (event.type === "agent_start" || event.type === "agent_end" || event.type === "agent_settled" || event.type === "compaction_end") {
      events.push({ type: event.type, ...("reason" in event ? { reason: event.reason } : {}), ...("willRetry" in event ? { willRetry: event.willRetry } : {}) });
    }
  });
  const responses = [fauxAssistantMessage("Work finished for this turn, but the goal remains unfinished."), complete(), fauxAssistantMessage("Goal complete.")];
  let requests = 0;
  // Silent-overflow providers can report more input than Pi estimated before admission.
  h.session.agent.streamFunction = (model) => {
    const response = responses[requests++];
    assert.ok(response, "no duplicate continuation request");
    const input = requests === 1 ? 110_000 : 100;
    const message = { ...response, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { ...response.usage, input, totalTokens: input } };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      stream.end();
    });
    return stream;
  };
  await h.session.prompt("Perform the goal work.");
  await waitForGoalCompletion(h);
  assert.equal(requests, 3, "one successful stop, one automatic goal continuation and its tool receipt; no retry or duplicate");
  assert.partialDeepStrictEqual(events.find((event) => event.type === "compaction_end"), { reason: "overflow", willRetry: false });
  const starts = events.filter((event) => event.type === "agent_start").length;
  assert.equal(starts, events.filter((event) => event.type === "agent_end").length, "no synthetic missing-agent_end sequence");
  assert.equal(h.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
});

test("headless cancellation persists a paused goal through native reload and explicit resume", async (t) => {
  const h = await fixture(t);
  h.faux.setResponses([fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Fixture cancellation" })]);
  await h.session.prompt("Start then cancel.");
  assert.equal(h.goal()?.status, "paused");
  const saved = h.goal();
  await h.session.reload();
  assert.equal(h.session.extensionRunner.createContext().hasUI, false);
  assert.deepEqual(h.goal(), saved);
  assert.equal(h.faux.state.callCount, 1, "reload must not silently reactivate a paused headless goal");
  await h.session.prompt("/goal Unapproved replacement");
  assert.deepEqual(h.goal(), saved, "without a confirmation UI replacement is refused, not reported as performed");
  assert.equal(h.faux.state.callCount, 1);
  h.faux.setResponses([complete(), fauxAssistantMessage("Resumed goal complete.")]);
  await resumeAndComplete(h);
  assert.equal(h.goal()?.status, "complete");
  assert.equal(h.goal()?.goalId, saved?.goalId);
  assert.equal(h.faux.state.callCount, 3);
});

test("native exhausted overflow pauses automation and only genuine user input grants another recovery", async (t) => {
  const h = await fixture(t, true);
  const overflow = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 100000 maximum" });
  h.faux.setResponses([overflow(), overflow()]);
  await h.session.prompt("Reach the native overflow retry cap.");
  await h.session.waitForIdle();
  assert.equal(h.goal()?.status, "paused");
  assert.equal(h.faux.state.callCount, 2);
  assert.equal(h.session.sessionManager.getEntries().filter((e) => e.type === "compaction").length, 1);
  await h.session.prompt("/goal resume");
  assert.equal(h.goal()?.status, "paused");
  await h.session.prompt("/goal clear");
  await h.session.prompt("/goal Verify replacement without impersonating user input");
  assert.equal(h.goal()?.status, "paused");
  await h.session.reload();
  await h.session.prompt("/goal resume");
  await h.session.waitForIdle();
  assert.equal(h.faux.state.callCount, 2, "commands and reload must not manufacture native recovery");
  h.faux.setResponses([overflow(), fauxAssistantMessage("Real user recovery succeeded.")]);
  await h.session.prompt("I reduced the context; retry this genuine user request.");
  await h.session.waitForIdle();
  assert.equal(h.faux.state.callCount, 4);
  assert.equal(h.session.sessionManager.getEntries().filter((e) => e.type === "compaction").length, 2, "the genuine user gets a fresh native compact-and-retry");
  h.faux.setResponses([complete(), fauxAssistantMessage("Replacement verified.")]);
  await resumeAndComplete(h);
  assert.equal(h.faux.state.callCount, 6);
  assert.equal(h.session.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "user").length, 2, "automated commands never become native user input");
});

for (const route of ["startup", "resume", "tree"] as const) {
test(`native ${route} restores unfinished overflow recovery as a truthful pause, not an active stall`, async (t) => {
  let snapshot: SessionManager | undefined;
  const h = await fixture(t, true, [(pi) => {
    if (route !== "tree") pi.on("session_compact", (_event, ctx) => {
      const file = ctx.sessionManager.getSessionFile();
      assert.ok(file);
      snapshot = SessionManager.forkFrom(file, ctx.cwd, join(ctx.cwd, "interrupted-recovery"));
    });
  }]);
  h.faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 100000 maximum" }),
    fauxAssistantMessage(fauxToolCall("update_goal", { status: "waiting", reason: "Explorer recovery-check will deliver its report" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Waiting for explorer recovery-check."),
  ]);
  await h.session.prompt("Recover native overflow, then wait for the explorer.");
  await h.session.waitForIdle();
  assert.equal(h.goal()?.status, "waiting");
  const goalId = h.goal()?.goalId;
  const calls = h.faux.state.callCount;
  const statuses: string[] = [];
  let confirms = 0;
  const ui = {
    ...h.session.extensionRunner.getUIContext(),
    setStatus(_key: string, text: string | undefined) { if (text) statuses.push(text); },
    async confirm() { confirms++; return true; },
  };
  let restored = h.session;
  try {
    if (route === "tree") {
      const compact = h.session.sessionManager.getEntries().find((entry) => entry.type === "compaction");
      assert.ok(compact);
      const branch = h.session.sessionManager.getBranch(compact.id);
      assert.equal(reconstructGoal(branch).goal?.status, "active");
      assert.equal(reconstructHostOverflowCapNeedsUserReset(branch), true);
      restored.extensionRunner.setUIContext(ui, "tui");
      const result = await restored.navigateTree(compact.id, { summarize: false });
      assert.equal(result.cancelled, false);
    } else {
      assert.ok(snapshot, "capture native persisted state at compaction, before the retry or any graceful shutdown");
      assert.equal(reconstructGoal(snapshot.getBranch()).goal?.status, "active");
      assert.equal(reconstructHostOverflowCapNeedsUserReset(snapshot.getBranch()), true);
      ({ session: restored } = await createAgentSession({
        cwd: snapshot.getCwd(), agentDir: join(snapshot.getCwd(), "restored-agent"),
        resourceLoader: h.session.resourceLoader, modelRuntime: h.session.modelRuntime,
        model: h.faux.getModel(), settingsManager: h.session.settingsManager,
        sessionManager: snapshot, noTools: "builtin", sessionStartEvent: { type: "session_start", reason: route },
      }));
      await restored.bindExtensions({ mode: "tui", uiContext: ui, onError(error) { throw new Error(error.error); } });
    }
    const goal = reconstructGoal(restored.sessionManager.getBranch()).goal;
    assert.equal(goal?.goalId, goalId);
    assert.equal(goal?.status, "paused");
    assert.match(statuses.at(-1) ?? "", /genuine user message.*\/goal resume/);
    assert.equal(confirms, 0, "a restored recovery pause must not immediately offer automatic resumption");
    await restored.prompt("/goal resume");
    assert.equal(reconstructGoal(restored.sessionManager.getBranch()).goal?.status, "paused");
    assert.equal(h.faux.state.callCount, calls, "restoration and resume cannot impersonate a genuine user reset");
  } finally {
    if (restored !== h.session) {
      await restored.abort();
      await restored.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      restored.dispose();
    }
  }
});
}

for (const route of ["direct", "nested"] as const) {
test(`native ${route} repeated call IDs account the current response once across deferred boundary drafts`, async (t) => {
  let ended = 0;
  const h = await fixture(t, false, [(pi) => {
    if (route === "nested") {
      pi.registerTool({
        name: "goal_wrapper", label: "Goal wrapper", description: "Run goal tools through native nesting",
        parameters: Type.Object({ name: Type.String() }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          const args = params.name === "update_goal" ? { status: "complete" } : {};
          const first = await ctx.executeTool(params.name, args);
          const second = await ctx.executeTool(params.name, args);
          assert.equal(first.isError, false);
          assert.equal(second.isError, false);
          return second.result;
        },
      });
    }
    pi.on("message_end", (event, ctx) => {
      if (event.message.role !== "assistant") return;
      const assistants = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant");
      assert.equal(assistants.length, ended++, "message_end precedes appending the current response");
    });
    pi.on("turn_end", (event, ctx) => {
      const drafts = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "native-draft");
      assert.equal(drafts.length, event.turnIndex, "boundary drafts commit only after handlers return");
      return { entries: [...event.entries, { type: "custom", customType: "native-draft", data: { turn: event.turnIndex } }] };
    });
  }]);
  const response = (name: string, input: number, output: number) => {
    const message = fauxAssistantMessage(fauxToolCall(
      route === "nested" ? "goal_wrapper" : name,
      route === "nested" ? { name } : name === "update_goal" ? { status: "complete" } : {},
    ), { stopReason: "toolUse" });
    const call = message.content.find((part) => part.type === "toolCall");
    assert.ok(call);
    call.id = "reused/call";
    message.usage = { ...message.usage, input, output, totalTokens: input + output };
    return message;
  };
  const responses = [
    response("get_goal", 10, 2),
    response("get_goal", 20, 3),
    response("update_goal", 30, 4),
    fauxAssistantMessage("Goal complete; this receipt is not goal work."),
  ];
  let requests = 0;
  h.session.agent.streamFunction = () => {
    const message = responses[requests++];
    assert.ok(message, "no duplicate goal continuation after completion");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      stream.end();
    });
    return stream;
  };
  const settled: string[] = [];
  h.session.subscribe((event) => { if (event.type === "agent_settled") settled.push(h.goal()?.status ?? "none"); });
  await h.session.prompt("Complete the goal with repeated provider call IDs.");
  await h.session.waitForIdle();
  assert.equal(h.goal()?.status, "complete");
  assert.equal(h.goal()?.usage.tokensUsed, 69, "12 + 23 + 34 tokens, not old call IDs or completion receipt");
  assert.deepEqual(settled, ["complete"]);
  assert.equal(requests, 4);
  const entries = h.session.sessionManager.getEntries();
  assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "native-draft").length, 4);
  const receipt = entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult").at(-1);
  assert.ok(receipt?.type === "message" && receipt.message.role === "toolResult");
  assert.partialDeepStrictEqual(receipt.message.details, { goal: { status: "complete", tokensUsed: 69 } });
  if (route === "nested") {
    assert.partialDeepStrictEqual(receipt.message.nestedCalls, {
      complete: true,
      calls: [
        { id: "reused/call/1", name: "update_goal", status: "ok" },
        { id: "reused/call/2", name: "update_goal", status: "ok" },
      ],
    });
  }
});
}

for (const customCompactor of [false, true]) {
test(`native ${customCompactor ? "custom" : "default"} compaction refreshes only the first normal custom continuation after resume`, async (t) => {
  const objective = "Preserve $$HOME, $&, $` and $' literally <&>.";
  const deliveries: Array<{ content: unknown; full: string; compact: string }> = [];
  const h = await fixture(t, false, [(pi) => {
    pi.on("message_end", (event, ctx) => {
      if (event.message.role !== "custom" || event.message.customType !== CUSTOM_ENTRY_TYPE ||
          (event.message.details as { kind?: unknown })?.kind !== "continuation") return;
      const current = reconstructGoal(ctx.sessionManager.getBranch()).goal;
      assert.ok(current);
      deliveries.push({ content: event.message.content, full: continuationPrompt(current), compact: compactContinuationPrompt(current) });
    });
  }], customCompactor, false, objective);
  await h.session.prompt("/goal pause");
  h.faux.setResponses([
    fauxAssistantMessage("Existing verified work."),
    ...(!customCompactor ? [fauxAssistantMessage("## Goal\nPreserve the verified work.")] : []),
    fauxAssistantMessage("Resumed work; the goal still needs verification."),
    fauxAssistantMessage("Full goal restored; perform the final verification next."),
    complete(), fauxAssistantMessage("Resumed goal complete."),
  ]);
  await h.session.prompt("Record existing verified work.");
  const saved = h.goal();
  assert.ok(saved);
  const callsBeforeCompaction = h.faux.state.callCount;
  await h.session.compact();
  assert.equal(h.faux.state.callCount, callsBeforeCompaction + (customCompactor ? 0 : 1));
  assert.deepEqual(h.goal(), saved, "compaction alone cannot reactivate a paused goal");
  await h.session.reload();
  assert.deepEqual(h.goal(), saved, "reload must retain the pending objective refresh without waking a paused goal");
  const requests: unknown[][] = [];
  const nativeStream = h.session.agent.streamFunction;
  assert.ok(nativeStream);
  h.session.agent.streamFunction = (model, context, options) => {
    requests.push(JSON.parse(JSON.stringify(context.messages)));
    return nativeStream(model, context, options);
  };
  await resumeAndComplete(h);
  const resumed = h.session.sessionManager.getEntries().findLast((entry) => entry.type === "custom_message" && (entry.details as { kind?: string })?.kind === "command_resume");
  assert.ok(resumed?.type === "custom_message");
  assert.equal(resumed.content, continuationPrompt({ ...saved, status: "active" }), "resume stays a public custom delivery with the saved objective");
  assert.equal(deliveries.length, 2, "two normal continuations; compaction adds no passive snapshot or extra scheduled work");
  assert.equal(deliveries[0]?.content, deliveries[0]?.full, "custom continuation is finalized with the full current goal before its first request");
  assert.equal(deliveries[1]?.content, deliveries[1]?.compact, "later automatic continuations return to the compact prompt");
  assert.ok(String(deliveries[0]?.content).includes(escapeXmlText(saved.objective)));
  assert.ok(JSON.stringify(requests[1]?.at(-1)).includes("Preserve $$HOME, $&amp;, $` and $' literally &lt;&amp;&gt;."), "the current provider delivery receives the saved replacement-token literals verbatim");
  assert.equal(requests.length, 4, "resume, two continuations, and completion receipt");
  for (let index = 1; index < requests.length; index += 1) {
    const previous = requests[index - 1]!;
    assert.deepEqual(requests[index]!.slice(0, previous.length), previous, `post-compaction request ${index} preserves the cached prefix`);
  }
  assert.equal(h.goal()?.goalId, saved.goalId);
});
}

test("custom compactor can filter Goal controls through the existing event bus when it registers first", async (t) => {
  let controlsAtConsumer = -1;
  const h = await fixture(t, false, [(pi) => {
    pi.on("session_before_compact", (event) => {
      controlsAtConsumer = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages].filter((message) =>
        message.role === "custom" && message.customType === CUSTOM_ENTRY_TYPE &&
        (message.details as { kind?: string } | undefined)?.kind === "continuation").length;
    });
  }], true, true);
  await h.session.prompt("/goal pause");
  const saved = h.goal();
  assert.ok(saved);
  for (let i = 0; i < 3; i++) await h.session.sendCustomMessage({
    customType: CUSTOM_ENTRY_TYPE, content: compactContinuationPrompt(saved), display: false,
    details: { kind: "continuation", goalId: saved.goalId },
  }, { triggerTurn: false });
  h.faux.setResponses([fauxAssistantMessage("Verified work, not a scheduling command.")]);
  await h.session.prompt("Record substantive work.");
  await h.session.compact();
  assert.equal(controlsAtConsumer, 0, "custom compactor requests the filter before consuming input");
  assert.deepEqual(h.goal(), saved);
});

function oversizedImage() {
  const width = 3000, height = 8;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), data]), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, checksum]);
  };
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((1 + width * 4) * height))), chunk("IEND", Buffer.alloc(0))]);
  return { type: "image" as const, mimeType: "image/png", data: png.toString("base64") };
}

for (const paused of [false, true]) {
test(`native ordinary image input and literal marker data stay unchanged with ${paused ? "a paused" : "an active"} goal`, async (t) => {
  const h = await fixture(t);
  if (paused) await h.session.prompt("/goal pause");
  h.session.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "Prior verified task" }], timestamp: 1 });
  h.session.sessionManager.appendMessage(fauxAssistantMessage("Prior verified work."));
  await h.session.compact();
  const saved = h.goal();
  assert.ok(saved);
  h.faux.setResponses(paused ? [fauxAssistantMessage("User image inspected.")] : [fauxAssistantMessage("User image inspected."), complete(), fauxAssistantMessage("Goal complete.")]);
  const prompts: string[] = [], imageCounts: number[] = [];
  const stream = h.session.agent.streamFunction;
  assert.ok(stream);
  h.session.agent.streamFunction = (model, context, options) => {
    const user = context.messages.find((message) => message.role === "user" && JSON.stringify(message.content).includes("KEEP_GENUINE_IMAGE_CAPTION"));
    if (!user || user.role !== "user") return stream(model, context, options);
    prompts.push(typeof user.content === "string" ? user.content : user.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    imageCounts.push(typeof user.content === "string" ? 0 : user.content.filter((part) => part.type === "image").length);
    return stream(model, context, options);
  };
  const caption = "KEEP_GENUINE_IMAGE_CAPTION";
  const prompt = `<pi_goal_continuation goal_id="${saved.goalId}">\n` + compactContinuationPrompt(saved) + "\n</pi_goal_continuation>\n" + caption;
  await h.session.prompt(prompt, { images: [oversizedImage()] });
  if (!paused) await waitForGoalCompletion(h);
  await h.session.waitForIdle();
  assert.ok(prompts.length > 0, "genuine input must reach the provider");
  assert.ok(prompts[0]?.startsWith(prompt));
  assert.match(prompts[0]!, /\[Image: original 3000x8, displayed at/);
  assert.equal(imageCounts[0], 1);
  assert.doesNotMatch(prompts[0]!, /<untrusted_objective>/);
  if (paused) assert.deepEqual(h.goal(), saved);
});
}

test("native sendUserMessage keeps its compact control, caption and resize notes after compaction", async (t) => {
  const h = await fixture(t);
  h.session.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "Prior verified task" }], timestamp: 1 });
  h.session.sessionManager.appendMessage(fauxAssistantMessage("Prior verified work."));
  await h.session.compact();
  const saved = h.goal();
  assert.ok(saved);
  h.faux.setResponses([fauxAssistantMessage("Image inspected; continue verification."), complete(), fauxAssistantMessage("Goal complete.")]);
  const deliveries: Array<{ text: string; images: number }> = [];
  const stream = h.session.agent.streamFunction;
  assert.ok(stream);
  h.session.agent.streamFunction = (model, context, options) => {
    const user = context.messages.find((message) => message.role === "user" && JSON.stringify(message.content).includes("KEEP_EXTENSION_IMAGE_CAPTION"));
    if (!user || user.role !== "user") return stream(model, context, options);
    deliveries.push({
      text: typeof user.content === "string" ? user.content : user.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
      images: typeof user.content === "string" ? 0 : user.content.filter((part) => part.type === "image").length,
    });
    return stream(model, context, options);
  };
  const caption = "KEEP_EXTENSION_IMAGE_CAPTION";
  await h.session.sendUserMessage([{ type: "text", text: compactContinuationPrompt(saved) }, oversizedImage(), { type: "text", text: caption }]);
  await waitForGoalCompletion(h);
  const first = deliveries[0];
  assert.ok(first);
  assert.ok(first.text.startsWith(compactContinuationPrompt(saved)));
  assert.doesNotMatch(first.text, /<untrusted_objective>|pi_goal_delivery/);
  assert.match(first.text, /KEEP_EXTENSION_IMAGE_CAPTION/);
  assert.match(first.text, /\[Image: original 3000x8, displayed at/);
  assert.equal(first.images, 1);
  const user = h.session.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user");
  assert.ok(user?.type === "message" && user.message.role === "user");
  const persisted = typeof user.message.content === "string" ? user.message.content : user.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.equal(persisted, first.text);
});

for (const pauseBeforeRestore of [true, false]) {
test(`native queue discard exposes only genuine input; automation ${pauseBeforeRestore ? "stays paused" : "recovers with fresh ownership"}`, async (t) => {
  const h = await fixture(t);
  let started!: () => void, release = () => {};
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const providerContexts: string[] = [], sends: unknown[] = [];
  const nativeSend = h.session.sendCustomMessage.bind(h.session);
  h.session.sendCustomMessage = async (message, options) => { sends.push(structuredClone(message)); return nativeSend(message, options); };
  const nativeStream = h.session.agent.streamFunction;
  assert.ok(nativeStream);
  let requests = 0;
  h.session.agent.streamFunction = (model, context, options) => {
    providerContexts.push(JSON.stringify(context.messages));
    if (requests++ > 0) return nativeStream(model, context, options);
    const stream = createAssistantMessageEventStream();
    const message = { ...fauxAssistantMessage("Initial work recorded."), api: model.api, provider: model.provider, model: model.id };
    release = () => { release = () => {}; stream.push({ type: "done", reason: "stop", message }); stream.end(); };
    started();
    return stream;
  };
  h.faux.setResponses([complete(), fauxAssistantMessage("Goal complete.")]);
  const run = h.session.prompt("Initial ordinary input.");
  await firstStarted;
  try {
    await h.session.followUp("KEEP_GENUINE_QUEUED_INPUT");
    await h.session.prompt("/goal pause");
    await h.session.prompt("/goal resume");
    assert.equal(sends.length, 1, "the real custom delivery entered the native queue");
    assert.deepEqual(h.session.getFollowUpMessages(), ["KEEP_GENUINE_QUEUED_INPUT"]);
    if (pauseBeforeRestore) await h.session.prompt("/goal pause");
    const restored = h.session.clearQueue();
    assert.deepEqual(restored, { steering: [], followUp: ["KEEP_GENUINE_QUEUED_INPUT"] });
    const expected = restored.followUp[0]; assert.ok(expected);
    assert.equal(h.session.pendingMessageCount, 0, "the public native owner clears queues, but exposes only real user text");
    release();
    await run;
    if (!pauseBeforeRestore) await waitForGoalCompletion(h);
    await h.session.waitForIdle();
    assert.equal(h.goal()?.status, pauseBeforeRestore ? "paused" : "complete");
    h.faux.setResponses([fauxAssistantMessage("Restored genuine input answered.")]);
    await h.session.prompt(expected);
    await h.session.waitForIdle();
    assert.doesNotMatch(providerContexts.join("\n"), /pi_goal_delivery|pi_goal_continuation|deliveryId|generation/);
    const entries = h.session.sessionManager.getEntries();
    const users = entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
    assert.equal(users.length, 2);
    assert.ok(users.some((entry) => entry.type === "message" && JSON.stringify(entry.message).includes(expected.replaceAll("\n", "\\n"))));
    assert.doesNotMatch(JSON.stringify(entries.filter((entry) => entry.type === "message")), /pi_goal_delivery|pi_goal_continuation/);
  } finally { release(); await run; }
});
}

test("native owned refresh preserves normalized image captions and its consumed intent survives reload", async (t) => {
  const objective = "Preserve $$HOME, $&, $` and $' literally <&>.";
  const prefix = "KEEP_CONTROL_PREFIX\n", suffix = "\nKEEP_CONTROL_SUFFIX";
  let attached = false;
  let normalized: Array<{ type: string }> = [];
  const h = await fixture(t, false, [(pi) => {
    pi.on("message_end", (event, ctx) => {
      if (attached || event.message.role !== "custom" || event.message.customType !== CUSTOM_ENTRY_TYPE ||
          (event.message.details as { kind?: string })?.kind !== "continuation") return;
      const user = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user");
      assert.ok(user?.type === "message" && user.message.role === "user" && Array.isArray(user.message.content));
      const content = user.message.content;
      normalized = structuredClone(content);
      attached = true;
      assert.equal(typeof event.message.content, "string");
      return { message: { ...event.message, content: [{ type: "text", text: prefix + String(event.message.content) + suffix }, ...content] } };
    });
  }], true, true, objective);
  await h.session.prompt("/goal pause");
  h.faux.setResponses([fauxAssistantMessage("Image recorded.")]);
  await h.session.prompt("KEEP_NORMALIZED_OWNED_CAPTION", { images: [oversizedImage()] });
  await h.session.compact();
  h.faux.setResponses([
    fauxAssistantMessage("Resumed work; ask the explorer to finish verification."),
    fauxAssistantMessage(fauxToolCall("update_goal", { status: "waiting", reason: "Explorer beta will deliver its verification report" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Waiting for explorer beta."),
  ]);
  await h.session.prompt("/goal resume");
  const deadline = Date.now() + 5_000;
  while (h.goal()?.status !== "waiting") {
    assert.ok(Date.now() < deadline);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await h.session.waitForIdle();
  const first = h.session.sessionManager.getEntries().find((entry) => entry.type === "custom_message" &&
    (entry.details as { objectiveRefresh?: boolean })?.objectiveRefresh === true);
  assert.ok(first?.type === "custom_message" && Array.isArray(first.content));
  assert.deepEqual(first.content.slice(1), normalized, "Goal leaves native caption, resized image bytes and coordinate note untouched");
  assert.match(JSON.stringify(first.content), /KEEP_NORMALIZED_OWNED_CAPTION/);
  assert.match(JSON.stringify(first.content), /Image: original 3000x8, displayed at/);
  assert.match(JSON.stringify(first.content[0]), /untrusted_objective/);
  const control = first.content[0];
  assert.ok(control?.type === "text");
  assert.ok(control.text.startsWith(prefix) && control.text.endsWith(suffix));
  assert.ok(control.text.includes(escapeXmlText(objective)), "text-block refresh preserves all saved replacement-token literals");
  await h.session.reload();
  h.faux.setResponses([fauxAssistantMessage("Explorer verification integrated; finish the audit."), complete(), fauxAssistantMessage("Goal complete.")]);
  await h.session.sendCustomMessage({ customType: "explorer-beta", content: "Explorer beta verified every requirement.", display: true }, { triggerTurn: true });
  await waitForGoalCompletion(h);
  const controls = h.session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" &&
    (entry.details as { kind?: string })?.kind === "continuation");
  assert.equal(controls.length, 2);
  assert.equal(controls.filter((entry) => entry.type === "custom_message" && (entry.details as { objectiveRefresh?: boolean })?.objectiveRefresh === true).length, 1);
  const last = controls.at(-1);
  assert.ok(last?.type === "custom_message");
  assert.doesNotMatch(JSON.stringify(last.content), /untrusted_objective|KEEP_NORMALIZED_OWNED_CAPTION/);
});

for (const pendingGenuine of [true, false]) {
test(`native same-goal generations and duplicates settle with ${pendingGenuine ? "genuine input queued" : "only custom input queued"}`, async (t) => {
  const finalized: Array<{ content: unknown; details: unknown }> = [];
  const h = await fixture(t, false, [(pi) => {
    pi.on("message_end", (event) => {
      if (event.message.role === "custom" && event.message.customType === CUSTOM_ENTRY_TYPE) {
        finalized.push({ content: structuredClone(event.message.content), details: structuredClone(event.message.details) });
      }
    });
  }]);
  const sent: Array<Parameters<typeof h.session.sendCustomMessage>[0]> = [];
  const send = h.session.sendCustomMessage.bind(h.session);
  h.session.sendCustomMessage = async (message, options) => { sent.push(structuredClone(message)); return send(message, options); };
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const requests: string[] = [];
  h.faux.setResponses([
    async (context) => { requests.push(JSON.stringify(context.messages)); started(); await held; return fauxAssistantMessage("Initial work recorded."); },
    ...(pendingGenuine ? [(context: Context) => { requests.push(JSON.stringify(context.messages)); return fauxAssistantMessage("Cancelled control ignored."); }] : []),
    (context) => { requests.push(JSON.stringify(context.messages)); return complete(); },
    (context) => { requests.push(JSON.stringify(context.messages)); return fauxAssistantMessage("Verified work and user image answered."); },
    (context) => { requests.push(JSON.stringify(context.messages)); return fauxAssistantMessage("Genuine queued input answered."); },
  ]);
  const run = h.session.prompt("Initial work.");
  await ready;
  try {
    await h.session.prompt("/goal pause");
    await h.session.prompt("/goal resume");
    await h.session.prompt("/goal pause");
    await h.session.prompt("/goal resume");
    assert.equal(sent.length, 2);
    const old = sent[0]!, current = sent[1]!;
    const a = old.details as { goalId: string; generation: string; deliveryId: string };
    const b = current.details as typeof a;
    assert.equal(a.goalId, b.goalId);
    assert.notEqual(a.generation, b.generation);
    assert.notEqual(a.deliveryId, b.deliveryId);
    const genuine = `<pi_goal_continuation goal_id="${a.goalId}">\nKEEP_QUEUED_GENUINE_CAPTION\n</pi_goal_continuation>`;
    if (pendingGenuine) await h.session.followUp(genuine, [oversizedImage()]);
    release();
    await run;
    await h.session.waitForIdle();
    if (!pendingGenuine) await waitForGoalCompletion(h);
    if (pendingGenuine) assert.ok(requests.some((request) => request.includes("KEEP_QUEUED_GENUINE_CAPTION") && request.includes('"type":"image"')), "native queued genuine image input must reach the provider");
    assert.equal(h.goal()?.status, "complete");
    assert.ok(finalized.some((m) => (m.details as { deliveryId?: string; lifecycle?: string }).deliveryId === a.deliveryId && (m.details as { lifecycle?: string }).lifecycle === "cancelled"));
    assert.ok(finalized.some((m) => {
      const details = m.details as { deliveryId?: string; generation?: string; lifecycle?: string };
      return details.deliveryId !== a.deliveryId && details.generation === b.generation && details.lifecycle === "delivered";
    }), "only the current activation can deliver work, including fresh recovery after native queue discard");
    const calls = h.faux.state.callCount;
    const originalHistory = structuredClone(h.session.messages);
    await h.session.sendCustomMessage(current, { triggerTurn: true });
    await h.session.waitForIdle();
    assert.equal(h.faux.state.callCount, calls, "an exact duplicate cannot run again");
    assert.deepEqual(h.session.messages.slice(0, originalHistory.length), originalHistory);
    await h.session.reload();
    await h.session.sendCustomMessage(old, { triggerTurn: true });
    await h.session.waitForIdle();
    assert.equal(h.faux.state.callCount, calls, "a new runtime cannot revive old ownership");
    h.faux.setResponses([fauxAssistantMessage("New genuine request answered.")]);
    await h.session.prompt(genuine, { images: [oversizedImage()] });
    await h.session.waitForIdle();
    assert.equal(h.faux.state.callCount, calls + 1);
  } finally { release(); await run; }
});
}

const waitingReason = "Explorer alpha will deliver its report as a message";
const waitForExplorer = () => fauxAssistantMessage(fauxToolCall("update_goal", { status: "waiting", reason: waitingReason }), { stopReason: "toolUse" });

for (const transition of ["complete", "clear", "replace"] as const) {
test(`native ${transition} retires queued ownership without losing genuine image input`, async (t) => {
  const h = await fixture(t);
  let release!: () => void;
  let held!: () => void;
  const ready = new Promise<void>((resolve) => { held = resolve; });
  const requests: string[] = [];
  const respond = (context: Context) => {
    const request = JSON.stringify(context.messages);
    requests.push(request);
    return transition === "replace" && request.includes("KEEP_CANCELLED_GENERATION_INPUT") && h.goal()?.status === "active" ?
      complete() : fauxAssistantMessage("Only current work and genuine input are runnable.");
  };
  h.faux.setResponses([
    async () => { held(); await new Promise<void>((resolve) => { release = resolve; }); return fauxAssistantMessage("Original work finished."); },
    respond, respond, respond,
  ]);
  const run = h.session.prompt("Advance original work.");
  await ready;
  try {
    await h.session.prompt("/goal pause");
    await h.session.prompt("/goal resume");
    const runner = h.session.extensionRunner;
    if (transition === "clear") await h.session.prompt("/goal clear");
    else {
      const name = transition === "replace" ? "create_goal" : "update_goal";
      const tool = runner.getToolDefinition(name); assert.ok(tool);
      const params = transition === "replace" ? { objective: "Replacement goal only", replace_existing: true } : { status: "complete" };
      await tool.execute("transition", params, undefined, undefined, runner.createToolContext("transition", undefined));
    }
    await h.session.followUp("KEEP_CANCELLED_GENERATION_INPUT", [oversizedImage()]);
    release();
    await run;
    if (transition === "replace") await waitForGoalCompletion(h);
    await h.session.waitForIdle();
    assert.ok(requests.some((request) => request.includes("KEEP_CANCELLED_GENERATION_INPUT") && request.includes('"type":"image"')));
    assert.ok(requests.every((request) => !request.includes("untrusted_objective")), "retired original command prompt never reaches the provider");
    const cancelled = h.session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" &&
      (entry.details as { lifecycle?: string })?.lifecycle === "cancelled");
    assert.equal(cancelled.length, 1, "the stale delivery is cancelled and persisted exactly once");
    assert.equal(h.goal()?.status ?? null, transition === "clear" ? null : "complete");
  } finally { release(); await run; }
});
}

test("native hidden continuation can declare waiting, survive maintenance, and finish on a background result", async (t) => {
  const h = await fixture(t);
  h.faux.setResponses([
    fauxAssistantMessage("The explorer is running; its report will arrive on its own."),
    waitForExplorer(), fauxAssistantMessage("Waiting for the explorer's result; no polling."),
  ]);
  await h.session.prompt("Integrate the explorer report when it arrives.");
  await h.session.waitForIdle();
  const saved = h.goal();
  assert.equal(saved?.status, "waiting");
  assert.equal(saved?.waitingReason, waitingReason);
  assert.equal(h.faux.state.callCount, 3, "at most one hidden continuation declares the wait, then its tool receipt");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(h.faux.state.callCount, 3, "waiting must not run another provider call");
  await h.session.compact();
  await h.session.reload();
  assert.deepEqual(h.goal(), saved);
  const file = h.session.sessionManager.getSessionFile();
  assert.ok(file);
  const fork = SessionManager.forkFrom(file, h.session.sessionManager.getCwd(), join(h.session.sessionManager.getSessionDir(), "waiting-fork"));
  assert.deepEqual(reconstructGoal(fork.getBranch()).goal, saved);
  assert.equal(h.faux.state.callCount, 3, "maintenance does not wake a wait");

  h.faux.setResponses([complete(), fauxAssistantMessage("Explorer integrated and verified.")]);
  await h.session.sendCustomMessage({ customType: "explorer-result", content: "Explorer alpha report: all verification passed.", display: true }, { triggerTurn: true });
  await h.session.waitForIdle();
  assert.equal(h.goal()?.goalId, saved?.goalId);
  assert.equal(h.goal()?.status, "complete");
  assert.equal(h.goal()?.waitingReason, undefined);
  const response = h.session.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "toolUse");
  assert.ok(response?.type === "message" && response.message.role === "assistant");
  const tokens = response.message.usage.input + response.message.usage.output;
  assert.ok(tokens > 0);
  assert.equal(h.goal()?.usage.tokensUsed, (saved?.usage.tokensUsed ?? 0) + tokens, "first resumed response is accounted exactly once, not its completion receipt");
  assert.equal(h.faux.state.callCount, 5);
});

test("native ordinary user input automatically resumes waiting and can complete the goal", async (t) => {
  const h = await fixture(t);
  h.faux.setResponses([waitForExplorer(), fauxAssistantMessage("Waiting for the report.")]);
  await h.session.prompt("Work until the explorer is needed.");
  await h.session.waitForIdle();
  assert.equal(h.goal()?.status, "waiting");
  h.faux.setResponses([complete(), fauxAssistantMessage("User supplied the report; goal complete.")]);
  await h.session.prompt("Here is the explorer report. All requirements are verified.");
  await h.session.waitForIdle();
  assert.equal(h.goal()?.status, "complete");
  assert.equal(h.goal()?.waitingReason, undefined);
  assert.equal(h.faux.state.callCount, 4);
});

for (const route of ["custom", "user"] as const) {
test(`native ${route} input steered during the waiting tool wakes its next turn`, async (t) => {
  let delivered = false;
  const h = await fixture(t, false, [(pi) => {
    pi.on("tool_execution_end", (event) => {
      if (event.toolName === "update_goal" && !delivered) {
        delivered = true;
        if (route === "custom") {
          pi.sendMessage({ customType: "explorer-result", content: "Explorer alpha has finished; verification passed.", display: true }, { triggerTurn: true, deliverAs: "steer" });
        } else {
          pi.sendUserMessage("Here is explorer alpha's verified report.", { deliverAs: "steer" });
        }
      }
    });
  }]);
  h.faux.setResponses([waitForExplorer(), complete(), fauxAssistantMessage("Steered report integrated; goal complete.")]);
  await h.session.prompt("Wait for the running explorer's report.");
  await h.session.waitForIdle();
  assert.equal(delivered, true);
  assert.equal(h.goal()?.status, "complete");
  assert.equal(h.goal()?.waitingReason, undefined);
  assert.equal(h.faux.state.callCount, 3, "the steered result is the wake, not another hidden continuation");
});

}

test("native idle notifications and goal bookkeeping cannot reactivate a waiting goal", async (t) => {
  const h = await fixture(t);
  h.faux.setResponses([fauxAssistantMessage("Work advanced."), waitForExplorer(), fauxAssistantMessage("Waiting for the report.")]);
  await h.session.prompt("Work until the explorer is needed.");
  await h.session.waitForIdle();
  const saved = h.goal();
  assert.ok(saved);
  assert.equal(saved.status, "waiting");
  const callsBeforeNotification = h.faux.state.callCount;
  await h.session.sendCustomMessage({ customType: "display-only-notification", content: "No new work", display: true }, { triggerTurn: false });
  await h.session.waitForIdle();
  assert.deepEqual(h.goal(), saved, "a display-only external notification does not start work or wake a wait");
  assert.equal(h.faux.state.callCount, callsBeforeNotification);
  h.faux.setResponses([fauxAssistantMessage("Bookkeeping only.")]);
  await h.session.sendCustomMessage({ customType: CUSTOM_ENTRY_TYPE, content: "Budget bookkeeping", display: false, details: { kind: "budget_limit", goalId: saved.goalId } }, { triggerTurn: true });
  await h.session.waitForIdle();
  assert.deepEqual(h.goal(), saved);
  const calls = h.faux.state.callCount;
  const previous = h.session.messages.find((m) => m.role === "custom" && (m.details as { kind?: string })?.kind === "continuation");
  assert.ok(previous?.role === "custom");
  await h.session.sendCustomMessage(previous, { triggerTurn: true });
  await h.session.waitForIdle();
  assert.deepEqual(h.goal(), saved);
  assert.equal(h.faux.state.callCount, calls, "a stale goal continuation is cancelled before the provider");
});

test("native goal continuations and completion resend every earlier provider message unchanged", async (t) => {
  const h = await fixture(t);
  const responses = [
    fauxAssistantMessage("Step one done; the goal continues."),
    fauxAssistantMessage("Step two done; the goal continues."),
    fauxAssistantMessage("Step three done; the goal continues."),
    complete(),
    fauxAssistantMessage("Goal complete."),
  ];
  const requests: unknown[][] = [];
  h.session.agent.streamFunction = (model, context) => {
    // Prompt caches match this request prefix exactly, including the system prompt and tools it carries.
    requests.push(JSON.parse(JSON.stringify(context.messages)));
    const response = responses[requests.length - 1];
    assert.ok(response, "no extra provider request");
    const message = { ...response, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      stream.end();
    });
    return stream;
  };
  await h.session.prompt("Work through the goal one step per turn.");
  await waitForGoalCompletion(h);
  assert.equal(requests.length, responses.length, "three automatic continuations, completion and its receipt");
  for (let index = 1; index < requests.length; index += 1) {
    const previous = requests[index - 1]!, current = requests[index]!;
    assert.deepEqual(current.slice(0, previous.length), previous, `request ${index} resends request ${index - 1} unchanged`);
  }
});
