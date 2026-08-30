import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const EXPECTED_CREATE_GOAL_COMPLETION_AUDIT_BLOCK = [
  "5. Completion audit",
  "   - Before marking the goal complete, map every explicit requirement in the goal to fresh evidence from files, commands, diffs, tests, screenshots, artifacts, or logs.",
  "   - The goal is not complete if any requirement is unverified, narrowed, deferred, or only probably satisfied.",
  '   - Phrases like "for the scope this is complete", "good enough", "out of scope", or "remaining tech debt" are not valid completion evidence unless the original user task explicitly allowed that limitation.',
].join("\n");

function frontmatter(prompt: string): Record<string, string> {
  const match = /^---\n(?<body>[\s\S]*?)\n---\n/.exec(prompt);
  assert.ok(match?.groups?.body, "prompt has frontmatter");

  return Object.fromEntries(
    match.groups.body.split("\n").map((line) => {
      const separator = line.indexOf(":");
      assert.notEqual(separator, -1, `frontmatter line has key/value: ${line}`);
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    }),
  );
}

test("package exposes compiled runtime and create-goal prompt entrypoints", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    main?: string;
    files?: string[];
    pi?: { extensions?: string[]; prompts?: string[] };
    scripts?: { prepack?: string };
  };

  assert.equal(packageJson.main, "dist/index.js");
  assert.deepEqual(packageJson.pi?.extensions, ["./dist/index.js"]);
  assert.ok(packageJson.files?.includes("dist"));
  assert.equal(packageJson.files?.includes("src"), false);
  assert.equal(packageJson.scripts?.prepack, "npm run build");
  assert.ok(packageJson.files?.includes("prompts"));
  assert.ok(packageJson.pi?.prompts?.includes("./prompts"));
});

test("create-goal prompt keeps package frontmatter and expected completion-audit text", () => {
  const prompt = readFileSync("prompts/create-goal.md", "utf8");
  const metadata = frontmatter(prompt);

  assert.equal(metadata.description, "Convert a plain task into a strict evidence-based pi-codex goal and create it");
  assert.equal(metadata["argument-hint"], '"<task>"');
  assert.match(prompt, /Turn the user task into exactly one durable pi-codex-goal objective/);
  assert.match(prompt, /pass `replace_existing: true`/);
  assert.match(prompt, /Do not set a token budget limit unless the user explicitly provides a budget\/limit/);
  assert.ok(prompt.includes(EXPECTED_CREATE_GOAL_COMPLETION_AUDIT_BLOCK));
});
