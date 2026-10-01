import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createAssistantMessageEventStream, fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import goalExtension from "../src/index.ts";
import { reconstructGoal } from "../src/state.ts";

async function fixture(t: TestContext, recover = false, extraFactories: ExtensionFactory[] = []) {
  const root = mkdtempSync(join(tmpdir(), "goal-native-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  mkdirSync(cwd); mkdirSync(agentDir);
  const faux = fauxProvider({ models: [{ id: "lifecycle", contextWindow: 100_000, maxTokens: 1_000 }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: recover, keepRecentTokens: 1 }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [goalExtension, (pi) => {
      pi.registerProvider(faux.provider);
      pi.on("session_before_compact", (event, ctx) => {
        pi.appendEntry("goal-fixture-boundary", {});
        const leaf = ctx.sessionManager.getLeafId();
        assert.ok(leaf);
        return { compaction: { summary: "Continue the active goal", firstKeptEntryId: leaf, tokensBefore: event.preparation.tokensBefore } };
      });
    }, ...extraFactories],
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

test("native repeated call IDs account the current response once across deferred boundary drafts", async (t) => {
  let ended = 0;
  const h = await fixture(t, false, [(pi) => {
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
    const message = fauxAssistantMessage(fauxToolCall(name, name === "update_goal" ? { status: "complete" } : {}), { stopReason: "toolUse" });
    const call = message.content.find((part) => part.type === "toolCall");
    assert.ok(call);
    call.id = "reused-call";
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
  const receipt = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "update_goal");
  assert.ok(receipt?.type === "message" && receipt.message.role === "toolResult");
  assert.partialDeepStrictEqual(receipt.message.details, { goal: { status: "complete", tokensUsed: 69 } });
});
