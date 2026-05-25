import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import goalExtension from "../src/index.js";
import { isGoalCustomEntry, reconstructGoal } from "../src/state.js";
import { CUSTOM_ENTRY_TYPE } from "../src/types.js";

type EventHandler = (event: object, ctx: ExtensionContext) => unknown | Promise<unknown>;

interface SentMessage {
  message: Parameters<ExtensionAPI["sendMessage"]>[0];
  options: Parameters<ExtensionAPI["sendMessage"]>[1];
}

function createRuntimeHarness(options: { idle?: boolean; pendingMessages?: boolean } = {}) {
  const entries: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]> = [];
  const handlers = new Map<string, EventHandler[]>();
  const sentMessages: SentMessage[] = [];
  const tools = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const runtime = {
    abortCount: 0,
    idle: options.idle ?? true,
    pendingMessages: options.pendingMessages ?? false,
  };
  let commandHandler: ((args: string, ctx: ExtensionCommandContext) => void | Promise<void>) | null = null;
  let ctx: ExtensionCommandContext;
  let entryIndex = 0;

  const on = ((event: string, handler: EventHandler) => {
    const currentHandlers = handlers.get(event) ?? [];
    currentHandlers.push(handler);
    handlers.set(event, currentHandlers);
  }) as ExtensionAPI["on"];

  const registerCommand: ExtensionAPI["registerCommand"] = (name, options) => {
    if (name === "goal") {
      commandHandler = options.handler;
    }
  };

  const pi: ExtensionAPI = {
    appendEntry(customType: string, data: unknown) {
      entries.push({
        type: "custom",
        id: `entry-${++entryIndex}`,
        parentId: null,
        timestamp: new Date(0).toISOString(),
        customType,
        data,
      });
    },
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    getActiveTools: () => [],
    getAllTools: () => [],
    getCommands: () => [],
    getFlag: () => undefined,
    getSessionName: () => undefined,
    getThinkingLevel: () => "medium",
    on,
    registerCommand,
    registerFlag() {},
    registerMessageRenderer() {},
    registerProvider() {},
    registerShortcut() {},
    registerTool(tool) {
      tools.set(tool.name, (params) => tool.execute("tool-call", params as never, undefined, undefined, ctx));
    },
    sendMessage(message, options) {
      sentMessages.push({ message, options });
    },
    sendUserMessage() {},
    setActiveTools() {},
    setLabel() {},
    setModel: async () => false,
    setSessionName() {},
    setThinkingLevel() {},
    unregisterProvider() {},
  };

  const sessionManager: ExtensionCommandContext["sessionManager"] = {
    getBranch: () => entries,
    getCwd: () => "/tmp",
    getEntries: () => entries,
    getEntry: () => undefined,
    getHeader: () => null,
    getLabel: () => undefined,
    getLeafEntry: () => undefined,
    getLeafId: () => null,
    getSessionDir: () => "/tmp",
    getSessionFile: () => undefined,
    getSessionId: () => "session",
    getSessionName: () => undefined,
    getTree: () => [],
  };

  const ui: ExtensionCommandContext["ui"] = {
    addAutocompleteProvider() {},
    confirm: async () => true,
    custom: async () => {
      throw new Error("custom UI is not implemented in this test harness.");
    },
    editor: async () => undefined,
    getAllThemes: () => [],
    getEditorComponent: () => undefined,
    getEditorText: () => "",
    getTheme: () => undefined,
    getToolsExpanded: () => false,
    input: async () => undefined,
    notify() {},
    onTerminalInput: () => () => {},
    pasteToEditor() {},
    select: async () => undefined,
    setEditorComponent() {},
    setEditorText() {},
    setFooter() {},
    setHeader() {},
    setHiddenThinkingLabel() {},
    setStatus() {},
    setTheme: () => ({ success: false }),
    setTitle() {},
    setToolsExpanded() {},
    setWidget() {},
    setWorkingIndicator() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    theme: {} as ExtensionCommandContext["ui"]["theme"],
  };

  ctx = {
    abort() {
      runtime.abortCount += 1;
    },
    compact() {},
    cwd: "/tmp",
    fork: async () => ({ cancelled: false }),
    getContextUsage: () => undefined,
    getSystemPrompt: () => "",
    hasUI: true,
    hasPendingMessages: () => runtime.pendingMessages,
    isIdle: () => runtime.idle,
    model: undefined,
    modelRegistry: {} as ExtensionCommandContext["modelRegistry"],
    navigateTree: async () => ({ cancelled: false }),
    newSession: async () => ({ cancelled: false }),
    reload: async () => {},
    sessionManager,
    shutdown() {},
    signal: undefined,
    switchSession: async () => ({ cancelled: false }),
    ui,
    waitForIdle: async () => {},
  };

  goalExtension(pi);

  async function runCommand(args: string): Promise<void> {
    assert.ok(commandHandler);
    await commandHandler(args, ctx);
  }

  async function emit(event: string, payload: object): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler(payload, ctx));
    }
    return results;
  }

  async function runTool(name: string, params: Record<string, unknown>) {
    const tool = tools.get(name);
    assert.ok(tool, `Expected tool ${name} to be registered.`);
    return tool(params);
  }

  return {
    emit,
    entries,
    runCommand,
    runTool,
    sentMessages,
    setIdle(idle: boolean) {
      runtime.idle = idle;
    },
    setPendingMessages(pendingMessages: boolean) {
      runtime.pendingMessages = pendingMessages;
    },
    get abortCount() {
      return runtime.abortCount;
    },
    snapshot: () => reconstructGoal(entries),
  };
}

interface TestAssistantUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

function waitForContinuationRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 75));
}

function queuedCustomMessage(sent: SentMessage, timestamp = 1) {
  return {
    role: "custom",
    customType: sent.message.customType,
    content: sent.message.content,
    display: sent.message.display,
    details: sent.message.details,
    timestamp,
  };
}

type RuntimeHarness = ReturnType<typeof createRuntimeHarness>;

async function emitQueuedTurnThroughContext(
  harness: RuntimeHarness,
  messages: Array<Record<string, unknown>>,
  turnIndex = 0,
): Promise<unknown[]> {
  await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  for (const message of messages) {
    await harness.emit("message_start", { type: "message_start", message });
    await harness.emit("message_end", { type: "message_end", message });
  }
  return harness.emit("context", { type: "context", messages });
}

function assistantMessage(stopReason: "stop" | "aborted" | "length" | "toolUse", usage: TestAssistantUsage) {
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;

  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead,
      cacheWrite,
      totalTokens: usage.totalTokens ?? usage.input + usage.output + cacheRead + cacheWrite,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    timestamp: 1,
  };
}

test("aborted turns pause goals and do not queue continuation", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("aborted", {
      input: 40,
      output: 2,
      cacheRead: 500,
      cacheWrite: 600,
      totalTokens: 1_142,
    }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "paused");
  assert.equal(goal?.usage.tokensUsed, 42);
  assert.equal(harness.sentMessages.length, 0);
});

test("a new user-driven agent start leaves a paused goal paused", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("aborted", { input: 8, output: 2 }),
    toolResults: [],
  });

  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "continue",
    systemPrompt: "",
    systemPromptOptions: {},
  });

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.snapshot().goal?.usage.tokensUsed, 10);
});

test("session resume prompt can reactivate a paused goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("aborted", { input: 8, output: 2 }),
    toolResults: [],
  });
  harness.sentMessages.length = 0;

  await harness.emit("session_start", { type: "session_start", reason: "resume" });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: harness.snapshot().goal?.goalId,
  });
});

test("completed turns count input plus output and continue active goals", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const queuedMessage = queuedCustomMessage(queued);
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("message_start", {
    type: "message_start",
    message: queuedMessage,
  });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("stop", {
      input: 30,
      output: 12,
      cacheRead: 500,
      cacheWrite: 600,
      totalTokens: 1_142,
    }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(goal?.usage.tokensUsed, 42);
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0]?.message.customType, CUSTOM_ENTRY_TYPE);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal?.goalId,
  });
});

test("tool-use turn ends do not queue continuation before tool execution finishes", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("toolUse", { input: 10, output: 3 }),
    toolResults: [],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("budget crossing sends one hidden budget-limit steering message", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it", token_budget: 10 });

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("toolUse", { input: 8, output: 3 }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "budgetLimited");
  assert.equal(goal?.usage.tokensUsed, 11);
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "budget_limit",
    goalId: goal?.goalId,
  });

  await harness.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "tool-call",
    toolName: "bash",
    args: {},
    result: {},
    isError: false,
  });
  assert.equal(harness.sentMessages.length, 1);
});

test("replacement during an in-flight turn does not charge old tokens to the new goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("old goal");
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.runCommand("new goal");
  const replacement = harness.snapshot().goal;
  assert.equal(replacement?.objective, "new goal");

  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("stop", { input: 80, output: 20 }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.goalId, replacement?.goalId);
  assert.equal(goal?.usage.tokensUsed, 0);
  assert.equal(harness.sentMessages.length, 1);
});

test("goal tools return Codex-shaped response details", async () => {
  const harness = createRuntimeHarness();
  const created = (await harness.runTool("create_goal", {
    objective: "ship it",
    token_budget: 20,
  })) as { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

  assert.equal((created.details.goal as { objective?: string }).objective, "ship it");
  assert.equal((created.details.goal as { tokenBudget?: number }).tokenBudget, 20);
  assert.equal(created.details.remainingTokens, 20);
  assert.equal(created.details.completionBudgetReport, null);
  assert.deepEqual(JSON.parse(created.content[0]?.text ?? ""), {
    goal: created.details.goal,
    remainingTokens: 20,
    completionBudgetReport: null,
  });

  const completed = (await harness.runTool("update_goal", { status: "complete" })) as {
    details: Record<string, unknown>;
  };
  assert.match(String(completed.details.completionBudgetReport), /^Goal achieved\. Report final budget usage to the user:/);
});

test("agent end waits for idle before continuing active goals", async () => {
  const harness = createRuntimeHarness({ idle: false, pendingMessages: true });
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const queuedMessage = queuedCustomMessage(queued);
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("message_start", {
    type: "message_start",
    message: queuedMessage,
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 30, output: 12 })],
  });

  assert.equal(harness.sentMessages.length, 0);
  harness.setIdle(true);
  harness.setPendingMessages(false);
  await waitForContinuationRetry();

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal?.goalId,
  });
});

test("completing a goal cancels a scheduled continuation before it is sent", async () => {
  const harness = createRuntimeHarness({ idle: false, pendingMessages: true });
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 30, output: 12 })],
  });
  assert.equal(harness.sentMessages.length, 0);

  await harness.runTool("update_goal", { status: "complete" });
  const completeSetEntries = harness.entries.filter((entry) => {
    return (
      entry.type === "custom" &&
      entry.customType === CUSTOM_ENTRY_TYPE &&
      isGoalCustomEntry(entry.data) &&
      entry.data.kind === "set" &&
      entry.data.goal.status === "complete"
    );
  });
  assert.equal(completeSetEntries.length, 1);
  harness.setIdle(true);
  harness.setPendingMessages(false);
  await waitForContinuationRetry();

  assert.equal(harness.snapshot().goal?.status, "complete");
  assert.equal(harness.sentMessages.length, 0);
});

test("stale prompt continuation input is handled before agent start", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const prompt = queued.message.content;
  if (typeof prompt !== "string") {
    assert.fail("Expected queued goal message content to be a string.");
  }

  await harness.runTool("update_goal", { status: "complete" });
  const results = await harness.emit("input", {
    type: "input",
    text: prompt,
    source: "extension",
  });

  assert.deepEqual(results[0], { action: "handled" });
  assert.equal(harness.snapshot().goal?.status, "complete");
  assert.equal(harness.abortCount, 0);
});

for (const source of ["interactive", "rpc"] as const) {
  test(`pasted continuation marker input from ${source} is not swallowed`, async () => {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    const prompt = queued.message.content;
    if (typeof prompt !== "string") {
      assert.fail("Expected queued goal message content to be a string.");
    }

    await harness.runTool("update_goal", { status: "complete" });
    const inputResults = await harness.emit("input", {
      type: "input",
      text: prompt,
      source,
    });
    assert.equal(inputResults[0], undefined);

    const beforeAgentStartResults = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt,
      systemPrompt: "base prompt",
      systemPromptOptions: {},
    });
    assert.equal(beforeAgentStartResults[0], undefined);

    const userMessage = {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: 1,
    };
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("message_start", { type: "message_start", message: userMessage });
    await harness.emit("message_end", { type: "message_end", message: userMessage });
    const contextResults = await harness.emit("context", {
      type: "context",
      messages: [userMessage],
    });
    const secondContextResults = await harness.emit("context", {
      type: "context",
      messages: [userMessage],
    });

    assert.equal(contextResults[0], undefined);
    assert.equal(secondContextResults[0], undefined);
    assert.equal(harness.snapshot().goal?.status, "complete");
    assert.equal(harness.abortCount, 0);

    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("stop", { input: 1, output: 1 }),
      toolResults: [],
    });

    const laterUserMessage = {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: 2,
    };
    const laterContextResults = await emitQueuedTurnThroughContext(harness, [laterUserMessage], 1);
    const laterContextResult = laterContextResults[0] as { messages?: Array<{ content?: unknown }> } | undefined;
    assert.notEqual(laterContextResult, undefined);
    assert.equal(harness.abortCount, 1);
  });
}

test("stale queued continuation aborts if the goal became complete before launch", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const prompt = queued.message.content;
  if (typeof prompt !== "string") {
    assert.fail("Expected queued goal message content to be a string.");
  }

  await harness.runTool("update_goal", { status: "complete" });
  const results = await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt,
    systemPrompt: "base prompt",
    systemPromptOptions: {},
  });

  assert.equal(results[0], undefined);
  assert.equal(harness.abortCount, 0);

  const queuedMessage = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: 1,
  };
  const contextResults = await emitQueuedTurnThroughContext(harness, [queuedMessage]);
  const contextResult = contextResults[0] as { messages?: Array<{ content?: unknown }> } | undefined;
  assert.deepEqual(contextResult?.messages?.[0]?.content, [
    {
      type: "text",
      text: [
        "A queued hidden goal continuation was stale and has been cancelled before running.",
        `Queued goal id: ${harness.snapshot().goal?.goalId}.`,
        `Current goal id: ${harness.snapshot().goal?.goalId}; current status: complete.`,
        "Ignore only this stale hidden bookkeeping message; do not perform work for the queued goal id above or mention this cancellation to the user.",
      ].join("\n"),
    },
  ]);

  assert.equal(harness.snapshot().goal?.status, "complete");
  assert.equal(harness.abortCount, 1);
});

test("stale custom goal work messages are replaced before provider context", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);

  const contextMessage = {
    role: "custom",
    customType: CUSTOM_ENTRY_TYPE,
    content: queued.message.content,
    display: false,
    details: queued.message.details,
    timestamp: 1,
  };
  const activeResults = await harness.emit("context", {
    type: "context",
    messages: [contextMessage],
  });
  assert.equal(activeResults[0], undefined);

  await harness.runTool("update_goal", { status: "complete" });
  const results = await harness.emit("context", {
    type: "context",
    messages: [contextMessage],
  });

  const result = results[0] as { messages?: Array<{ content?: unknown; details?: unknown }> } | undefined;
  const replacedMessage = result?.messages?.[0];
  assert.equal(typeof replacedMessage?.content, "string");
  assert.match(String(replacedMessage?.content), /queued hidden goal continuation was stale and has been cancelled/);
  assert.deepEqual(replacedMessage?.details, {
    kind: "stale_continuation",
    goalId: harness.snapshot().goal?.goalId,
    currentGoalId: harness.snapshot().goal?.goalId,
    currentStatus: "complete",
  });
});

test("stale provider context replacement covers queued work kinds and prompt markers", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const queuedGoalId = harness.snapshot().goal?.goalId;
  assert.ok(queuedGoalId);
  const prompt = queued.message.content;
  if (typeof prompt !== "string") {
    assert.fail("Expected queued goal message content to be a string.");
  }

  await harness.runTool("update_goal", { status: "complete" });
  const staleMessages = [
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: "queued by details",
      display: false,
      details: { kind: "continuation", goalId: queuedGoalId },
      timestamp: 1,
    },
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: "queued by details",
      display: false,
      details: { kind: "command_start", goalId: queuedGoalId },
      timestamp: 1,
    },
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: "queued by details",
      display: false,
      details: { kind: "command_resume", goalId: queuedGoalId },
      timestamp: 1,
    },
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: prompt,
      display: false,
      details: { kind: "other", goalId: queuedGoalId },
      timestamp: 1,
    },
    {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: 1,
    },
  ];

  const results = await harness.emit("context", {
    type: "context",
    messages: staleMessages,
  });

  const result = results[0] as { messages?: Array<{ role: string; content?: unknown; details?: unknown }> } | undefined;
  assert.equal(result?.messages?.length, staleMessages.length);
  for (const [index, message] of result?.messages?.entries() ?? []) {
    if (message.role === "custom") {
      assert.equal(typeof message.content, "string", `custom message ${index} should use string content`);
      assert.match(String(message.content), /do not perform work for the queued goal id above/);
      assert.deepEqual(message.details, {
        kind: "stale_continuation",
        goalId: queuedGoalId,
        currentGoalId: queuedGoalId,
        currentStatus: "complete",
      });
    } else {
      assert.deepEqual(message.content, [
        {
          type: "text",
          text: [
            "A queued hidden goal continuation was stale and has been cancelled before running.",
            `Queued goal id: ${queuedGoalId}.`,
            `Current goal id: ${queuedGoalId}; current status: complete.`,
            "Ignore only this stale hidden bookkeeping message; do not perform work for the queued goal id above or mention this cancellation to the user.",
          ].join("\n"),
        },
      ]);
    }
  }
});

test("stale prompt-based queued work does not pause or charge a replacement goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("old goal");
  const oldQueued = harness.sentMessages[0];
  assert.ok(oldQueued);
  const oldPrompt = oldQueued.message.content;
  if (typeof oldPrompt !== "string") {
    assert.fail("Expected queued goal message content to be a string.");
  }
  const oldMessage = {
    role: "user",
    content: [{ type: "text", text: oldPrompt }],
    timestamp: 1,
  };

  await harness.runCommand("new goal");
  const replacement = harness.snapshot().goal;
  assert.equal(replacement?.objective, "new goal");
  harness.sentMessages.length = 0;

  await emitQueuedTurnThroughContext(harness, [oldMessage]);
  assert.equal(harness.abortCount, 1);

  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("aborted", { input: 20, output: 5 }),
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("aborted", { input: 20, output: 5 })],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.goalId, replacement?.goalId);
  assert.equal(goal?.status, "active");
  assert.equal(goal?.usage.tokensUsed, 0);
  assert.equal(harness.abortCount, 1);
  assert.equal(harness.sentMessages.length, 0);
});

test("stale custom queued work aborts without pausing, charging, or requeueing a replacement goal", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("old goal");
    const oldQueued = harness.sentMessages[0];
    assert.ok(oldQueued);
    const oldMessage = {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: oldQueued.message.content,
      display: false,
      details: oldQueued.message.details,
      timestamp: 1,
    };

    await harness.runCommand("new goal");
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "new goal");
    harness.sentMessages.length = 0;

    await emitQueuedTurnThroughContext(harness, [oldMessage]);
    assert.equal(harness.abortCount, 1);

    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("aborted", { input: 20, output: 5 }),
      toolResults: [],
    });
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [assistantMessage("aborted", { input: 20, output: 5 })],
    });

    now = 5_000;
    await harness.emit("session_shutdown", { type: "session_shutdown" });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.usage.tokensUsed, 0);
    assert.equal(goal?.usage.activeSeconds, 0);
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("stale custom abort without agent_end does not suppress the next current follow-up", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("old goal");
    const oldQueued = harness.sentMessages[0];
    assert.ok(oldQueued);
    const oldMessage = queuedCustomMessage(oldQueued, 1);

    await harness.runCommand("new goal");
    const currentQueued = harness.sentMessages.at(-1);
    assert.ok(currentQueued);
    const currentMessage = queuedCustomMessage(currentQueued, 2);
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "new goal");
    harness.sentMessages.length = 0;

    await emitQueuedTurnThroughContext(harness, [oldMessage], 0);
    assert.equal(harness.abortCount, 1);

    now = 2_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("aborted", { input: 20, output: 5 }),
      toolResults: [],
    });
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 0);
    assert.equal(harness.sentMessages.length, 0);

    now = 3_000;
    await emitQueuedTurnThroughContext(harness, [currentMessage], 1);
    now = 5_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: assistantMessage("stop", { input: 30, output: 12 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.usage.tokensUsed, 42);
    assert.equal(goal?.usage.activeSeconds, 2);
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: replacement?.goalId,
    });
  } finally {
    Date.now = originalNow;
  }
});

test("late stale turn_end after the next current follow-up starts is ignored", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("old goal");
    const oldQueued = harness.sentMessages[0];
    assert.ok(oldQueued);
    const oldMessage = queuedCustomMessage(oldQueued, 1);

    await harness.runCommand("new goal");
    const currentQueued = harness.sentMessages.at(-1);
    assert.ok(currentQueued);
    const currentMessage = queuedCustomMessage(currentQueued, 2);
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "new goal");
    harness.sentMessages.length = 0;

    await emitQueuedTurnThroughContext(harness, [oldMessage], 0);
    assert.equal(harness.abortCount, 1);

    now = 3_000;
    await emitQueuedTurnThroughContext(harness, [currentMessage], 1);

    now = 4_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("aborted", { input: 20, output: 5 }),
      toolResults: [],
    });
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 0);
    assert.equal(harness.sentMessages.length, 0);

    now = 5_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: assistantMessage("stop", { input: 30, output: 12 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.usage.tokensUsed, 42);
    assert.equal(goal?.usage.activeSeconds, 2);
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: replacement?.goalId,
    });
  } finally {
    Date.now = originalNow;
  }
});

test("current follow-up abort is not swallowed by a pending late stale turn_end", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("old goal");
    const oldQueued = harness.sentMessages[0];
    assert.ok(oldQueued);
    const oldMessage = queuedCustomMessage(oldQueued, 1);

    await harness.runCommand("new goal");
    const currentQueued = harness.sentMessages.at(-1);
    assert.ok(currentQueued);
    const currentMessage = queuedCustomMessage(currentQueued, 2);
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "new goal");
    harness.sentMessages.length = 0;

    await emitQueuedTurnThroughContext(harness, [oldMessage], 0);
    assert.equal(harness.abortCount, 1);

    now = 3_000;
    await emitQueuedTurnThroughContext(harness, [currentMessage], 1);
    now = 5_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: assistantMessage("aborted", { input: 30, output: 12 }),
      toolResults: [],
    });

    let goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "paused");
    assert.equal(goal?.usage.tokensUsed, 42);
    assert.equal(goal?.usage.activeSeconds, 2);
    assert.equal(harness.sentMessages.length, 0);

    now = 6_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("aborted", { input: 20, output: 5 }),
      toolResults: [],
    });

    goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "paused");
    assert.equal(goal?.usage.tokensUsed, 42);
    assert.equal(goal?.usage.activeSeconds, 2);
  } finally {
    Date.now = originalNow;
  }
});

test("compaction between stale context abort and cleanup does not persist, account, or requeue", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("old goal");
    const oldQueued = harness.sentMessages[0];
    assert.ok(oldQueued);
    const oldMessage = queuedCustomMessage(oldQueued, 1);

    await harness.runCommand("clear");
    await harness.runTool("create_goal", { objective: "new goal" });
    const replacement = harness.snapshot().goal;
    assert.equal(replacement?.objective, "new goal");
    const entryCountBeforeCompaction = harness.entries.length;
    harness.sentMessages.length = 0;

    await emitQueuedTurnThroughContext(harness, [oldMessage], 0);
    assert.equal(harness.abortCount, 1);

    now = 5_000;
    await harness.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: {},
      branchEntries: [],
      signal: new AbortController().signal,
    });
    await harness.emit("session_compact", {
      type: "session_compact",
      compactionEntry: {},
      fromExtension: false,
    });

    assert.equal(harness.entries.length, entryCountBeforeCompaction);
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 0);
    assert.equal(harness.snapshot().goal?.usage.activeSeconds, 0);

    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("aborted", { input: 20, output: 5 }),
      toolResults: [],
    });
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 0);

    const userMessage = {
      role: "user",
      content: [{ type: "text", text: "continue now" }],
      timestamp: 2,
    };
    now = 6_000;
    await emitQueuedTurnThroughContext(harness, [userMessage], 1);
    now = 8_000;
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 1,
      message: assistantMessage("stop", { input: 7, output: 3 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.goalId, replacement?.goalId);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.usage.tokensUsed, 10);
    assert.equal(goal?.usage.activeSeconds, 2);
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: replacement?.goalId,
    });
  } finally {
    Date.now = originalNow;
  }
});

test("mixed stale and current follow-up batch neutralizes stale work without aborting current goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("old goal");
  const oldQueued = harness.sentMessages[0];
  assert.ok(oldQueued);
  const oldMessage = queuedCustomMessage(oldQueued, 1);
  const oldGoalId = harness.snapshot().goal?.goalId;
  assert.ok(oldGoalId);

  await harness.runCommand("new goal");
  const replacement = harness.snapshot().goal;
  assert.equal(replacement?.objective, "new goal");
  const currentQueued = harness.sentMessages.at(-1);
  assert.ok(currentQueued);
  const currentMessage = queuedCustomMessage(currentQueued, 2);
  harness.sentMessages.length = 0;

  const contextResults = await emitQueuedTurnThroughContext(harness, [oldMessage, currentMessage]);
  const contextResult = contextResults[0] as
    | { messages?: Array<{ content?: unknown; details?: unknown }> }
    | undefined;

  assert.equal(harness.abortCount, 0);
  assert.equal(contextResult?.messages?.length, 2);
  assert.match(String(contextResult?.messages?.[0]?.content), /queued hidden goal continuation was stale/);
  assert.deepEqual(contextResult?.messages?.[0]?.details, {
    kind: "stale_continuation",
    goalId: oldGoalId,
    currentGoalId: replacement?.goalId,
    currentStatus: "active",
  });
  assert.deepEqual(contextResult?.messages?.[1]?.details, currentMessage.details);

  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("stop", { input: 9, output: 1 }),
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 9, output: 1 })],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.goalId, replacement?.goalId);
  assert.equal(goal?.status, "active");
  assert.equal(goal?.usage.tokensUsed, 10);
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: replacement?.goalId,
  });
});

test("goal follow-up guard resets when the queued prompt-based agent turn starts", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  assert.equal(harness.sentMessages.length, 1);
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const prompt = queued.message.content;
  if (typeof prompt !== "string") {
    assert.fail("Expected queued goal message content to be a string.");
  }
  harness.sentMessages.length = 0;

  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt,
    systemPrompt: "",
    systemPromptOptions: {},
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 30, output: 12 })],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal?.goalId,
  });
});

test("goal follow-up guard resets when custom-message continuations start", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it" });
  harness.sentMessages.length = 0;

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 30, output: 12 })],
  });
  assert.equal(harness.sentMessages.length, 1);
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const queuedMessage = {
    role: "custom",
    customType: CUSTOM_ENTRY_TYPE,
    content: queued.message.content,
    display: false,
    details: queued.message.details,
    timestamp: 1,
  };
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await harness.emit("message_start", {
    type: "message_start",
    message: queuedMessage,
  });
  assert.equal(harness.abortCount, 0);
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 5, output: 6 })],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal?.goalId,
  });
});

test("duplicate update_goal complete appends only one complete entry", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");

  await harness.runTool("update_goal", { status: "complete" });
  await harness.runTool("update_goal", { status: "complete" });

  const completeSetEntries = harness.entries.filter((entry) => {
    return (
      entry.type === "custom" &&
      entry.customType === CUSTOM_ENTRY_TYPE &&
      isGoalCustomEntry(entry.data) &&
      entry.data.kind === "set" &&
      entry.data.goal.status === "complete"
    );
  });
  assert.equal(completeSetEntries.length, 1);
  assert.equal(harness.snapshot().goal?.status, "complete");
});

test("compaction after complete does not append duplicate runtime entries", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.runTool("update_goal", { status: "complete" });
  const entryCountAfterComplete = harness.entries.length;

  await harness.emit("session_before_compact", {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    signal: new AbortController().signal,
  });
  await harness.emit("session_compact", {
    type: "session_compact",
    compactionEntry: {},
    fromExtension: false,
  });

  assert.equal(harness.entries.length, entryCountAfterComplete);
  assert.equal(harness.snapshot().goal?.status, "complete");
});

test("create_goal replaces a completed goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const completedGoalId = harness.snapshot().goal?.goalId;
  await harness.runTool("update_goal", { status: "complete" });

  const created = (await harness.runTool("create_goal", { objective: "next objective" })) as {
    details: Record<string, unknown>;
  };

  assert.equal((created.details.goal as { objective?: string }).objective, "next objective");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.notEqual(harness.snapshot().goal?.goalId, completedGoalId);
});

test("failed create_goal throws so pi marks the tool result as an error", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");

  await assert.rejects(() => harness.runTool("create_goal", { objective: "duplicate" }), /already has a non-complete goal/);
});

test("session compaction queues continuation for active goals after length stops", async () => {
  const harness = createRuntimeHarness({ idle: false, pendingMessages: true });
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const queuedMessage = queuedCustomMessage(queued);
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("message_start", {
    type: "message_start",
    message: queuedMessage,
  });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("length", { input: 30, output: 12 }),
    toolResults: [],
  });
  assert.equal(harness.sentMessages.length, 0);

  harness.setIdle(true);
  harness.setPendingMessages(false);
  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "compact summary",
    tokensBefore: 100,
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal?.goalId,
  });
});
