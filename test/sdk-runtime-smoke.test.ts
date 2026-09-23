import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import goalExtension, { __testHooks } from "../src/index.js";
import { reconstructGoal } from "../src/state.js";
import { CUSTOM_ENTRY_TYPE } from "../src/types.js";

function assistantResponse(
  model: Parameters<StreamFunction>[0],
  contextTokens: number,
  content: string | AssistantMessage["content"],
): ReturnType<StreamFunction> {
  const stream = createAssistantMessageEventStream();
  const parts: AssistantMessage["content"] = typeof content === "string" ? [{ type: "text", text: content }] : content;
  const stopReason = parts.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
  const message: AssistantMessage = {
    role: "assistant",
    content: parts,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: contextTokens - 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: contextTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: stopReason, message });
    stream.end();
  });
  return stream;
}

test("SDK completion report includes its calling response exactly once", async () => {
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    noContextFiles: true,
    noExtensions: true,
    extensionFactories: [goalExtension],
  });
  await loader.reload();
  modelRuntime.registerProvider("sdk-smoke", { apiKey: "test" });
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    model: {
      provider: "sdk-smoke",
      id: "completion",
      name: "SDK Completion Smoke",
      api: "openai-completions",
      baseUrl: "http://localhost",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 1_000,
    },
    modelRuntime,
    noTools: "builtin",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  });
  let requests = 0;
  session.agent.streamFunction = (model) => {
    requests += 1;
    if (requests > 2) {
      assert.equal(requests, 3, "completed goals must not queue another continuation");
      return assistantResponse(model, 7, "Done");
    }
    return assistantResponse(model, requests === 1 ? 410_000 : 100_000, [{
      type: "toolCall",
      id: `call-${requests}`,
      name: requests === 1 ? "get_goal" : "update_goal",
      arguments: requests === 1 ? {} : { status: "complete" },
    }]);
  };
  try {
    const runner = session.extensionRunner;
    const createGoal = runner.getToolDefinition("create_goal");
    assert.ok(createGoal);
    await createGoal.execute("create", { objective: "ship it", token_budget: 500_000 },
      undefined, undefined, runner.createContext());
    await session.prompt("Complete the goal");

    const entries = session.sessionManager.getBranch();
    const goal = reconstructGoal(entries).goal;
    assert.equal(goal?.status, "complete");
    assert.equal(goal?.usage.tokensUsed, 510_000);
    const result = entries.find((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "update_goal");
    assert.match(JSON.stringify(result), /tokens used: 510,000 of 500,000/);
    assert.equal(requests, 3);
  } finally {
    session.dispose();
  }
});

function goalIdFromToolResult(result: unknown): string {
  assert.ok(result && typeof result === "object");
  const details = (result as { details?: unknown }).details;
  assert.ok(details && typeof details === "object");
  const goal = (details as { goal?: unknown }).goal;
  assert.ok(goal && typeof goal === "object");
  const goalId = (goal as { goalId?: unknown }).goalId;
  if (typeof goalId !== "string") {
    assert.fail("Expected tool result goal id.");
  }
  return goalId;
}

test("SDK runtime uses Pi settings for the sole persisted threshold compaction", async () => {
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    noContextFiles: true,
    noExtensions: true,
    extensionFactories: [goalExtension],
  });
  await loader.reload();

  modelRuntime.registerProvider("sdk-smoke", {
    api: "openai-completions",
    apiKey: "test",
    baseUrl: "http://localhost",
    models: [{
      id: "compaction",
      name: "SDK Compaction Smoke",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 272_000,
      maxTokens: 1_000,
    }],
  });
  const model = modelRuntime.getModel("sdk-smoke", "compaction");
  assert.ok(model);
  const sessionManager = SessionManager.inMemory(process.cwd());
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    model,
    modelRuntime,
    noTools: "builtin",
    resourceLoader: loader,
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16_834, keepRecentTokens: 40_000 },
    }),
  });

  let nextContextTokens = 247_783;
  let streamCalls = 0;
  session.agent.streamFunction = (activeModel) => {
    streamCalls += 1;
    return assistantResponse(
      activeModel,
      nextContextTokens,
      streamCalls === 1 ? "x".repeat(200_000) : "summary",
    );
  };

  try {
    await session.prompt("below configured threshold");
    assert.equal(sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 0);

    nextContextTokens = 255_167;
    await session.prompt("above configured threshold");

    assert.equal(sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
  } finally {
    session.dispose();
  }
});

test("SDK runtime emits a continuation after willRetry compaction when no retry agent starts", async () => {
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    noContextFiles: true,
    noExtensions: true,
    extensionFactories: [goalExtension],
  });
  await loader.reload();

  const model = {
    provider: "sdk-smoke",
    id: "mini",
    name: "SDK Smoke",
    api: "sdk-smoke-api",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  };
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    model,
    modelRuntime,
    noTools: "builtin",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager: SettingsManager.inMemory(),
  });

  try {
    const runner = session.extensionRunner;
    assert.equal(runner.getToolDefinition("get_goal")?.executionMode, undefined);
    for (const toolName of ["create_goal", "update_goal"]) {
      assert.equal(runner.getToolDefinition(toolName)?.executionMode, "sequential");
    }
    const createGoal = runner.getToolDefinition("create_goal");
    assert.ok(createGoal);
    const result = await createGoal.execute(
      "tool-call",
      { objective: "ship it" },
      undefined,
      undefined,
      runner.createContext(),
    );
    const goalId = goalIdFromToolResult(result);

    await runner.emit({
      type: "session_compact",
      compactionEntry: {
        type: "compaction",
        id: "compaction-entry",
        parentId: null,
        timestamp: new Date().toISOString(),
        summary: "compact summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100,
      },
      fromExtension: false,
      reason: "manual",
      willRetry: true,
    });
    await new Promise((resolve) => setTimeout(resolve, __testHooks.continuationRetryMs + 25));

    const continuationMessages = session.sessionManager.getEntries().filter((entry) => {
      return (
        entry.type === "custom_message" &&
        entry.customType === CUSTOM_ENTRY_TYPE &&
        "details" in entry &&
        (entry.details as { kind?: unknown } | undefined)?.kind === "continuation"
      );
    });
    assert.equal(continuationMessages.length, 1);
    const continuationMessage = continuationMessages[0];
    assert.ok(continuationMessage && "details" in continuationMessage);
    assert.deepEqual(continuationMessage.details, { kind: "continuation", goalId });
  } finally {
    session.dispose();
  }
});
