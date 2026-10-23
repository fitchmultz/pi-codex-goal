// Offline native CLI probe. Load only in an isolated agent directory, never in a live session.
import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const trace = process.env.GOAL_PROOF_TRACE;
  if (!trace) throw new Error("Set GOAL_PROOF_TRACE for the isolated delivery probe");
  const note = (event: unknown) => appendFileSync(trace, JSON.stringify(event) + "\n");
  let release: (() => void) | undefined;
  const faux = fauxProvider({ provider: "goal-proof", models: [{ id: "offline", contextWindow: 100_000, maxTokens: 1_000 }] });
  faux.setResponses([
    async (context) => {
      note({ type: "provider", phase: "held", messages: context.messages });
      await new Promise<void>((resolve) => { release = resolve; });
      return fauxAssistantMessage("Offline phase one finished.");
    },
    (context) => {
      note({ type: "provider", phase: "resumed", messages: context.messages });
      return fauxAssistantMessage(fauxToolCall("update_goal", { status: "complete" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Offline goal completed."),
  ]);
  pi.registerProvider(faux.provider);
  pi.registerCommand("proof-release", { description: "Release the isolated offline response", async handler() { release?.(); } });
  pi.registerShortcut("ctrl+shift+y", {
    description: "Record native editor text in the isolated proof",
    handler(ctx) { note({ type: "editor-snapshot", text: ctx.ui.getEditorText() }); },
  });
  pi.on("session_start", () => note({ type: "ready" }));
  pi.on("input", (event) => { note(event); });
  pi.on("message_start", (event) => { if (event.message.role === "user") note(event); });
  pi.on("agent_settled", () => note({ type: "settled" }));
}
