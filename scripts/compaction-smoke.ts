/** Explicit, bounded paid qualification; never run by npm test. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import goalExtension from "../src/index.ts";
import { compactContinuationPrompt, escapeXmlText } from "../src/prompts.ts";
import { reconstructGoal } from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";

const { values } = parseArgs({ options: {
  live: { type: "boolean", default: false },
  models: { type: "string", default: "global.openai.gpt-6-luna,global.anthropic.claude-haiku-5-5" },
  output: { type: "string" },
} });
if (!values.live) throw new Error("Paid model calls require the explicit --live flag");
const output = values.output ?? mkdtempSync(join(tmpdir(), "goal-compaction-live-"));
mkdirSync(output, { recursive: true });
const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
const results: object[] = [];

function textOf(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  return Array.isArray(message.content) ? message.content.filter((part): part is { type: "text"; text: string } =>
    part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n") : "";
}

for (const id of values.models.split(",")) {
  const selected = modelRuntime.getModel("bedrock", id);
  if (!selected) throw new Error(`Missing configured model: bedrock/${id}`);
  const root = join(output, id.replaceAll("/", "-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true }); mkdirSync(agentDir, { recursive: true });
  // A conservative local context window forces a real threshold compaction. The
  // provider/model identity and auth stay unchanged; output is capped per call.
  const model = { ...selected, contextWindow: 18_000, maxTokens: 4_096 };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 5_000, keepRecentTokens: 1_200 }, retry: { enabled: false } });
  let phase = 0, compactions = 0, filteredInputs = 0, restoredGoals = 0;
  let expectedObjective = "";
  const requests: Array<{ epoch: number; kind: string; messages: unknown[] }> = [];
  const usage: object[] = [];
  const observer: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: "perform_phase", label: "Perform test phase", description: "Write and verify the next numbered test artifact. Run phases 1 through 4 in order.",
      parameters: Type.Object({ phase: Type.Integer({ minimum: 1, maximum: 4 }) }),
      executionMode: "sequential",
      async execute(_id, params) {
        assert.equal(params.phase, phase + 1, "test phases must be performed exactly once and in order");
        phase = params.phase;
        const path = join(cwd, `phase-${phase}.txt`), content = `PI_GOAL_COMPACTION_PHASE_${phase}\n`;
        writeFileSync(path, content);
        assert.equal(readFileSync(path, "utf8"), content);
        const padding = phase === 1 ? "\nSupplemental trace context:\n" + Array.from({ length: 220 }, (_, i) =>
          `Trace record ${i}: Each artifact is written once and then read back. The retained work is the verified file, its exact content, and the next numbered phase. Historical continuation prompts are scheduling signals, not additional task requirements.\n`).join("") : "";
        return { content: [{ type: "text", text: `Phase ${phase} verified: ${path} contains ${content.trim()}. ${phase < 4 ? `Next phase: ${phase + 1}.` : "All four phases verified; audit and complete the goal."}${padding}` }], details: { phase, path, verified: true } };
      },
    });
    pi.on("session_before_compact", (event) => {
      for (const message of [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages]) {
        assert.ok(!(message.role === "custom" && message.customType === CUSTOM_ENTRY_TYPE &&
          (message.details as { kind?: string } | undefined)?.kind === "continuation"), "goal control messages must not reach the summarizer");
      }
      filteredInputs++;
    });
    pi.on("session_compact", async (event, ctx) => {
      const goal = reconstructGoal(ctx.sessionManager.getBranch()).goal;
      assert.ok(goal);
      expectedObjective = goal.objective;
      usage.push({ source: "summary", epoch: compactions, ...event.compactionEntry.usage });
      compactions++;
      settingsManager.setCompactionEnabled(false); // Exactly one intentional cache boundary.
      // A large tool result can be indivisible at the retained boundary. The
      // small test window triggers compaction, but must not clamp later output
      // to one token when the real model still has ample context capacity.
      assert.ok(await pi.setModel({ ...selected, maxTokens: 4_096 }));
    });
    pi.on("message_end", (event) => {
      if (event.message.role === "assistant") usage.push({ source: "work", epoch: compactions, model: event.message.model, stopReason: event.message.stopReason, ...event.message.usage });
      if (compactions > 0 && event.message.role === "custom" && event.message.customType === CUSTOM_ENTRY_TYPE &&
          (event.message.details as { kind?: string } | undefined)?.kind === "continuation" && textOf(event.message).includes("<untrusted_objective>")) {
        assert.ok(textOf(event.message).includes(`<untrusted_objective>\n${escapeXmlText(expectedObjective)}\n</untrusted_objective>`));
        restoredGoals++;
      }
    });
  };
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [goalExtension, observer] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime, model, thinkingLevel: "low", settingsManager, sessionManager: SessionManager.create(cwd, join(root, "sessions")), noTools: "builtin" });
  let error: string | null = null;
  try {
    await session.bindExtensions({ mode: "print", onError(error) { throw new Error(error.error); } });
    const runner = session.extensionRunner, create = runner.getToolDefinition("create_goal");
    assert.ok(create);
    const objective = "Complete phases 1, 2, 3, and 4 exactly once, using perform_phase in order. The tool writes each phase file and verifies its exact sentinel content. After all four phases return verified, audit these four requirements and mark the goal complete through update_goal. After each phase except phase 4, end the assistant run with one sentence of verified progress and let the automatic goal continuation trigger the next phase. Do not pause or declare waiting; all work is local and immediately actionable. Report the four verified paths and final goal status.";
    await create.execute("smoke-create", { objective }, undefined, undefined, runner.createToolContext("smoke-create", undefined));
    const initial = reconstructGoal(session.sessionManager.getBranch()).goal;
    assert.ok(initial);
    // These are old answered scheduling signals. Only the summarization copy may
    // omit them; ordinary provider context must leave them unchanged.
    for (let i = 0; i < 8; i++) {
      await session.sendCustomMessage({ customType: CUSTOM_ENTRY_TYPE, content: compactContinuationPrompt(initial), display: false, details: { kind: "continuation", goalId: initial.goalId } }, { triggerTurn: false });
      session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: `Historical scheduling acknowledgement ${i}; no phase has run yet.` }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" });
    }
    const stream = session.agent.streamFunction;
    assert.ok(stream, "the SDK must expose its configured provider stream");
    session.agent.streamFunction = (requestModel, context, options) => {
      const kind = options?.cacheRetention === "none" ? "summary" : "work";
      if (requests.filter((request) => request.kind === "work").length >= 12 || requests.filter((request) => request.kind === "summary").length >= 3) throw new Error("bounded qualification request limit reached");
      const messages: unknown[] = JSON.parse(JSON.stringify(context.messages));
      const previous = requests.findLast((request) => request.kind === "work");
      if (kind === "work" && previous?.epoch === compactions) assert.deepEqual(messages.slice(0, previous.messages.length), previous.messages, "ordinary requests must extend the prior provider prefix unchanged");
      requests.push({ epoch: compactions, kind, messages });
      console.log(`${id}: ${kind} request ${requests.length}, epoch ${compactions}, phase ${phase}`);
      return stream(requestModel, context, options);
    };
    await session.prompt("Pursue the saved goal now. Call exactly one perform_phase per assistant response, with the next numbered phase. Wait for its receipt before choosing the next phase; do not batch phases. After each receipt, if phases remain, end this run with a short progress report and let the normal goal continuation start the next phase. Do not declare waiting or pause. Use its verification receipts for the completion audit. Continue until all four phases are verified and update_goal succeeds with status complete.");
    const deadline = Date.now() + 120_000;
    while (reconstructGoal(session.sessionManager.getBranch()).goal?.status !== "complete") {
      assert.equal(reconstructGoal(session.sessionManager.getBranch()).goal?.status, "active", "an incomplete test goal must remain active");
      assert.ok(Date.now() < deadline, "goal must complete without a stalled continuation");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await session.waitForIdle();
    assert.equal(phase, 4); assert.equal(compactions, 1); assert.equal(filteredInputs, 1); assert.equal(restoredGoals, 1);
    const entries = session.sessionManager.getBranch();
    const compactIndex = entries.findLastIndex((entry) => entry.type === "compaction");
    const continuations = entries.slice(compactIndex + 1).filter((entry) => entry.type === "custom_message" &&
      (entry.details as { kind?: string } | undefined)?.kind === "continuation");
    const fullGoals = continuations.filter((entry) => entry.type === "custom_message" && textOf(entry).includes("<untrusted_objective>"));
    assert.equal(fullGoals.length, 1, "one ordinary continuation carries the full goal after compaction");
    assert.ok(continuations.length >= 2, "also exercise subsequent compact continuations");
    for (let i = 1; i <= 4; i++) assert.equal(readFileSync(join(cwd, `phase-${i}.txt`), "utf8"), `PI_GOAL_COMPACTION_PHASE_${i}\n`);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  const result = { model: `bedrock/${id}`, passed: error === null, error, phase, compactions, filteredInputs, restoredGoals, workRequests: requests.filter((request) => request.kind === "work").length, summaryRequests: requests.filter((request) => request.kind === "summary").length, usage };
  results.push(result);
  writeFileSync(join(root, "report.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(join(root, "request-trace.json"), JSON.stringify(requests, null, 2) + "\n");
  console.log(JSON.stringify({ ...result, usage: undefined, cacheReads: usage.filter((row) => (row as { source?: string }).source === "work").map((row) => (row as { cacheRead?: number }).cacheRead) }));
}
writeFileSync(join(output, "report.json"), JSON.stringify(results, null, 2) + "\n");
console.log(`Reports: ${output}`);
if (results.some((result) => !(result as { passed: boolean }).passed)) process.exitCode = 1;
