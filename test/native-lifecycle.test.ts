import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { createAssistantMessageEventStream, fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, type UserMessage } from "@earendil-works/pi-ai";
import { AgentSessionRuntime, createAgentSession, DefaultResourceLoader, InteractiveMode, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import goalExtension from "../src/index.ts";
import { compactContinuationPrompt, escapeXmlText } from "../src/prompts.ts";
import { GOAL_COMPACTION_INPUT_EVENT } from "../src/goal-compaction.ts";
import { reconstructGoal } from "../src/state.ts";
import { agentEndMessagesIncludeQueuedGoalWork } from "../src/queued-goal-work.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";

async function fixture(t: TestContext, recover = false, extraFactories: ExtensionFactory[] = [], customCompactor = true, consumerFirst = false) {
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
  await create.execute("create", { objective: "Verify native lifecycle" }, undefined, undefined, runner.createToolContext("create", undefined));
  const goal = () => reconstructGoal(session.sessionManager.getBranch()).goal;
  return { session, faux, goal, agentDir };
}

const complete = () => fauxAssistantMessage(fauxToolCall("update_goal", { status: "complete" }), { stopReason: "toolUse" });

// Older sessions may contain these notices; new requests no longer generate them.
const legacySupersededContinuation = (goalId: string) => [
  "Superseded hidden goal continuation bookkeeping.",
  `Goal id: ${goalId}.`,
  "A newer continuation for this active goal appears later in context.",
  "Ignore this message; do not perform work for it or mention it to the user.",
].join("\n");

for (const kind of ["continuation", "superseded_continuation", "stale_continuation"] as const) {
test(`native idle ${kind} preserves goal bookkeeping and subsequent user input`, async (t) => {
  const h = await fixture(t);
  const goal = h.goal();
  assert.ok(goal);
  if (kind === "stale_continuation") {
    const runner = h.session.extensionRunner;
    const update = runner.getToolDefinition("update_goal");
    assert.ok(update);
    await update.execute("complete", { status: "complete" }, undefined, undefined, runner.createToolContext("complete", undefined));
  }
  h.faux.setResponses(kind === "continuation"
    ? [fauxAssistantMessage(fauxToolCall("get_goal", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Only inspected status.")]
    : [complete(), fauxAssistantMessage("Goal complete.")]);
  await h.session.sendCustomMessage({
    customType: CUSTOM_ENTRY_TYPE,
    content: kind === "superseded_continuation" ? legacySupersededContinuation(goal.goalId) : compactContinuationPrompt(goal),
    display: false,
    details: { kind: kind === "stale_continuation" ? "continuation" : kind, goalId: goal.goalId },
  }, { triggerTurn: true });
  await h.session.waitForIdle();
  assert.equal(h.goal()?.status, kind === "continuation" ? "paused" : "complete");
  assert.equal(h.faux.state.callCount, kind === "stale_continuation" ? 0 : 2,
    "stale work is aborted before the provider; active or superseded work runs without duplicate continuation");
  const saved = h.goal();
  const calls = h.faux.state.callCount;
  h.faux.setResponses([fauxAssistantMessage("Ordinary user input still works.")]);
  await h.session.prompt("Answer an unrelated user question.");
  await h.session.waitForIdle();
  assert.deepEqual(h.goal(), saved, "user input must not reactivate a stopped goal or inherit a stale abort");
  assert.equal(h.faux.state.callCount, calls + 1);
});
}

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
test(`native ${customCompactor ? "custom" : "default"} compaction restores the full goal on normal resume without waking it early`, async (t) => {
  const h = await fixture(t, false, [], customCompactor);
  await h.session.prompt("/goal pause");
  h.faux.setResponses([
    fauxAssistantMessage("Existing verified work."),
    ...(!customCompactor ? [fauxAssistantMessage("## Goal\nPreserve the verified work.")] : []),
    complete(), fauxAssistantMessage("Resumed goal complete."),
  ]);
  await h.session.prompt("Record existing verified work.");
  const saved = h.goal();
  assert.ok(saved);
  const callsBeforeCompaction = h.faux.state.callCount;
  await h.session.compact();
  assert.equal(h.faux.state.callCount, callsBeforeCompaction + (customCompactor ? 0 : 1));
  assert.deepEqual(h.goal(), saved, "compaction alone cannot reactivate a paused goal");
  await resumeAndComplete(h);
  const restored = h.session.sessionManager.getBranch().filter((entry) => entry.type === "message" &&
    entry.message.role === "user" && (typeof entry.message.content === "string"
      ? entry.message.content.includes(`<untrusted_objective>\n${escapeXmlText(saved.objective)}\n</untrusted_objective>`)
      : entry.message.content.some((part) => part.type === "text" &&
        part.text.includes(`<untrusted_objective>\n${escapeXmlText(saved.objective)}\n</untrusted_objective>`))));
  assert.equal(restored.length, 1, "normal user-follow-up resume carries the full saved goal once");
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
test(`native resized-image pasted marker remains genuine user input with ${paused ? "a paused" : "an active"} goal`, async (t) => {
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
    const user = context.messages.findLast((message) => message.role === "user");
    assert.ok(user?.role === "user");
    prompts.push(typeof user.content === "string" ? user.content : user.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    imageCounts.push(typeof user.content === "string" ? 0 : user.content.filter((part) => part.type === "image").length);
    return stream(model, context, options);
  };
  const caption = "KEEP_GENUINE_IMAGE_CAPTION";
  const prompt = compactContinuationPrompt(saved) + "\n" + caption;
  await h.session.prompt(prompt, { images: [oversizedImage()] });
  if (!paused) await waitForGoalCompletion(h);
  await h.session.waitForIdle();
  assert.ok(prompts.length > 0, "genuine input must reach the provider");
  assert.ok(prompts[0]?.startsWith(prompt));
  assert.match(prompts[0]!, /\[Image: original 3000x8, displayed at/);
  assert.equal(imageCounts[0], 1);
  assert.doesNotMatch(prompts[0]!, /<untrusted_objective>/);
  if (paused) assert.deepEqual(h.goal(), saved);
  else assert.match(prompts[1]!, /<untrusted_objective>/, "the actual Goal continuation still restores the full objective");
});
}

test("native sendUserMessage normalization preserves caption and resize notes during full-goal restoration", async (t) => {
  const h = await fixture(t);
  h.session.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "Prior verified task" }], timestamp: 1 });
  h.session.sessionManager.appendMessage(fauxAssistantMessage("Prior verified work."));
  await h.session.compact();
  const saved = h.goal();
  assert.ok(saved);
  h.faux.setResponses([complete(), fauxAssistantMessage("Goal complete.")]);
  let deliveredText = "", deliveredImages = 0;
  const stream = h.session.agent.streamFunction;
  assert.ok(stream);
  h.session.agent.streamFunction = (model, context, options) => {
    const user = context.messages.findLast((message) => message.role === "user");
    assert.ok(user?.role === "user");
    deliveredText = typeof user.content === "string" ? user.content : user.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    deliveredImages = typeof user.content === "string" ? 0 : user.content.filter((part) => part.type === "image").length;
    return stream(model, context, options);
  };
  const caption = "KEEP_EXTENSION_IMAGE_CAPTION";
  await h.session.sendUserMessage([{ type: "text", text: compactContinuationPrompt(saved) }, oversizedImage(), { type: "text", text: caption }]);
  await waitForGoalCompletion(h);
  assert.match(deliveredText, /<untrusted_objective>/);
  assert.match(deliveredText, /KEEP_EXTENSION_IMAGE_CAPTION/);
  assert.match(deliveredText, /\[Image: original 3000x8, displayed at/);
  assert.equal(deliveredImages, 1);
  const user = h.session.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user");
  assert.ok(user?.type === "message" && user.message.role === "user");
  const persisted = typeof user.message.content === "string" ? user.message.content : user.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.equal(persisted, deliveredText);
});

for (const scenario of ["unrelated", "A", "B", "steer"] as const) {
test(`native delivery provenance ${scenario}: queued genuine input and stale resume remain distinct`, async (t) => {
  const extensionInputs: string[] = [];
  const terminalUserOwnership: boolean[] = [];
  const h = await fixture(t, false, [(pi) => {
    pi.on("input", (event) => { if (event.source === "extension") extensionInputs.push(event.text); });
    pi.on("agent_end", (event) => {
      for (const message of event.messages) {
        if (message.role === "user") terminalUserOwnership.push(agentEndMessagesIncludeQueuedGoalWork([message]));
      }
    });
  }], true, true);
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const delivered: string[] = [];
  let requests = 0;
  h.session.agent.streamFunction = (model, context) => {
    const user = context.messages.findLast((message) => message.role === "user");
    assert.ok(user?.role === "user");
    delivered.push(typeof user.content === "string" ? user.content : user.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    const message = { ...fauxAssistantMessage("Ordinary input answered."), api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
    const stream = createAssistantMessageEventStream();
    const done = () => { stream.push({ type: "done", reason: "stop", message }); stream.end(); };
    if (requests++ === 0) { release = done; started(); }
    else queueMicrotask(done);
    return stream;
  };
  const run = h.session.prompt("Initial ordinary user input.");
  await firstStarted;
  await h.session.prompt("/goal pause");
  let genuine: string;
  let visibleGenuine: string;
  if (scenario === "A") {
    const saved = h.goal();
    assert.ok(saved);
    genuine = compactContinuationPrompt(saved) + "\nKEEP_GENUINE_INPUT";
    visibleGenuine = genuine;
    await h.session.followUp(genuine);
    await h.session.followUp("An unrelated question");
  } else {
    await h.session.prompt("/goal resume");
    const deadline = Date.now() + 5_000;
    while (h.session.pendingMessageCount === 0) {
      assert.ok(Date.now() < deadline, "resume must enter the native follow-up queue");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // Use the actual queued delivery, not a newly rendered prompt (usage may differ).
    const queuedResume = h.session.getFollowUpMessages()[0];
    assert.ok(queuedResume);
    await h.session.prompt("/goal pause");
    genuine = scenario === "unrelated" ? "An unrelated question" : queuedResume;
    // Transport provenance is not user text. The expected visible content is the
    // exact resume input captured before Goal's input transform, not a re-render.
    visibleGenuine = scenario === "unrelated" ? genuine : extensionInputs.at(-1)!;
    assert.ok(visibleGenuine);
    if (scenario === "steer") await h.session.steer(genuine);
    else await h.session.followUp(genuine);
  }
  release();
  await run;
  await h.session.waitForIdle();
  assert.equal(h.goal()?.status, "paused");
  const users = h.session.sessionManager.getBranch().flatMap((entry) =>
    entry.type === "message" && entry.message.role === "user"
      ? [typeof entry.message.content === "string" ? entry.message.content : entry.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")]
      : []);
  if (scenario === "A") {
    assert.equal(users[1], genuine, "A: later input must not revoke the earlier genuine delivery");
    assert.equal(users[2], "An unrelated question");
    assert.ok(delivered.includes(genuine), "A: genuine control-shaped input reaches the provider unchanged");
  } else {
    assert.match(users[scenario === "steer" ? 2 : 1] ?? "", /^A queued hidden goal continuation was stale/, "B: the owned delivery cannot inherit the genuine input's identity");
    assert.equal(users[scenario === "steer" ? 1 : 2], visibleGenuine, "the genuine delivery must retain its own identity regardless of queue order");
    assert.ok(delivered.includes(visibleGenuine), "genuine input reaches the provider after stale cancellation");
  }
  // Preserve native queue policy: a mixed run may send the cancellation notice
  // instead of aborting runnable work. It must never send the stale control.
  const cancellation = scenario === "A" ? undefined : users[scenario === "steer" ? 2 : 1];
  assert.deepEqual(delivered.filter((text) => text !== cancellation), scenario === "A"
    ? ["Initial ordinary user input.", visibleGenuine, "An unrelated question"]
    : ["Initial ordinary user input.", visibleGenuine],
    "each genuine input reaches the provider once; owned stale work can only be a cancellation notice");
  assert.deepEqual(terminalUserOwnership, scenario === "A" ? [false, false, false]
    : scenario === "steer" ? [false, false, true] : [false, true, false],
    "finalized agent_end messages retain only their own delivery's ownership, not text identity");
  assert.doesNotMatch(JSON.stringify(h.session.sessionManager.getEntries()), /pi_goal_delivery/);
  assert.doesNotMatch(JSON.stringify(delivered), /pi_goal_delivery/);
});
}

for (const discard of ["handled", "clearQueue"] as const) {
test(`native ${discard} discards ownership with its delivery, not a later identical input`, async (t) => {
  let queuedText = "";
  const h = await fixture(t, false, [(pi) => {
    pi.on("input", (event) => {
      if (event.source === "extension") {
        queuedText = event.text;
        if (discard === "handled") return { action: "handled" };
      }
      return undefined;
    });
  }]);
  let started!: () => void, release!: () => void;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const delivered: string[] = [];
  h.session.agent.streamFunction = (model, context) => {
    const user = context.messages.findLast((message) => message.role === "user");
    assert.ok(user?.role === "user");
    delivered.push(typeof user.content === "string" ? user.content : user.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    const message = { ...fauxAssistantMessage("Ordinary input answered."), api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
    const stream = createAssistantMessageEventStream();
    const done = () => { stream.push({ type: "done", reason: "stop", message }); stream.end(); };
    if (delivered.length === 1) { release = done; started(); } else queueMicrotask(done);
    return stream;
  };
  const run = h.session.prompt("Initial ordinary input.");
  await firstStarted;
  const saved = h.goal();
  assert.ok(saved);
  const visible = compactContinuationPrompt(saved) + "\nKEEP_DISCARDED_INPUT";
  await h.session.sendUserMessage(visible, { deliverAs: "followUp" });
  assert.ok(queuedText);
  if (discard === "clearQueue") {
    assert.deepEqual(h.session.getFollowUpMessages(), [queuedText]);
    assert.deepEqual(h.session.clearQueue().followUp, [queuedText]);
  }
  assert.equal(h.session.pendingMessageCount, 0);
  await h.session.prompt("/goal pause");
  await h.session.followUp(queuedText);
  await h.session.followUp("Another genuine input");
  release();
  await run;
  await h.session.waitForIdle();
  assert.deepEqual(delivered, ["Initial ordinary input.", visible, "Another genuine input"]);
  const entries = JSON.stringify(h.session.sessionManager.getEntries());
  assert.doesNotMatch(entries, /pi_goal_delivery|queued hidden goal continuation was stale/);
  assert.equal(h.goal()?.status, "paused");
});
}

test("native restored editor input removes every joined delivery header without acquiring ownership", async (t) => {
  const h = await fixture(t);
  const runtime = new AgentSessionRuntime(h.session, {
    cwd: h.session.sessionManager.getCwd(), agentDir: h.agentDir,
    settingsManager: h.session.settingsManager, modelRuntime: h.session.modelRuntime,
    resourceLoader: h.session.resourceLoader, diagnostics: [],
  }, async () => { throw new Error("This test must not replace the session"); });
  // Infer the adapter and check it at InteractiveMode's Terminal boundary: current
  // hosts require program status, while older supported types do not declare it.
  const terminal = {
    start() { assert.fail("This test must not start terminal IO"); }, stop() {},
    async drainInput() {}, write() {}, columns: 100, rows: 30, kittyProtocolActive: false,
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
    clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  // Construct the real editor/queue owner, but do not start its CLI loop, IO or
  // startup checks. Invoke the native restore method; never recreate its join logic.
  const mode = new InteractiveMode(runtime, { terminal, tuiMode: "regular" });
  const editor: unknown = Reflect.get(mode, "editor");
  const restoreToEditor: unknown = Reflect.get(mode, "restoreQueuedMessagesToEditor");
  assert.ok(editor && typeof editor === "object" &&
    "getText" in editor && typeof editor.getText === "function" &&
    "setText" in editor && typeof editor.setText === "function");
  assert.ok(typeof restoreToEditor === "function");
  let started!: () => void, release = () => {};
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const delivered: string[] = [], providerContexts: string[] = [];
  h.session.agent.streamFunction = (model, context) => {
    providerContexts.push(JSON.stringify(context.messages));
    const user = context.messages.findLast((message) => message.role === "user");
    assert.ok(user?.role === "user");
    delivered.push(typeof user.content === "string" ? user.content : user.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    const message = { ...fauxAssistantMessage("Ordinary input answered."), api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
    const stream = createAssistantMessageEventStream();
    const done = () => { stream.push({ type: "done", reason: "stop", message }); stream.end(); };
    if (delivered.length === 1) { release = () => { release = () => {}; done(); }; started(); }
    else queueMicrotask(done);
    return stream;
  };
  const run = h.session.prompt("Initial ordinary input.");
  await firstStarted;
  try {
    const saved = h.goal();
    assert.ok(saved);
    const genuine = "KEEP_GENUINE_QUEUED_INPUT";
    const controls = ["KEEP_CAPTION_ONE", "KEEP_CAPTION_TWO"].map((caption) => compactContinuationPrompt(saved) + "\n" + caption);
    await h.session.followUp(genuine);
    for (const control of controls) await h.session.sendUserMessage(control, { deliverAs: "followUp" });
    await h.session.prompt("/goal pause");
    editor.setText("KEEP_EDITOR_DRAFT");
    assert.equal(restoreToEditor.call(mode), 3);
    const restored: unknown = editor.getText();
    assert.ok(typeof restored === "string");
    assert.ok(restored.startsWith(genuine + "\n\n<pi_goal_delivery"), "native restore puts an owned header after genuine text");
    assert.equal(h.session.pendingMessageCount, 0);
    release();
    await run;
    await h.session.waitForIdle();
    await h.session.prompt(restored);
    await h.session.waitForIdle();
    const expected = [genuine, ...controls, "KEEP_EDITOR_DRAFT"].join("\n\n");
    assert.deepEqual({
      headerInProvider: /pi_goal_delivery/.test(providerContexts.join("\n")),
      headerStored: /pi_goal_delivery/.test(JSON.stringify(h.session.sessionManager.getEntries())),
    }, { headerInProvider: false, headerStored: false });
    assert.deepEqual(delivered, ["Initial ordinary input.", expected]);
    const users = h.session.messages.filter((message) => message.role === "user");
    assert.equal(users.length, 2, "restored input is one new delivery, not the discarded Goal work");
    assert.equal(agentEndMessagesIncludeQueuedGoalWork(users), false);
    assert.equal(h.goal()?.status, "paused");
  } finally {
    release();
    await run;
    mode.stop();
  }
});

for (const copyBeforeGoal of [false, true]) {
test(`native finalized delivery ownership survives ${copyBeforeGoal ? "a preceding shallow-copy handler" : "without a preceding copy"}`, async (t) => {
  const originals: UserMessage[] = [], terminalOwnership: boolean[] = [];
  const h = await fixture(t, false, [(pi) => {
    pi.on("message_start", (event) => { if (event.message.role === "user") originals.push(event.message); });
    if (copyBeforeGoal) pi.on("message_end", (event) => ({ message: { ...event.message } }));
    pi.on("agent_end", (event) => {
      for (const message of event.messages) {
        if (message.role === "user") terminalOwnership.push(agentEndMessagesIncludeQueuedGoalWork([message]));
      }
    });
  }], true, true);
  const saved = h.goal();
  assert.ok(saved);
  const control = compactContinuationPrompt(saved);
  const providerContexts: string[] = [];
  const stream = h.session.agent.streamFunction;
  assert.ok(stream);
  h.session.agent.streamFunction = (model, context, options) => {
    providerContexts.push(JSON.stringify(context.messages));
    return stream(model, context, options);
  };
  h.faux.setResponses([complete(), fauxAssistantMessage("Goal complete."), fauxAssistantMessage("Genuine input answered.")]);
  await h.session.sendUserMessage(control);
  await h.session.waitForIdle();
  await h.session.prompt(control);
  await h.session.waitForIdle();
  assert.doesNotMatch(providerContexts.join("\n"), /pi_goal_delivery/);
  assert.doesNotMatch(JSON.stringify(h.session.sessionManager.getEntries()), /pi_goal_delivery/);
  assert.deepEqual(terminalOwnership, [true, false], "only the owned delivery stays owned at agent_end");
  h.session.refreshContext();
  const users = h.session.messages.filter((message) => message.role === "user");
  assert.equal(users.length, 2);
  for (const [index, message] of users.entries()) {
    assert.equal(message, originals[index], "Pi retains the original delivery object through replacement and refresh");
    assert.equal(agentEndMessagesIncludeQueuedGoalWork([message]), index === 0);
    assert.equal(typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), control);
  }
});
}

const waitingReason = "Explorer alpha will deliver its report as a message";
const waitForExplorer = () => fauxAssistantMessage(fauxToolCall("update_goal", { status: "waiting", reason: waitingReason }), { stopReason: "toolUse" });

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
  h.faux.setResponses([waitForExplorer(), fauxAssistantMessage("Waiting for the report.")]);
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
  await h.session.sendCustomMessage({ customType: CUSTOM_ENTRY_TYPE, content: compactContinuationPrompt(saved), display: false, details: { kind: "continuation", goalId: saved.goalId } }, { triggerTurn: true });
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
