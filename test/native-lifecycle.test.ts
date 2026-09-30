import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import goalExtension from "../src/index.ts";
import { reconstructGoal } from "../src/state.ts";

async function fixture(t: TestContext, recover = false) {
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
        if (event.reason === "manual") return;
        pi.appendEntry("goal-fixture-boundary", {});
        const leaf = ctx.sessionManager.getLeafId();
        assert.ok(leaf);
        return { compaction: { summary: "Continue the active goal", firstKeptEntryId: leaf, tokensBefore: event.preparation.tokensBefore } };
      });
    }],
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
  await h.session.prompt("/goal resume");
  // The slash handler schedules its continuation after returning; SDK idle is not that timer's completion.
  const deadline = Date.now() + 5_000;
  while (h.goal()?.status !== "complete") {
    assert.ok(Date.now() < deadline, "explicit resume must complete its scheduled native continuation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await h.session.waitForIdle();
  assert.equal(h.goal()?.status, "complete");
  assert.equal(h.goal()?.goalId, saved?.goalId);
  assert.equal(h.faux.state.callCount, 3);
});
