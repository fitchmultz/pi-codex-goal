import assert from "node:assert/strict";
import { mock } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createEventBus,
  DefaultResourceLoader,
  ExtensionRunner,
  SessionManager,
  SettingsManager,
  type AgentToolResult,
  type BeforeAgentStartEvent,
  type Extension,
  type ExtensionAPI,
  type EventBusController,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionToolContext,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

import goalExtension from "../../src/index.ts";
import { CONTINUATION_RETRY_MS, PROVIDER_LIMIT_AUTO_RESUME_MS } from "../../src/runtime-config.ts";
import { isGoalCustomEntry, reconstructGoal } from "../../src/state.ts";
import { isQueuedGoalContextCarrier, type QueuedGoalContextCarrier } from "./context-messages.ts";
import { isRecord } from "../../src/validation.ts";
import { CUSTOM_ENTRY_TYPE } from "../../src/types.ts";
import { testModel, testModelRegistry, testUi } from "./sdk-fixture.ts";

export function userBeforeAgentStartEvent(
  prompt: string,
  systemPrompt = "",
): BeforeAgentStartEvent & { messageType: "user" } {
  const systemPromptOptions = {
    cwd: "/tmp",
    selectedTools: [],
    hiddenTools: [],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: "",
    sections: {},
    contextFiles: [],
    skills: [],
  };
  return {
    type: "before_agent_start",
    messageType: "user",
    prompt,
    systemPrompt,
    systemPromptOptions,
  } satisfies BeforeAgentStartEvent & { messageType: "user" };
}

export interface SentMessage {
  message: Parameters<ExtensionAPI["sendMessage"]>[0];
  options: Parameters<ExtensionAPI["sendMessage"]>[1];
}

export interface SentUserMessage {
  content: Parameters<ExtensionAPI["sendUserMessage"]>[0];
  options: Parameters<ExtensionAPI["sendUserMessage"]>[1];
}

type CompactionReason = "manual" | "threshold" | "overflow";

interface CompactionEventOptions {
  reason?: CompactionReason;
  willRetry?: boolean;
  summary?: string;
  tokensBefore?: number;
}

export function sessionBeforeCompactEvent(options: CompactionEventOptions = {}): object {
  return {
    type: "session_before_compact",
    preparation: {
      messagesToSummarize: [],
      turnPrefixMessages: [],
      firstKeptEntryId: "entry-1",
      isSplitTurn: false,
      tokensBefore: 100,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    },
    branchEntries: [],
    reason: options.reason ?? "manual",
    willRetry: options.willRetry ?? false,
    signal: new AbortController().signal,
  };
}

export function sessionCompactEvent(options: CompactionEventOptions = {}): object {
  const summary = options.summary ?? "compact summary";
  const tokensBefore = options.tokensBefore ?? 100;
  return {
    type: "session_compact",
    compactionEntry: {
      type: "compaction",
      id: "compaction-entry",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      summary,
      firstKeptEntryId: "entry-1",
      tokensBefore,
    },
    fromExtension: false,
    reason: options.reason ?? "manual",
    willRetry: options.willRetry ?? false,
  };
}

export function sessionShutdownEvent(
  reason: "quit" | "reload" | "new" | "resume" | "fork" = "quit",
): object {
  return { type: "session_shutdown", reason };
}

interface HarnessOptions {
  theme?: ExtensionCommandContext["ui"]["theme"];
  idle?: boolean;
  pendingMessages?: boolean;
  compactBehavior?: "success" | "error" | "unavailable";
  compactCompletion?: "immediate" | "manual";
  contextWindow?: number;
  contextUsage?: ReturnType<ExtensionContext["getContextUsage"]>;
}

type HarnessContext = ExtensionCommandContext &
  ExtensionToolContext & {
    runInBackground: (customType: string, work: unknown) => never;
  };
type CompactCall = NonNullable<Parameters<ExtensionContext["compact"]>[0]>;

export async function createRuntimeHarness(options: HarnessOptions = {}): Promise<RuntimeHarness> {
  const eventBus = createEventBus();
  const loader = new DefaultResourceLoader({
    cwd: "/tmp",
    agentDir: "/tmp/pi-goal-harness",
    settingsManager: SettingsManager.inMemory(),
    eventBus,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [goalExtension],
  });
  await loader.reload();
  return new RuntimeHarness(loader, eventBus, options);
}

export class RuntimeHarness {
  readonly entries: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]> = [];
  readonly sentMessages: SentMessage[] = [];
  readonly sentUserMessages: SentUserMessage[] = [];
  readonly compactCalls: CompactCall[] = [];
  readonly footerStatuses: Array<string | undefined> = [];
  readonly ui: ExtensionCommandContext["ui"];
  readonly context: HarnessContext;
  private readonly loader: DefaultResourceLoader;
  private readonly eventBus: EventBusController;
  private extension: Extension;
  private entryIndex = 0;
  private readonly runtime: {
    abortCount: number;
    idle: boolean;
    pendingMessages: boolean;
    compactBehavior: NonNullable<HarnessOptions["compactBehavior"]>;
    compactCompletion: NonNullable<HarnessOptions["compactCompletion"]>;
    contextUsage: HarnessOptions["contextUsage"];
  };

  constructor(
    loader: DefaultResourceLoader,
    eventBus: EventBusController,
    options: HarnessOptions,
  ) {
    this.eventBus = eventBus;
    this.loader = loader;
    this.extension = this.loadedExtension();
    this.runtime = {
      abortCount: 0,
      idle: options.idle ?? true,
      pendingMessages: options.pendingMessages ?? false,
      compactBehavior: options.compactBehavior ?? "success",
      compactCompletion: options.compactCompletion ?? "immediate",
      contextUsage: options.contextUsage,
    };
    const sessionManager = SessionManager.inMemory("/tmp");
    sessionManager.getBranch = () => this.entries;
    sessionManager.getEntries = () => this.entries;
    sessionManager.buildContextEntries = () => this.entries;
    this.bindActions();
    const runner = new ExtensionRunner(
      [this.extension],
      loader.getExtensions().runtime,
      "/tmp",
      sessionManager,
      testModelRegistry,
    );
    this.ui = {
      ...testUi(),
      ...(options.theme ? { theme: options.theme } : {}),
      setStatus: (_key, status) => {
        this.footerStatuses.push(status);
      },
    };
    const native = runner.createCommandContext();
    this.context = {
      ...native,
      runInBackground: (_customType: string, _work: unknown): never => {
        throw new Error("ctx.runInBackground is not implemented in this test harness.");
      },
      tools: [],
      executeTool: () => {
        throw new Error("ctx.executeTool is not implemented in this test harness.");
      },
      abort: () => {
        this.runtime.abortCount += 1;
      },
      compact: this.compact,
      getContextUsage: () => this.runtime.contextUsage,
      getSystemPrompt: () => "",
      getSystemPromptOptions: () => ({ cwd: "/tmp" }),
      hasPendingMessages: () => this.runtime.pendingMessages,
      isIdle: () => this.runtime.idle,
      isProjectTrusted: () => true,
      hasUI: true,
      mode: "tui",
      model: options.contextWindow === undefined ? undefined : testModel(options.contextWindow),
      ui: this.ui,
    };
  }

  private loadedExtension(): Extension {
    const loaded = this.loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const [extension] = loaded.extensions;
    assert.ok(extension);
    return extension;
  }

  private bindActions(): void {
    const runtime = this.loader.getExtensions().runtime;
    runtime.appendEntry = (customType, data) => {
      this.entries.push({
        type: "custom",
        id: `entry-${++this.entryIndex}`,
        parentId: null,
        timestamp: new Date(0).toISOString(),
        customType,
        data,
      });
    };
    runtime.sendMessage = (message, options) => {
      this.sentMessages.push({ message, options });
    };
    runtime.sendUserMessage = (content, options) => {
      this.sentUserMessages.push({ content, options });
    };
    runtime.getThinkingLevel = () => "medium";
  }

  private readonly compact: ExtensionContext["compact"] = (options) => {
    const call: CompactCall = {};
    if (options?.customInstructions !== undefined) {
      call.customInstructions = options.customInstructions;
    }
    if (options?.onComplete) {
      call.onComplete = options.onComplete;
    }
    if (options?.onError) {
      call.onError = options.onError;
    }
    this.compactCalls.push(call);
    if (this.runtime.compactBehavior === "unavailable") {
      throw new Error("ctx.compact is not implemented in this test harness.");
    }
    if (this.runtime.compactBehavior === "error") {
      options?.onError?.(new Error("compaction failed"));
      return;
    }
    if (this.runtime.compactCompletion === "immediate") {
      options?.onComplete?.({
        summary: "compact summary",
        tokensBefore: 100,
        firstKeptEntryId: "entry-1",
      });
    }
  };

  async reloadSession(reason: "startup" | "reload" | "resume" = "startup"): Promise<void> {
    this.eventBus.clear();
    await this.loader.reload();
    this.extension = this.loadedExtension();
    this.bindActions();
    await this.emit("session_start", { type: "session_start", reason });
  }

  async runCommand(args: string): Promise<void> {
    const command = this.extension.commands.get("goal");
    assert.ok(command);
    await command.handler(args, this.context);
  }

  async emit(event: string, payload: object): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.extension.handlers.get(event) ?? []) {
      results.push(await handler(payload, this.context));
    }
    return results;
  }

  async runTool(
    name: string,
    params: Record<string, unknown>,
    toolCallId = "tool-call",
  ): Promise<AgentToolResult<unknown>> {
    const tool = this.extension.tools.get(name);
    assert.ok(tool, `Expected tool ${name} to be registered.`);
    return tool.definition.execute(
      toolCallId,
      params,
      this.context.signal,
      undefined,
      this.context,
    );
  }

  appendMessage(message: SessionMessageEntry["message"]): void {
    this.entries.push({
      type: "message",
      id: `entry-${++this.entryIndex}`,
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message,
    });
  }

  clearSentMessages(): void {
    this.sentMessages.length = 0;
  }
  clearSentUserMessages(): void {
    this.sentUserMessages.length = 0;
  }
  replaceBranch(entries: readonly (typeof this.entries)[number][]): void {
    this.entries.splice(0, this.entries.length, ...entries);
  }

  setIdle(idle: boolean): void {
    this.runtime.idle = idle;
  }
  setPendingMessages(pendingMessages: boolean): void {
    this.runtime.pendingMessages = pendingMessages;
  }
  setContextUsage(contextUsage: ReturnType<ExtensionContext["getContextUsage"]>): void {
    this.runtime.contextUsage = contextUsage;
  }
  setContextWindow(contextWindow: number): void {
    this.context.model = testModel(contextWindow);
  }
  get abortCount(): number {
    return this.runtime.abortCount;
  }
  snapshot(): ReturnType<typeof reconstructGoal> {
    return reconstructGoal(this.entries);
  }
}

export interface TestAssistantUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export function flushContinuationScheduler(): void {
  mock.timers.tick(CONTINUATION_RETRY_MS);
}

export function fireProviderLimitAutoResume(): void {
  mock.timers.tick(PROVIDER_LIMIT_AUTO_RESUME_MS);
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

export function countGoalUsageEntries(
  entries: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]>,
  goalId?: string,
): number {
  return entries.filter((entry) => {
    return (
      entry.type === "custom" &&
      entry.customType === CUSTOM_ENTRY_TYPE &&
      isGoalCustomEntry(entry.data) &&
      entry.data.kind === "usage" &&
      (goalId === undefined || entry.data.goalId === goalId)
    );
  }).length;
}

export async function emitToolExecutionEnd(harness: RuntimeHarness): Promise<void> {
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

export async function deliverQueuedMessage(
  harness: RuntimeHarness,
  sent: SentMessage,
): Promise<QueuedGoalContextCarrier> {
  const message = queuedCustomMessage(sent);
  await harness.emit("message_start", { type: "message_start", message });
  await emitMessageEnd(harness, message);
  return message;
}

export function goalCustomContextMessage(options: {
  content: string;
  details: Record<string, unknown>;
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

  assert.ok(isRecord(result), "Expected provider context handler result object.");
  const candidate = result;
  assert.ok(Array.isArray(candidate.messages), "Expected provider context handler messages array.");

  const messages: QueuedGoalContextCarrier[] = [];
  for (const [index, message] of candidate.messages.entries()) {
    assert.ok(
      isQueuedGoalContextCarrier(message),
      `Expected provider context message ${index} to include a numeric timestamp.`,
    );
    messages.push(message);
  }

  return { messages };
}

export function goalUserContextMessage(text: string, timestamp = 1): QueuedGoalContextCarrier {
  const content = [{ type: "text", text }];
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

export async function emitQueuedTurnThroughContext(
  harness: RuntimeHarness,
  messages: QueuedGoalContextCarrier[],
  turnIndex = 0,
): Promise<ProviderContextHandlerResult[]> {
  await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  for (const message of messages) {
    await harness.emit("message_start", { type: "message_start", message });
    await emitMessageEnd(harness, message);
  }
  const results = await harness.emit("context", { type: "context", messages });
  return results.map(parseProviderContextHandlerResult);
}

/** Emits `message_end` and, like Pi, replaces the delivered message in place with any handler replacement. */
export async function emitMessageEnd(
  harness: RuntimeHarness,
  message: QueuedGoalContextCarrier,
): Promise<void> {
  const results = await harness.emit("message_end", { type: "message_end", message });
  for (const result of results) {
    if (result === undefined) {
      continue;
    }
    assert.ok(
      isRecord(result) && "message" in result,
      "Expected a message_end replacement result.",
    );
    const replacement = result.message;
    assert.ok(isRecord(replacement), "Expected a replacement message.");
    for (const key of Object.keys(message)) {
      Reflect.deleteProperty(message, key);
    }
    Object.assign(message, replacement);
  }
}

export function assistantMessage(
  stopReason: "stop" | "aborted" | "length" | "toolUse" | "error",
  usage: TestAssistantUsage,
  errorMessage?: string,
): AssistantMessage {
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
  harness: RuntimeHarness,
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
}

export async function emitHostSessionCompact(
  harness: RuntimeHarness,
  options: CompactionEventOptions = {},
): Promise<void> {
  const eventOptions: CompactionEventOptions = { reason: "overflow", ...options };
  await harness.emit("session_before_compact", sessionBeforeCompactEvent(eventOptions));
  await harness.emit("session_compact", sessionCompactEvent(eventOptions));
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
}
