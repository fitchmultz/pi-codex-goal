import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createAssistantMessageEventStream, fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import goalExtension from "../src/index.ts";
import { compactContinuationPrompt, escapeXmlText } from "../src/prompts.ts";
import { GOAL_COMPACTION_INPUT_EVENT } from "../src/goal-compaction.ts";
import { reconstructGoal } from "../src/state.ts";
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
  return { session, faux, goal };
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
