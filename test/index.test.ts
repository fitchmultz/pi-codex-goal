import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import goalExtension, { __testHooks } from "../src/index.js";
import { formatFooterStatus } from "../src/format.js";
import {
  compactContinuationPrompt,
  continuationGoalIdFromPrompt,
  continuationPrompt,
} from "../src/prompts.js";
import {
  HOST_OVERFLOW_RECOVERY_REASON,
  isContextOverflowError,
  recoveryAttentionMessage,
  recoveryPendingAttentionMessage,
} from "../src/recovery.js";
import { isGoalCustomEntry, reconstructGoal, createThreadGoal, setEntry } from "../src/state.js";
import { CUSTOM_ENTRY_TYPE } from "../src/types.js";

type EventHandler = (event: object, ctx: ExtensionContext) => unknown | Promise<unknown>;

interface SentMessage {
  message: Parameters<ExtensionAPI["sendMessage"]>[0];
  options: Parameters<ExtensionAPI["sendMessage"]>[1];
}

interface SentUserMessage {
  content: Parameters<ExtensionAPI["sendUserMessage"]>[0];
  options: Parameters<ExtensionAPI["sendUserMessage"]>[1];
}

function createRuntimeHarness(options: {
  idle?: boolean;
  pendingMessages?: boolean;
  compactBehavior?: "success" | "error" | "unavailable";
  compactCompletion?: "immediate" | "manual";
  contextWindow?: number;
} = {}) {
  const entries: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]> = [];
  const handlers = new Map<string, EventHandler[]>();
  const sentMessages: SentMessage[] = [];
  const sentUserMessages: SentUserMessage[] = [];
  const tools = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const compactCalls: Array<{
    customInstructions?: string;
    onComplete?: (result: {
      summary: string;
      tokensBefore: number;
      firstKeptEntryId: string;
    }) => void;
    onError?: (error: Error) => void;
  }> = [];
  const footerStatuses: Array<string | undefined> = [];
  const runtime = {
    abortCount: 0,
    idle: options.idle ?? true,
    pendingMessages: options.pendingMessages ?? false,
    compactBehavior: options.compactBehavior ?? "success",
    compactCompletion: options.compactCompletion ?? "immediate",
    hostOverflowRecoveryAttempted: false,
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
    sendUserMessage(content, options) {
      sentUserMessages.push({ content, options });
    },
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
    setStatus(_key, status) {
      footerStatuses.push(status);
    },
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
  } as unknown as ExtensionCommandContext;

  if (options.contextWindow !== undefined) {
    ctx.model = {
      id: "test-model",
      provider: "test",
      contextWindow: options.contextWindow,
    } as ExtensionCommandContext["model"];
  }

  if (runtime.compactBehavior !== "unavailable") {
    ctx.compact = (options) => {
      const call: (typeof compactCalls)[number] = {};
      if (options?.customInstructions !== undefined) {
        call.customInstructions = options.customInstructions;
      }
      if (options?.onComplete) {
        call.onComplete = (result) => options.onComplete?.(result);
      }
      if (options?.onError) {
        call.onError = (error) => options.onError?.(error);
      }
      compactCalls.push(call);
      if (runtime.compactBehavior === "error") {
        options?.onError?.(new Error("compaction failed"));
        return;
      }
      if (runtime.compactCompletion === "immediate") {
        options?.onComplete?.({
          summary: "compact summary",
          tokensBefore: 100,
          firstKeptEntryId: "entry-1",
        });
      }
    };
  }

  goalExtension(pi);

  function reloadExtension(): void {
    handlers.clear();
    goalExtension(pi);
  }

  async function reloadSession(reason: "startup" | "resume" = "startup"): Promise<void> {
    reloadExtension();
    await emit("session_start", { type: "session_start", reason });
  }

  async function runCommand(args: string): Promise<void> {
    assert.ok(commandHandler);
    await commandHandler(args, ctx);
  }

  async function emit(event: string, payload: object): Promise<unknown[]> {
    if (event === "message_start") {
      const message = (payload as { message?: { role?: string } }).message;
      if (message?.role === "user") {
        runtime.hostOverflowRecoveryAttempted = false;
      }
    }
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
    compactCalls,
    footerStatuses,
    emit,
    entries,
    runCommand,
    runTool,
    reloadExtension,
    reloadSession,
    sentMessages,
    sentUserMessages,
    setIdle(idle: boolean) {
      runtime.idle = idle;
    },
    setPendingMessages(pendingMessages: boolean) {
      runtime.pendingMessages = pendingMessages;
    },
    setContextWindow(contextWindow: number) {
      ctx.model = {
        id: "test-model",
        provider: "test",
        contextWindow,
      } as ExtensionCommandContext["model"];
    },
    get hostOverflowRecoveryAttempted() {
      return runtime.hostOverflowRecoveryAttempted;
    },
    setHostOverflowRecoveryAttempted(value: boolean) {
      runtime.hostOverflowRecoveryAttempted = value;
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

function flushContinuationScheduler(): void {
  mock.timers.tick(__testHooks.continuationRetryMs);
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

function assistantMessage(
  stopReason: "stop" | "aborted" | "length" | "toolUse" | "error",
  usage: TestAssistantUsage,
  errorMessage?: string,
) {
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
    ...(stopReason === "error" ? { errorMessage: errorMessage ?? "provider error" } : {}),
    timestamp: 1,
  };
}

async function emitPersistentAssistantError(
  harness: ReturnType<typeof createRuntimeHarness>,
  turnIndex: number,
  errorMessage: string,
): Promise<void> {
  const message = assistantMessage("error", { input: 1, output: 1 }, errorMessage);
  await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex,
    message,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [message],
  });
  if (isContextOverflowError(errorMessage)) {
    harness.setHostOverflowRecoveryAttempted(true);
  }
}

async function emitHostSessionCompact(harness: RuntimeHarness): Promise<void> {
  await harness.emit("session_before_compact", {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    signal: new AbortController().signal,
  });
  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "compact summary",
    tokensBefore: 100,
  });
}

async function emitSilentContextOverflow(
  harness: RuntimeHarness,
  turnIndex: number,
  message: ReturnType<typeof assistantMessage>,
): Promise<void> {
  await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex,
    message,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [message],
  });
  harness.setHostOverflowRecoveryAttempted(true);
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
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);
  const sentUserMessage = harness.sentUserMessages[0];
  assert.ok(sentUserMessage);
  assert.deepEqual(sentUserMessage.options, { deliverAs: "followUp" });
  const content = sentUserMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected session resume to send a user continuation prompt.");
  }
  assert.doesNotMatch(content, /<untrusted_objective>/);
  assert.match(content, /<pi_goal_continuation goal_id="/);
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

test("successful budget-crossing turn clears stale recovery footer attention", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it", token_budget: 10 });
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 1,
    message: assistantMessage("stop", { input: 8, output: 3 }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "budgetLimited");
  assert.equal(goal?.usage.tokensUsed, 13);
  assert.equal(harness.footerStatuses.at(-1), formatFooterStatus(goal));
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal unmet/);
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
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
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
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
    flushContinuationScheduler();

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: goal?.goalId,
    });
  } finally {
    mock.timers.reset();
  }
});

test("completing a goal cancels a scheduled continuation before it is sent", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
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
    flushContinuationScheduler();

    assert.equal(harness.snapshot().goal?.status, "complete");
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    mock.timers.reset();
  }
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

test("provider context dedupes many active continuations to one refreshed prompt", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  const fullStart = continuationPrompt(goal);
  const olderContinuation = continuationPrompt({
    ...goal,
    usage: { ...goal.usage, tokensUsed: 1, activeSeconds: 1 },
  });
  const latestContinuation = compactContinuationPrompt({
    ...goal,
    usage: { ...goal.usage, tokensUsed: 99, activeSeconds: 42 },
  });

  const messages = [
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: fullStart,
      display: false,
      details: { kind: "command_start", goalId: goal.goalId },
      timestamp: 1,
    },
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: olderContinuation,
      display: false,
      details: { kind: "continuation", goalId: goal.goalId },
      timestamp: 2,
    },
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: latestContinuation,
      display: false,
      details: { kind: "continuation", goalId: goal.goalId },
      timestamp: 3,
    },
  ];

  const results = await harness.emit("context", {
    type: "context",
    messages,
  });
  const result = results[0] as { messages?: Array<{ content?: unknown; details?: unknown }> } | undefined;
  assert.ok(result?.messages);
  assert.equal(result.messages.length, 3);

  assert.match(String(result.messages[0]?.content), /Superseded hidden goal continuation bookkeeping/);
  assert.deepEqual(result.messages[0]?.details, {
    kind: "superseded_continuation",
    goalId: goal.goalId,
  });
  assert.match(String(result.messages[1]?.content), /Superseded hidden goal continuation bookkeeping/);

  const latestContent = String(result.messages[2]?.content);
  assert.match(latestContent, /Tokens used: 0/);
  assert.match(latestContent, /Time spent pursuing goal: 0s/);
  assert.equal(continuationGoalIdFromPrompt(latestContent), goal.goalId);
  assert.doesNotMatch(latestContent, /<untrusted_objective>/);
});

test("active provider-context user marker without passthrough binding remains verbatim", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  const userPrompt = continuationPrompt(goal);
  const userMessage = {
    role: "user",
    content: [{ type: "text", text: userPrompt }],
    timestamp: 1,
  };

  const contextResults = await harness.emit("context", {
    type: "context",
    messages: [userMessage],
  });

  assert.equal(contextResults[0], undefined);
  assert.match(userPrompt, /<untrusted_objective>/);
});

test("active provider-context dedupe preserves historical user marker mixed with hidden continuations", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  const userPrompt = continuationPrompt(goal);
  const olderContinuation = continuationPrompt({
    ...goal,
    usage: { ...goal.usage, tokensUsed: 1, activeSeconds: 1 },
  });
  const latestContinuation = compactContinuationPrompt({
    ...goal,
    usage: { ...goal.usage, tokensUsed: 99, activeSeconds: 42 },
  });

  const userMessage = {
    role: "user",
    content: [{ type: "text", text: userPrompt }],
    timestamp: 2,
  };
  const messages = [
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: olderContinuation,
      display: false,
      details: { kind: "continuation", goalId: goal.goalId },
      timestamp: 1,
    },
    userMessage,
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: latestContinuation,
      display: false,
      details: { kind: "continuation", goalId: goal.goalId },
      timestamp: 3,
    },
  ];

  const contextResults = await harness.emit("context", {
    type: "context",
    messages,
  });
  const result = contextResults[0] as { messages?: Array<{ role: string; content?: unknown; details?: unknown }> } | undefined;
  assert.ok(result?.messages);
  assert.equal(result.messages.length, 3);

  assert.match(String(result.messages[0]?.content), /Superseded hidden goal continuation bookkeeping/);
  assert.deepEqual(result.messages[1]?.content, userMessage.content);
  assert.match(String((result.messages[1]?.content as Array<{ text?: string }> | undefined)?.[0]?.text), /<untrusted_objective>/);

  const latestContent = String(result.messages[2]?.content);
  assert.match(latestContent, /Tokens used: 0/);
  assert.doesNotMatch(latestContent, /<untrusted_objective>/);
  assert.equal(continuationGoalIdFromPrompt(latestContent), goal.goalId);
});

for (const source of ["interactive", "rpc"] as const) {
  test(`active goal pasted continuation marker from ${source} survives provider-context dedupe`, async () => {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const goal = harness.snapshot().goal;
    assert.ok(goal);
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    const prompt = queued.message.content;
    if (typeof prompt !== "string") {
      assert.fail("Expected queued goal message content to be a string.");
    }

    await harness.emit("input", {
      type: "input",
      text: prompt,
      source,
    });

    const userMessage = {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: 1,
    };
    const contextResults = await emitQueuedTurnThroughContext(harness, [userMessage], 0);

    assert.equal(contextResults[0], undefined);
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.match(prompt, /<untrusted_objective>/);
  });
}

test("active goal provider-context dedupe preserves pasted marker input mixed with hidden continuations", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  const pastedPrompt = continuationPrompt(goal);
  const olderContinuation = continuationPrompt({
    ...goal,
    usage: { ...goal.usage, tokensUsed: 1, activeSeconds: 1 },
  });
  const latestContinuation = compactContinuationPrompt({
    ...goal,
    usage: { ...goal.usage, tokensUsed: 99, activeSeconds: 42 },
  });

  await harness.emit("input", {
    type: "input",
    text: pastedPrompt,
    source: "interactive",
  });

  const userMessage = {
    role: "user",
    content: [{ type: "text", text: pastedPrompt }],
    timestamp: 2,
  };
  const messages = [
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: olderContinuation,
      display: false,
      details: { kind: "continuation", goalId: goal.goalId },
      timestamp: 1,
    },
    userMessage,
    {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: latestContinuation,
      display: false,
      details: { kind: "continuation", goalId: goal.goalId },
      timestamp: 3,
    },
  ];

  const contextResults = await emitQueuedTurnThroughContext(harness, messages, 0);
  const result = contextResults[0] as { messages?: Array<{ role: string; content?: unknown; details?: unknown }> } | undefined;
  assert.ok(result?.messages);
  assert.equal(result.messages.length, 3);

  assert.deepEqual(result.messages[1]?.content, userMessage.content);
  assert.match(String((result.messages[1]?.content as Array<{ text?: string }> | undefined)?.[0]?.text), /<untrusted_objective>/);
  assert.match(String(result.messages[0]?.content), /Superseded hidden goal continuation bookkeeping/);

  const latestContent = String(result.messages[2]?.content);
  assert.match(latestContent, /Tokens used: 0/);
  assert.doesNotMatch(latestContent, /<untrusted_objective>/);
  assert.equal(continuationGoalIdFromPrompt(latestContent), goal.goalId);
});

test("latest active continuation remains runnable after provider-context dedupe", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  const staleInBranch = continuationPrompt(goal);
  const latestInBranch = compactContinuationPrompt(goal);
  const contextResults = await harness.emit("context", {
    type: "context",
    messages: [
      {
        role: "custom",
        customType: CUSTOM_ENTRY_TYPE,
        content: staleInBranch,
        display: false,
        details: { kind: "continuation", goalId: goal.goalId },
        timestamp: 1,
      },
      {
        role: "custom",
        customType: CUSTOM_ENTRY_TYPE,
        content: latestInBranch,
        display: false,
        details: { kind: "continuation", goalId: goal.goalId },
        timestamp: 2,
      },
    ],
  });
  const contextResult = contextResults[0] as { messages?: Array<{ content?: unknown }> } | undefined;
  const latestContent = String(contextResult?.messages?.[1]?.content);
  assert.equal(continuationGoalIdFromPrompt(latestContent), goal.goalId);

  harness.sentMessages.length = 0;
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: latestContent,
    systemPrompt: "",
    systemPromptOptions: {},
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 1, output: 1 })],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal.goalId,
  });
});

test("completed goals are not treated as active during continuation dedupe", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goalId = harness.snapshot().goal?.goalId;
  assert.ok(goalId);
  const prompt = continuationPrompt(harness.snapshot().goal!);

  await harness.runTool("update_goal", { status: "complete" });
  const results = await harness.emit("context", {
    type: "context",
    messages: [
      {
        role: "custom",
        customType: CUSTOM_ENTRY_TYPE,
        content: prompt,
        display: false,
        details: { kind: "continuation", goalId },
        timestamp: 1,
      },
      {
        role: "custom",
        customType: CUSTOM_ENTRY_TYPE,
        content: prompt,
        display: false,
        details: { kind: "continuation", goalId },
        timestamp: 2,
      },
    ],
  });

  const result = results[0] as { messages?: Array<{ content?: unknown; details?: unknown }> } | undefined;
  assert.match(String(result?.messages?.[0]?.content), /queued hidden goal continuation was stale/);
  assert.match(String(result?.messages?.[1]?.content), /queued hidden goal continuation was stale/);
  assert.equal(harness.snapshot().goal?.status, "complete");
});

test("auto-queued continuations use the compact prompt", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const commandStart = harness.sentMessages[0];
  assert.ok(commandStart);
  const startPrompt = String(commandStart.message.content);
  assert.match(startPrompt, /<untrusted_objective>/);

  harness.sentMessages.length = 0;
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: startPrompt,
    systemPrompt: "",
    systemPromptOptions: {},
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 1, output: 1 })],
  });

  const continuation = harness.sentMessages[0];
  assert.ok(continuation);
  const content = String(continuation.message.content);
  assert.match(content, /<pi_goal_continuation goal_id="/);
  assert.doesNotMatch(content, /<untrusted_objective>/);
  assert.match(content, /get_goal/);
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

test("assistant error turns do not immediately queue continuation", async () => {
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
    message: assistantMessage("error", { input: 30, output: 12 }, "websocket closed"),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(goal?.usage.tokensUsed, 42);
  assert.equal(harness.sentMessages.length, 0);
});

test("turn_end provider errors defer recovery to agent_end without hidden continuation or extension compaction", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  const errorMessage = assistantMessage("error", { input: 1, output: 1 }, "websocket closed");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: errorMessage,
    toolResults: [],
  });

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [errorMessage],
  });

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("host overflow session compaction does not queue extension continuation before host retry", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const queuedMessage = queuedCustomMessage(queued);
  harness.sentMessages.length = 0;

  const errorMessage = assistantMessage("error", { input: 30, output: 12 }, "context_length_exceeded");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("message_start", {
    type: "message_start",
    message: queuedMessage,
  });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: errorMessage,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [errorMessage],
  });

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "compact summary",
    tokensBefore: 100,
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("host overflow retry success resumes goal continuation after clearing recovery flag", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  const errorMessage = assistantMessage("error", { input: 30, output: 12 }, "context_length_exceeded");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: errorMessage,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [errorMessage],
  });
  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "compact summary",
    tokensBefore: 100,
  });
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "host retry",
    systemPrompt: "",
    systemPromptOptions: {},
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 1, output: 1 })],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
});

test("repeated context length errors pause after host default overflow recovery", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "context_length_exceeded");
  }

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
});

test("first overflow error stays active while host performs compact-and-retry", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "compact summary",
    tokensBefore: 100,
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("context overflow recovery preserves compaction attempts across host session_compact", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitPersistentAssistantError(
      harness,
      attempt,
      `prompt is too long: ${(attempt + 1) * 100_000} tokens > 200000 maximum`,
    );
    await harness.emit("session_compact", {
      type: "session_compact",
      summary: "compact summary",
      tokensBefore: 100,
    });
  }

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
});

test("overflow after compaction and intervening transient error pauses with recoverable resume", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);

  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "compact summary",
    tokensBefore: 100,
  });
  assert.equal(harness.snapshot().goal?.status, "active");

  await emitPersistentAssistantError(harness, 1, "websocket closed");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(
      { ...goal, status: "paused" },
      recoveryAttentionMessage("context window recovery failed after repeated compaction attempts"),
    ),
  );
});

test("repeated transient errors stay active with pending attention without hidden retries", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "websocket closed");
    assert.equal(harness.snapshot().goal?.status, "active");
  }

  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.compactCalls.length, 0);
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);
});

test("transient errors surface pending attention without pausing before host retry finishes", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(
      harness.snapshot().goal,
      recoveryPendingAttentionMessage("provider error (websocket closed)"),
    ),
  );
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);
});

test("/goal pause after pending transient error clears recovery attention", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);

  await harness.runCommand("pause");

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.footerStatuses.at(-1), formatFooterStatus(harness.snapshot().goal));
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal paused \(\/goal resume\)/);
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
});

test("/goal pause after pending overflow error clears recovery attention", async () => {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);

  await harness.runCommand("pause");

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.footerStatuses.at(-1), formatFooterStatus(harness.snapshot().goal));
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal paused \(\/goal resume\)/);
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
});

test("successful turns reset transient error counters and continue active goals", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const queuedMessage = queuedCustomMessage(queued);
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "keep going",
    systemPrompt: "",
    systemPromptOptions: {},
  });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 1,
    message: assistantMessage("stop", { input: 1, output: 1 }),
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 1, output: 1 })],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);

  harness.sentMessages.length = 0;
  await emitPersistentAssistantError(harness, 2, "websocket closed");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("exhausted context overflow retries show recoverable attention in footer", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "context_length_exceeded");
    await harness.emit("session_compact", {
      type: "session_compact",
      summary: "compact summary",
      tokensBefore: 100,
    });
  }

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(
      { ...goal, status: "paused" },
      recoveryAttentionMessage("context window recovery failed after repeated compaction attempts"),
    ),
  );
});

test("agent_end only counts recovered errors once per failed run", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  const errorMessage = assistantMessage("error", { input: 1, output: 1 }, "websocket closed");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: errorMessage,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [errorMessage],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.compactCalls.length, 0);
});

test("successful toolUse turns reset context overflow recovery counters", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  assert.equal(harness.compactCalls.length, 0);
  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "compact summary",
    tokensBefore: 100,
  });

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 1,
    message: assistantMessage("toolUse", { input: 1, output: 1 }),
    toolResults: [],
  });
  assert.equal(harness.sentMessages.length, 0);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("first overflow error shows recoverable attention while host recovery is pending", async () => {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(goal, recoveryPendingAttentionMessage(HOST_OVERFLOW_RECOVERY_REASON)),
  );
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);
});

test("overflow without session_compact stays active with pending overflow attention", async () => {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(goal, recoveryPendingAttentionMessage(HOST_OVERFLOW_RECOVERY_REASON)),
  );
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);
});

test("pending overflow shutdown persists paused goal with valid resume guidance", async () => {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);

  await harness.emit("session_shutdown", { type: "session_shutdown" });

  const pausedGoal = harness.snapshot().goal;
  assert.equal(pausedGoal?.status, "paused");
  assert.match(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(pausedGoal, recoveryAttentionMessage(HOST_OVERFLOW_RECOVERY_REASON)),
  );
});

test("pending transient shutdown persists paused goal with valid resume guidance", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);

  await harness.emit("session_shutdown", { type: "session_shutdown" });

  const pausedGoal = harness.snapshot().goal;
  assert.equal(pausedGoal?.status, "paused");
  assert.match(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(
      pausedGoal,
      recoveryAttentionMessage("provider error (websocket closed)"),
    ),
  );
});

test("session_start after pending transient shutdown does not auto-continue", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "websocket closed");
    assert.equal(harness.snapshot().goal?.status, "active");
  }

  await harness.emit("session_shutdown", { type: "session_shutdown" });
  assert.equal(harness.snapshot().goal?.status, "paused");

  harness.sentMessages.length = 0;
  await harness.emit("session_start", { type: "session_start", reason: "startup" });

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
});

test("session_tree with pending transient recovery does not auto-continue before shutdown", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("session_tree", { type: "session_tree" });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("session_tree with pending overflow recovery does not auto-continue before compaction", async () => {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("session_tree", { type: "session_tree" });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("session_tree after pending transient shutdown does not auto-continue", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  await harness.emit("session_shutdown", { type: "session_shutdown" });
  assert.equal(harness.snapshot().goal?.status, "paused");

  harness.sentMessages.length = 0;
  await harness.emit("session_tree", { type: "session_tree" });

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
});

test("session_start after pending overflow shutdown does not auto-continue", async () => {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  await harness.emit("session_shutdown", { type: "session_shutdown" });
  assert.equal(harness.snapshot().goal?.status, "paused");

  harness.sentMessages.length = 0;
  await harness.emit("session_start", { type: "session_start", reason: "startup" });

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
});

test("pending transient shutdown with stale queued abort pauses before session_tree", async () => {
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

  await harness.runCommand("ship it");
  const activeGoal = harness.snapshot().goal;
  assert.ok(activeGoal);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);

  await emitQueuedTurnThroughContext(harness, [oldMessage]);
  assert.equal(harness.abortCount, 1);

  await harness.emit("session_shutdown", { type: "session_shutdown" });

  const pausedGoal = harness.snapshot().goal;
  assert.equal(pausedGoal?.goalId, activeGoal.goalId);
  assert.equal(pausedGoal?.status, "paused");
  assert.match(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(
      pausedGoal,
      recoveryAttentionMessage("provider error (websocket closed)"),
    ),
  );

  harness.sentMessages.length = 0;
  await harness.emit("session_tree", { type: "session_tree" });

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
});

test("pending overflow shutdown with stale queued abort pauses before session_tree", async () => {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
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

  await harness.runCommand("ship it");
  const activeGoal = harness.snapshot().goal;
  assert.ok(activeGoal);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);

  await emitQueuedTurnThroughContext(harness, [oldMessage]);
  assert.equal(harness.abortCount, 1);

  await harness.emit("session_shutdown", { type: "session_shutdown" });

  const pausedGoal = harness.snapshot().goal;
  assert.equal(pausedGoal?.goalId, activeGoal.goalId);
  assert.equal(pausedGoal?.status, "paused");
  assert.match(harness.footerStatuses.at(-1) ?? "", /\/goal resume/);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(pausedGoal, recoveryAttentionMessage(HOST_OVERFLOW_RECOVERY_REASON)),
  );

  harness.sentMessages.length = 0;
  await harness.emit("session_tree", { type: "session_tree" });

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
});

function replaceHarnessBranchWithGoal(
  harness: RuntimeHarness,
  objective: string,
): ReturnType<typeof createThreadGoal> {
  const branchGoal = createThreadGoal(objective);
  harness.entries.length = 0;
  harness.entries.push({
    type: "custom",
    id: `entry-branch-${objective.replace(/\s+/g, "-")}`,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    customType: CUSTOM_ENTRY_TYPE,
    data: setEntry(branchGoal, "command"),
  });
  return branchGoal;
}

test("session_tree keeps same-goal pending transient recovery suppressed", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("goal A");
  const goalAId = harness.snapshot().goal?.goalId;
  assert.ok(goalAId);
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.snapshot().goal?.goalId, goalAId);
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("session_tree", { type: "session_tree" });

  assert.equal(harness.snapshot().goal?.goalId, goalAId);
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.equal(harness.sentMessages.length, 0);
});

test("session_tree to a different active goal clears stale transient recovery and continues", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("goal A");
  const goalAId = harness.snapshot().goal?.goalId;
  assert.ok(goalAId);
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.snapshot().goal?.goalId, goalAId);
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.equal(harness.sentMessages.length, 0);

  const goalB = replaceHarnessBranchWithGoal(harness, "goal B");
  assert.notEqual(goalB.goalId, goalAId);

  harness.footerStatuses.length = 0;
  harness.sentMessages.length = 0;
  await harness.emit("session_tree", { type: "session_tree" });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.goalId, goalB.goalId);
  assert.equal(goal?.objective, "goal B");
  assert.equal(goal?.status, "active");
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goalB.goalId,
  });
});

test("session_tree to a different active goal clears stale overflow recovery and continues", async () => {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand("goal A");
  const goalAId = harness.snapshot().goal?.goalId;
  assert.ok(goalAId);
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.goalId, goalAId);
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.equal(harness.sentMessages.length, 0);

  const goalB = replaceHarnessBranchWithGoal(harness, "goal B");
  assert.notEqual(goalB.goalId, goalAId);

  harness.footerStatuses.length = 0;
  harness.sentMessages.length = 0;
  await harness.emit("session_tree", { type: "session_tree" });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.goalId, goalB.goalId);
  assert.equal(goal?.status, "active");
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goalB.goalId,
  });
});

test("delayed session_compact keeps goal active without premature pause or extension follow-up", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("session_before_compact", {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    signal: new AbortController().signal,
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "compact summary",
    tokensBefore: 100,
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("/goal resume after non-retryable pause resets recovery counters", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(
    harness,
    0,
    "invalid tool call state: malformed function arguments",
  );
  assert.equal(harness.snapshot().goal?.status, "paused");

  harness.sentMessages.length = 0;
  await harness.runCommand("resume");
  assert.equal(harness.snapshot().goal?.status, "active");

  await emitPersistentAssistantError(harness, 1, "websocket closed");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
});

test("/goal resume after overflow pause resets recovery counters", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "context_length_exceeded");
    await harness.emit("session_compact", {
      type: "session_compact",
      summary: "compact summary",
      tokensBefore: 100,
    });
  }
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.hostOverflowRecoveryAttempted, true);

  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;
  await harness.runCommand("resume");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);
  const resumeMessage = harness.sentUserMessages[0];
  assert.ok(resumeMessage);
  assert.deepEqual(resumeMessage.options, { deliverAs: "followUp" });
  const content = resumeMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected overflow resume to send a user continuation prompt.");
  }
  assert.doesNotMatch(content, /<untrusted_objective>/);
  assert.equal(continuationGoalIdFromPrompt(content), harness.snapshot().goal?.goalId);

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "user", content },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, false);

  const contextResults = await harness.emit("context", {
    type: "context",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: content }],
        timestamp: 1,
      },
    ],
  });
  assert.equal(contextResults[0], undefined);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("/goal resume after overflow pause and session shutdown sends user turn and resets host overflow cap", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "context_length_exceeded");
    await harness.emit("session_compact", {
      type: "session_compact",
      summary: "compact summary",
      tokensBefore: 100,
    });
  }
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.hostOverflowRecoveryAttempted, true);

  await harness.emit("session_shutdown", { type: "session_shutdown" });
  assert.equal(harness.snapshot().goal?.status, "paused");

  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;
  await harness.runCommand("resume");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);
  const resumeMessage = harness.sentUserMessages[0];
  assert.ok(resumeMessage);
  assert.deepEqual(resumeMessage.options, { deliverAs: "followUp" });

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "user", content: resumeMessage.content },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, false);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("custom command_resume turn after host overflow exhaustion does not reset host recovery cap", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "context_length_exceeded");
    await harness.emit("session_compact", {
      type: "session_compact",
      summary: "compact summary",
      tokensBefore: 100,
    });
  }
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.hostOverflowRecoveryAttempted, true);

  await harness.emit("message_start", {
    type: "message_start",
    message: {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: continuationPrompt(goal),
      display: false,
      details: { kind: "command_resume", goalId: goal.goalId },
    },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, true);
});

test("custom command_start turn after host overflow exhaustion does not reset host recovery cap", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "context_length_exceeded");
    await harness.emit("session_compact", {
      type: "session_compact",
      summary: "compact summary",
      tokensBefore: 100,
    });
  }
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.hostOverflowRecoveryAttempted, true);

  await harness.emit("message_start", {
    type: "message_start",
    message: {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: continuationPrompt(goal),
      display: false,
      details: { kind: "command_start", goalId: goal.goalId },
    },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, true);
});

test("/goal new objective after overflow pause sends user turn and resets host overflow cap", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const previousGoal = harness.snapshot().goal;
  assert.ok(previousGoal);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "context_length_exceeded");
    await harness.emit("session_compact", {
      type: "session_compact",
      summary: "compact summary",
      tokensBefore: 100,
    });
  }
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.hostOverflowRecoveryAttempted, true);

  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;
  await harness.runCommand("ship the replacement");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  assert.equal(goal.status, "active");
  assert.equal(goal.objective, "ship the replacement");
  assert.notEqual(goal.goalId, previousGoal.goalId);
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);

  const startMessage = harness.sentUserMessages[0];
  assert.ok(startMessage);
  assert.deepEqual(startMessage.options, { deliverAs: "followUp" });
  const content = startMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected overflow replacement start to send a user continuation prompt.");
  }
  assert.match(content, /<pi_goal_continuation goal_id="/);
  assert.doesNotMatch(content, /<untrusted_objective>/);
  assert.equal(continuationGoalIdFromPrompt(content), goal.goalId);

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "user", content },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, false);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("/goal clear then start after overflow pause sends user turn and resets host overflow cap", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "context_length_exceeded");
    await harness.emit("session_compact", {
      type: "session_compact",
      summary: "compact summary",
      tokensBefore: 100,
    });
  }
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.hostOverflowRecoveryAttempted, true);

  await harness.runCommand("clear");
  assert.equal(harness.snapshot().goal, null);

  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;
  await harness.runCommand("ship the replacement");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  assert.equal(goal.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);

  const startMessage = harness.sentUserMessages[0];
  assert.ok(startMessage);
  const content = startMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected overflow clear-and-start to send a user continuation prompt.");
  }

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "user", content },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, false);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("/goal new objective after overflow pause survives extension reload and resets host overflow cap", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const previousGoal = harness.snapshot().goal;
  assert.ok(previousGoal);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "context_length_exceeded");
    await harness.emit("session_compact", {
      type: "session_compact",
      summary: "compact summary",
      tokensBefore: 100,
    });
  }
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.hostOverflowRecoveryAttempted, true);

  await harness.reloadSession();
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.hostOverflowRecoveryAttempted, true);

  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;
  await harness.runCommand("ship the replacement");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  assert.equal(goal.status, "active");
  assert.equal(goal.objective, "ship the replacement");
  assert.notEqual(goal.goalId, previousGoal.goalId);
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);

  const startMessage = harness.sentUserMessages[0];
  assert.ok(startMessage);
  const content = startMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected overflow replacement after reload to send a user continuation prompt.");
  }
  assert.doesNotMatch(content, /<untrusted_objective>/);
  assert.equal(continuationGoalIdFromPrompt(content), goal.goalId);

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "user", content },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, false);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("/goal clear then start after overflow pause survives extension reload and resets host overflow cap", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "context_length_exceeded");
    await harness.emit("session_compact", {
      type: "session_compact",
      summary: "compact summary",
      tokensBefore: 100,
    });
  }
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.hostOverflowRecoveryAttempted, true);

  await harness.reloadSession();
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.hostOverflowRecoveryAttempted, true);

  await harness.runCommand("clear");
  assert.equal(harness.snapshot().goal, null);

  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;
  await harness.runCommand("ship the replacement");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  assert.equal(goal.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);

  const startMessage = harness.sentUserMessages[0];
  assert.ok(startMessage);
  const content = startMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected overflow clear-and-start after reload to send a user continuation prompt.");
  }
  assert.doesNotMatch(content, /<untrusted_objective>/);

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "user", content },
  });
  assert.equal(harness.hostOverflowRecoveryAttempted, false);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("non-retryable provider errors pause active goals immediately", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(
    harness,
    0,
    "invalid tool call state: malformed function arguments",
  );

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(
      harness.snapshot().goal,
      recoveryAttentionMessage("non-retryable provider error (invalid tool call state: malformed function arguments)"),
    ),
  );
});

test("non-retryable provider error pause does not cancel host compaction", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(
    harness,
    0,
    "invalid tool call state: malformed function arguments",
  );

  assert.equal(harness.snapshot().goal?.status, "paused");

  const compaction = await harness.emit("session_before_compact", {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    signal: new AbortController().signal,
  });
  assert.notDeepEqual(compaction[0], { cancel: true });
});

test("varied retryable transient errors stay active without tripping signature-scoped cap", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  const errors = [
    "HTTP 500 internal server error",
    "HTTP 502 bad gateway",
    "HTTP 503 service unavailable",
    "HTTP 504 gateway timeout",
  ];

  for (let attempt = 0; attempt < errors.length; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, errors[attempt]!);
    assert.equal(harness.snapshot().goal?.status, "active");
  }

  assert.equal(harness.sentMessages.length, 0);
});

test("silent stop overflow suppresses continuation and shows overflow recovery attention", async () => {
  const harness = createRuntimeHarness({ contextWindow: 128_000 });
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  const overflowMessage = assistantMessage("stop", {
    input: 130_000,
    output: 0,
    cacheRead: 0,
  });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: overflowMessage,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [overflowMessage],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(goal, recoveryPendingAttentionMessage(HOST_OVERFLOW_RECOVERY_REASON)),
  );
});

test("zero-output length overflow suppresses continuation and shows overflow recovery attention", async () => {
  const harness = createRuntimeHarness({ contextWindow: 128_000 });
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  harness.sentMessages.length = 0;

  const overflowMessage = assistantMessage("length", {
    input: 127_000,
    output: 0,
    cacheRead: 1_000,
  });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: overflowMessage,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [overflowMessage],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(goal, recoveryPendingAttentionMessage(HOST_OVERFLOW_RECOVERY_REASON)),
  );
});

test("threshold session_compact after transient provider error preserves pending attention", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "threshold compact",
    tokensBefore: 100,
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(
    harness.footerStatuses.at(-1),
    formatFooterStatus(
      harness.snapshot().goal,
      recoveryPendingAttentionMessage("provider error (websocket closed)"),
    ),
  );
});

test("repeated silent stop overflow after host compaction pauses without blocking manual compaction", async () => {
  const harness = createRuntimeHarness({ contextWindow: 128_000 });
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  const firstOverflow = assistantMessage("stop", {
    input: 130_000,
    output: 0,
    cacheRead: 0,
  });
  await emitSilentContextOverflow(harness, 0, firstOverflow);

  const firstCompaction = await harness.emit("session_before_compact", {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    signal: new AbortController().signal,
  });
  assert.notDeepEqual(firstCompaction[0], { cancel: true });
  await harness.emit("session_compact", {
    type: "session_compact",
    summary: "compact summary",
    tokensBefore: 100,
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);

  const secondOverflow = assistantMessage("stop", {
    input: 131_000,
    output: 0,
    cacheRead: 0,
  });
  await emitSilentContextOverflow(harness, 1, secondOverflow);

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal needs attention/);

  const manualCompaction = await harness.emit("session_before_compact", {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    signal: new AbortController().signal,
  });
  assert.notDeepEqual(manualCompaction[0], { cancel: true });
  assert.equal(harness.sentMessages.length, 0);
});

test("repeated zero-output length overflow after host compaction pauses without blocking manual compaction", async () => {
  const harness = createRuntimeHarness({ contextWindow: 128_000 });
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  const firstOverflow = assistantMessage("length", {
    input: 127_000,
    output: 0,
    cacheRead: 1_000,
  });
  await emitSilentContextOverflow(harness, 0, firstOverflow);
  await emitHostSessionCompact(harness);

  assert.equal(harness.snapshot().goal?.status, "active");

  const secondOverflow = assistantMessage("length", {
    input: 128_000,
    output: 0,
    cacheRead: 1_000,
  });
  await emitSilentContextOverflow(harness, 1, secondOverflow);

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);

  const manualCompaction = await harness.emit("session_before_compact", {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    signal: new AbortController().signal,
  });
  assert.notDeepEqual(manualCompaction[0], { cancel: true });
});
