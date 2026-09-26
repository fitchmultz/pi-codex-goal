import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { InMemoryCredentialStore, validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
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
  const sessionManager = SessionManager.create(cwd, root);
  const sessionFile = sessionManager.getSessionFile();
  assert.ok(sessionFile);
  writeFileSync(sessionFile, `${JSON.stringify(sessionManager.getHeader())}\n`);
  sessionManager.setSessionFile(sessionFile);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    noTools: "builtin",
    resourceLoader: loader,
    sessionManager,
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
    const createGoal = runner.getToolDefinition("create_goal");
    assert.ok(createGoal);
    const validateCreate = (args: ToolCall["arguments"]) => validateToolArguments(createGoal, {
      type: "toolCall", id: "create", name: "create_goal", arguments: args,
    });
    const rejectBudget = async (args: ToolCall["arguments"]) => {
      const before = await call("get_goal", {});
      const entries = structuredClone(sessionManager.getEntries());
      const persisted = readFileSync(sessionFile, "utf8");
      assert.throws(() => validateCreate(args), /token_budget/);
      // Direct execution bypasses Pi's schema validation (as tool_call mutations can).
      await assert.rejects(() => call("create_goal", args), /integer of at least 500000/);
      assert.deepEqual(await call("get_goal", {}), before);
      assert.deepEqual(sessionManager.getEntries(), entries);
      assert.equal(readFileSync(sessionFile, "utf8"), persisted);
    };
    await rejectBudget({ objective: "Too small", token_budget: 499_999 });
    await rejectBudget({ objective: "Too small after native conversion", token_budget: 499_999.5 });
    assert.partialDeepStrictEqual(createGoal.parameters, {
      properties: { token_budget: { type: "integer", minimum: 500_000 } },
      required: ["objective"],
    });

    const unlimited = { objective: "Verify the installed package" };
    assert.deepEqual(validateCreate(unlimited), unlimited);
    const created = await call("create_goal", unlimited);
    assert.partialDeepStrictEqual(created.details, {
      goal: { objective: unlimited.objective, status: "active", tokenBudget: null }, remainingTokens: null,
    });
    assert.partialDeepStrictEqual((await call("get_goal", {})).details, { goal: { status: "active" } });
    assert.partialDeepStrictEqual((await call("update_goal", { status: "complete" })).details, { goal: { status: "complete" } });
    assert.partialDeepStrictEqual((await call("get_goal", {})).details, { goal: { status: "complete" } });
    await rejectBudget({ objective: "Too small after completion", token_budget: 499_999 });

    const minimum = { objective: "Exact minimum", token_budget: 500_000 };
    assert.deepEqual(validateCreate(minimum), minimum);
    // Pi truncates numeric fractions before validation; raw execution still requires an integer.
    const fractional = { ...minimum, token_budget: 500_000.5 };
    assert.deepEqual(validateCreate(fractional), minimum);
    await assert.rejects(() => call("create_goal", fractional), /integer of at least 500000/);
    assert.partialDeepStrictEqual((await call("create_goal", minimum)).details, {
      goal: { objective: minimum.objective, status: "active", tokenBudget: 500_000 }, remainingTokens: 500_000,
    });

    const legacyGoal = {
      goalId: "saved-small-budget",
      objective: "Keep the saved goal unchanged",
      status: "active",
      tokenBudget: 123,
      usage: { tokensUsed: 50, activeSeconds: 7 },
      createdAt: 1,
      updatedAt: 2,
    };
    sessionManager.appendCustomEntry("pi-codex-goal", {
      version: 1, kind: "set", source: "tool", goal: legacyGoal, at: 2,
    });
    const persisted = readFileSync(sessionFile, "utf8");
    sessionManager.setSessionFile(sessionFile);
    await runner.emit({ type: "session_start", reason: "reload" });
    assert.partialDeepStrictEqual((await call("get_goal", {})).details, {
      goal: {
        goalId: legacyGoal.goalId, objective: legacyGoal.objective, status: "active", tokenBudget: 123,
        tokensUsed: 50, timeUsedSeconds: 7, createdAt: 1, updatedAt: 2,
      },
      remainingTokens: 73,
    });
    assert.equal(readFileSync(sessionFile, "utf8"), persisted);
    await rejectBudget({ objective: "Too small replacement", token_budget: 499_999, replace_existing: true });

    const replacement = { ...minimum, replace_existing: true };
    assert.deepEqual(validateCreate(replacement), replacement);
    assert.partialDeepStrictEqual((await call("create_goal", replacement)).details, {
      goal: { objective: minimum.objective, status: "active", tokenBudget: 500_000 }, remainingTokens: 500_000,
    });
    assert.partialDeepStrictEqual((await call("create_goal", { ...unlimited, replace_existing: true })).details, {
      goal: { objective: unlimited.objective, status: "active", tokenBudget: null }, remainingTokens: null,
    });
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
  // npm 11 prints an array; npm 12 prints an object keyed by package name.
  const packs = Object.values(JSON.parse(run("npm", ["pack", "--json", "--pack-destination", root], process.cwd())) as Record<string, { filename: string }>);
  assert.ok(packs[0]);
  // A Windows drive colon in the archive argument means a remote host to GNU tar.
  run("tar", ["-xzf", packs[0].filename], root);
  const packageRoot = join(root, "package");
  assert.equal(existsSync(join(packageRoot, "src")), false);
  assert.equal(existsSync(join(packageRoot, "node_modules")), false);
  await checkPackage(root, packageRoot, ".js");
});
