import assert from "node:assert/strict";
import { mock } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import goalExtension, { __testHooks } from "../../src/index.js";
import { isContextOverflowError } from "../../src/recovery.js";
import { isGoalCustomEntry, reconstructGoal } from "../../src/state.js";
import {
  toQueuedGoalContextCarrier,
  type ActiveGoalQueuedDetails,
  type QueuedGoalContextCarrier,
  type QueuedGoalContextInput,
  type QueuedGoalUserContent,
} from "../../src/queued-goal-messages.js";
import { CUSTOM_ENTRY_TYPE } from "../../src/types.js";

type EventHandler = (event: object, ctx: ExtensionContext) => unknown | Promise<unknown>;

export interface SentMessage {
  message: Parameters<ExtensionAPI["sendMessage"]>[0];
  options: Parameters<ExtensionAPI["sendMessage"]>[1];
}

export interface SentUserMessage {
  content: Parameters<ExtensionAPI["sendUserMessage"]>[0];
  options: Parameters<ExtensionAPI["sendUserMessage"]>[1];
}

export function createRuntimeHarness(options: {
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

export interface TestAssistantUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export function flushContinuationScheduler(): void {
  mock.timers.tick(__testHooks.continuationRetryMs);
}

export function countGoalSetEntries(
  entries: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]>,
  goalId?: string,
): number {
  return entries.filter((entry) => {
    return (
      entry.type === "custom" &&
      entry.customType === CUSTOM_ENTRY_TYPE &&
      isGoalCustomEntry(entry.data) &&
      entry.data.kind === "set" &&
      (goalId === undefined || entry.data.goal.goalId === goalId)
    );
  }).length;
}

export async function emitToolExecutionEnd(harness: ReturnType<typeof createRuntimeHarness>): Promise<void> {
  await harness.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "tool-call",
    toolName: "bash",
    args: {},
    result: {},
    isError: false,
  });
}

export function queuedCustomMessage(sent: SentMessage, timestamp = 1): QueuedGoalContextCarrier {
  return {
    role: "custom",
    customType: sent.message.customType,
    content: sent.message.content,
    display: sent.message.display,
    details: sent.message.details,
    timestamp,
  };
}

export function goalCustomContextMessage(options: {
  content: string;
  details: ActiveGoalQueuedDetails | Record<string, unknown>;
  display?: boolean;
  timestamp: number;
}): QueuedGoalContextCarrier {
  return {
    role: "custom",
    customType: CUSTOM_ENTRY_TYPE,
    content: options.content,
    display: options.display ?? false,
    details: options.details,
    timestamp: options.timestamp,
  };
}

export interface ProviderContextResult {
  messages: QueuedGoalContextCarrier[];
}

export type ProviderContextHandlerResult = ProviderContextResult | undefined;

function parseProviderContextHandlerResult(result: unknown): ProviderContextHandlerResult {
  if (result === undefined) {
    return undefined;
  }

  assert.ok(result && typeof result === "object", "Expected provider context handler result object.");
  const candidate = result as { messages?: unknown };
  assert.ok(Array.isArray(candidate.messages), "Expected provider context handler messages array.");

  const messages: QueuedGoalContextCarrier[] = [];
  for (const [index, message] of candidate.messages.entries()) {
    const carrier = toQueuedGoalContextCarrier(message as QueuedGoalContextInput);
    assert.ok(carrier, `Expected provider context message ${index} to include a numeric timestamp.`);
    messages.push(carrier);
  }

  return { messages };
}

export function requireProviderContextResult(
  results: ProviderContextHandlerResult[],
): ProviderContextResult {
  const result = results[0];
  if (result === undefined) {
    assert.fail("Expected provider context handler to return rewritten messages.");
  }
  return result;
}

export function providerContextMessageAt(
  result: ProviderContextResult,
  index: number,
): QueuedGoalContextCarrier {
  const message = result.messages[index];
  assert.ok(message, `Expected provider context message at index ${index}.`);
  return message;
}

export function goalUserContextMessage(text: string, timestamp = 1): QueuedGoalContextCarrier {
  const content: QueuedGoalUserContent = [{ type: "text", text }];
  return {
    role: "user",
    content,
    timestamp,
  };
}

export async function emitProviderContext(
  harness: RuntimeHarness,
  messages: QueuedGoalContextCarrier[],
): Promise<ProviderContextHandlerResult[]> {
  const results = await harness.emit("context", { type: "context", messages });
  return results.map(parseProviderContextHandlerResult);
}

export type RuntimeHarness = ReturnType<typeof createRuntimeHarness>;

export async function emitQueuedTurnThroughContext(
  harness: RuntimeHarness,
  messages: QueuedGoalContextCarrier[],
  turnIndex = 0,
): Promise<ProviderContextHandlerResult[]> {
  await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  for (const message of messages) {
    await harness.emit("message_start", { type: "message_start", message });
    await harness.emit("message_end", { type: "message_end", message });
  }
  const results = await harness.emit("context", { type: "context", messages });
  return results.map(parseProviderContextHandlerResult);
}

export function assistantMessage(
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

export async function emitPersistentAssistantError(
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

export async function emitHostSessionCompact(harness: RuntimeHarness): Promise<void> {
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

export async function emitSilentContextOverflow(
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
