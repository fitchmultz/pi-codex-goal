import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

function tempRoot(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32" && command === "npm",
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

function copySource(root: string): string {
  const packageRoot = join(root, "package");
  mkdirSync(packageRoot);
  // No build output or adjacent dependencies: these must come from Pi itself.
  for (const path of ["package.json", "package-lock.json", "src", "extensions", "prompts"]) {
    if (existsSync(path)) cpSync(path, join(packageRoot, path), { recursive: true });
  }
  return packageRoot;
}

async function checkPackage(root: string, packageRoot: string, extension: ".ts" | ".js"): Promise<void> {
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noContextFiles: true,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    additionalExtensionPaths: [packageRoot],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1, "package must discover exactly one extension");
  assert.ok(loaded.extensions[0]?.resolvedPath.endsWith(extension));
  assert.deepEqual(loader.getPrompts().prompts.map((prompt) => prompt.name), ["create-goal"]);
  assert.ok(loaded.extensions[0]?.commands.has("goal"));

  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    noTools: "builtin",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });
  const runner = session.extensionRunner;
  try {
    assert.deepEqual(session.getActiveToolNames().sort(), ["create_goal", "get_goal", "update_goal"]);
    const call = async (name: string, params: Record<string, unknown>) => {
      const tool = runner.getToolDefinition(name);
      assert.ok(tool);
      return tool.execute(name, params, undefined, undefined, runner.createContext());
    };
    const created = await call("create_goal", { objective: "Verify the installed package" });
    assert.partialDeepStrictEqual(created.details, { goal: { objective: "Verify the installed package" } });
    assert.partialDeepStrictEqual((await call("get_goal", {})).details, { goal: { status: "active" } });
    assert.partialDeepStrictEqual((await call("update_goal", { status: "complete" })).details, { goal: { status: "complete" } });
    assert.partialDeepStrictEqual((await call("get_goal", {})).details, { goal: { status: "complete" } });
  } finally {
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
}

test("clean local source discovers and executes one goal extension without a build", async (t) => {
  const root = tempRoot(t);
  await checkPackage(root, copySource(root), ".ts");
});

test("Pi Git production install discovers and executes one goal extension without tsc", async (t) => {
  const root = tempRoot(t);
  const packageRoot = copySource(root);
  // Pi clones first, then runs npm install --omit=dev (not npm install <git-url>).
  run("npm", ["install", "--omit=dev", "--offline", "--no-audit", "--no-fund", "--cache", join(root, "npm-cache")], packageRoot);
  assert.equal(existsSync(join(packageRoot, "node_modules", "typescript")), false);
  assert.equal(existsSync(join(packageRoot, "dist")), false);
  await checkPackage(root, packageRoot, ".ts");
});

test("local source stays authoritative when build output is present", async (t) => {
  const root = tempRoot(t);
  const packageRoot = copySource(root);
  mkdirSync(join(packageRoot, "dist"));
  writeFileSync(join(packageRoot, "dist", "index.js"), 'throw new Error("stale build must not load");\n');
  await checkPackage(root, packageRoot, ".ts");
});

test("npm artifact discovers and executes one compiled goal extension without source or local peers", async (t) => {
  const root = tempRoot(t);
  const packs = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", root], process.cwd())) as Array<{ filename: string }>;
  assert.ok(packs[0]);
  run("tar", ["-xzf", join(root, packs[0].filename), "-C", root], process.cwd());
  const packageRoot = join(root, "package");
  assert.equal(existsSync(join(packageRoot, "src")), false);
  assert.equal(existsSync(join(packageRoot, "node_modules")), false);
  await checkPackage(root, packageRoot, ".js");
});
