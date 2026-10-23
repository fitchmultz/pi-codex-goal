// Independent host boundary proof: custom content is provider-user content, but not native user input.
// Run with --import ./scripts/host-sdk.ts and an exact PI_SDK_PACKAGE. Never calls a live model.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";

const root = process.argv[2];
if (!root) throw new Error("Provide a new evidence output directory");
mkdirSync(root, { recursive: false });
const report = [];
for (const route of ["custom", "user"] as const) {
  const dir = join(root, route), cwd = join(dir, "project"), agentDir = join(dir, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir);
  const faux = fauxProvider({ models: [{ id: "role-boundary", contextWindow: 100_000, maxTokens: 1_000 }] });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 1 }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  let summaries = 0;
  const events: unknown[] = [];
  const factory: ExtensionFactory = (pi) => {
    pi.registerProvider(faux.provider);
    pi.on("session_before_compact", (event, ctx) => {
      summaries++;
      pi.appendEntry("offline-proof-boundary", {});
      const leaf = ctx.sessionManager.getLeafId();
      assert.ok(leaf);
      return { compaction: { summary: "Preserve the task.", firstKeptEntryId: leaf, tokensBefore: event.preparation.tokensBefore } };
    });
  };
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [factory] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, resourceLoader: loader,
    sessionManager: SessionManager.create(cwd, join(dir, "sessions")), model: faux.getModel(), noTools: "builtin" });
  await session.bindExtensions({ mode: "print", onError(error) { throw new Error(error.error); } });
  session.subscribe((event) => { if (event.type === "compaction_end" || event.type === "message_start") events.push(event); });
  const overflow = () => async () => {
    await new Promise((resolve) => setTimeout(resolve, 3));
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 100000 maximum" });
  };
  faux.setResponses([overflow(), overflow(), overflow(), fauxAssistantMessage("Recovered after explicit user reset.")]);
  try {
    await session.prompt("Exhaust one native compact-and-retry attempt.");
    await session.waitForIdle();
    assert.equal(summaries, 1);
    assert.equal(faux.state.callCount, 2);
    const before = summaries;
    if (route === "custom") {
      await session.sendCustomMessage({ customType: "role-proof", content: "Resume the saved task.", display: false,
        details: { kind: "command_resume", goalId: "offline-proof" } }, { triggerTurn: true, deliverAs: "followUp" });
    } else {
      await session.sendUserMessage("Resume the saved task.", { deliverAs: "followUp" });
    }
    await session.waitForIdle();
    const extraSummaries = summaries - before;
    assert.equal(extraSummaries, route === "user" ? 1 : 0, "only native user input resets exhausted overflow recovery");
    report.push({ route, providerCalls: faux.state.callCount, summaries, extraSummaries, sessionFile: session.sessionManager.getSessionFile() });
  } finally {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    writeFileSync(join(dir, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  }
}
writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
