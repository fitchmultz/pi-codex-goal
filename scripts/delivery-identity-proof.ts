// Acceptance probe, not a passing regression: exit 1 means genuine user input was lost.
// Use the exact host graph through scripts/host-sdk.ts. All session evidence is retained.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import goalExtension from "../src/index.ts";
import { compactContinuationPrompt } from "../src/prompts.ts";
import { reconstructGoal } from "../src/state.ts";

function oversizedImage() {
  const width = 3000, height = 8, header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), data]), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, checksum]);
  };
  return { type: "image" as const, mimeType: "image/png", data: Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((1 + width * 4) * height))), chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64") };
}

const root = process.argv[2];
if (!root) throw new Error("Provide a new evidence output directory");
mkdirSync(root, { recursive: false });
const report = [];
for (const { name, image, leadingMarker } of [
  { name: "text-control", image: false, leadingMarker: true },
  { name: "resized-image", image: true, leadingMarker: true },
  { name: "prefixed-image-control", image: true, leadingMarker: false },
]) {
  const dir = join(root, name), cwd = join(dir, "project"), agentDir = join(dir, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir);
  const faux = fauxProvider({ models: [{ id: "identity-proof", contextWindow: 100_000, maxTokens: 1_000 }] });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [goalExtension, (pi) => { pi.registerProvider(faux.provider); }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, resourceLoader: loader,
    sessionManager: SessionManager.create(cwd, join(dir, "sessions")), model: faux.getModel(), noTools: "builtin" });
  await session.bindExtensions({ mode: "print", onError(error) { throw new Error(error.error); } });
  const events: unknown[] = [];
  session.subscribe((event) => { if (event.type === "message_start" || event.type === "compaction_end") events.push(event); });
  try {
    const runner = session.extensionRunner, create = runner.getToolDefinition("create_goal");
    assert.ok(create);
    await create.execute("create", { objective: "Keep genuine pasted data independent of Goal controls" }, undefined, undefined, runner.createToolContext("create", undefined));
    await session.prompt("/goal pause");
    const saved = reconstructGoal(session.sessionManager.getBranch()).goal;
    assert.equal(saved?.status, "paused");
    assert.ok(saved);
    // This is genuine interactive input, not an extension delivery. The same text is legal user data.
    const text = (leadingMarker ? "" : "Inspect this literal data:\n") + compactContinuationPrompt(saved) + "\nKEEP_GENUINE_CAPTION";
    faux.setResponses([fauxAssistantMessage("Genuine user data answered.")]);
    await session.prompt(text, image ? { images: [oversizedImage()] } : undefined);
    await session.waitForIdle();
    const user = session.messages.findLast((message) => message.role === "user");
    assert.ok(user?.role === "user");
    const stored = typeof user.content === "string" ? user.content : user.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    assert.ok(stored.startsWith(text), "the native input reached normalized user-message storage");
    if (image) assert.match(stored, /\[Image: original 3000x8, displayed at/);
    report.push({ image, leadingMarker, providerCalls: faux.state.callCount, expectedProviderCalls: 1, acceptancePassed: faux.state.callCount === 1,
      captionPreserved: stored.includes("KEEP_GENUINE_CAPTION"), resizeNotePresent: stored.includes("[Image: original"),
      goalStatus: reconstructGoal(session.sessionManager.getBranch()).goal?.status, sessionFile: session.sessionManager.getSessionFile() });
  } finally {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    writeFileSync(join(dir, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  }
}
writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (report.some((row) => !row.acceptancePassed)) process.exitCode = 1;
