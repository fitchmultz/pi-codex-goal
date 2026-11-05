import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../src/validation.ts";
import { CHECKS } from "./check.ts";
import { checkSource } from "./quality-source.ts";

const SOURCE = /\.[cm]?[jt]sx?$/;
const FORMAT = /\.(?:[cm]?[jt]sx?|jsonc?|mdx?|ya?ml|css|scss|less|html|vue|svelte|graphql|gql)$/;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMMANDS = {
  check: "node scripts/check.ts",
  lint: "oxlint --deny-warnings .",
  "lint:agent": "oxlint --deny-warnings --format=agent .",
  "lint:fix": "oxlint --fix .",
  format: "oxfmt --write .",
  "format:check": "oxfmt --check .",
  typecheck: "tsc",
  "policy:check": "node scripts/quality-policy.ts",
  test: "node --test test/*.test.ts",
  "test:quality": "node --test test/quality/*.test.ts",
  "pack:check": "npm pack --dry-run",
  "check:compat": "npm run check",
  prepublishOnly: "npm run check",
};

function command(root: string, executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { cwd: root, encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  assert.equal(result.status, 0, `${executable} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function record(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.ok(isRecord(value), "Expected a JSON object");
  return value;
}

function standardBlock(standard: string, heading: string): Record<string, unknown> {
  const section = standard.indexOf(heading);
  assert.ok(section >= 0, `Missing standard section: ${heading}`);
  const start = standard.indexOf("```json\n", section);
  const end = standard.indexOf("\n```", start);
  assert.ok(start > section && end > start, `Missing JSON in ${heading}`);
  return record(standard.slice(start + "```json\n".length, end));
}

function checkLintConfig(root: string, standard: string): void {
  const expected = standardBlock(standard, "## Appendix A:");
  assert.ok(Array.isArray(expected.overrides));
  const tests: unknown = expected.overrides[0];
  assert.ok(isRecord(tests) && Array.isArray(tests.files));
  tests.files.push("test/support/**/*.ts");
  assert.ok(isRecord(expected.rules));
  const floating: unknown = expected.rules["typescript/no-floating-promises"];
  assert.ok(Array.isArray(floating) && isRecord(floating[1]));
  expected.overrides.push({
    files: ["test/**/*.test.ts"],
    rules: {
      "typescript/no-floating-promises": [
        "error",
        {
          ...floating[1],
          allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["nodeTest"] }],
        },
      ],
    },
  });
  assert.deepEqual(
    record(readFileSync(join(root, ".oxlintrc.json"), "utf8")),
    expected,
    "Oxlint policy differs from Appendix A and QX-001",
  );
}

function checkConfiguration(root: string, standard: string, inventory: string[]): void {
  checkLintConfig(root, standard);
  assert.deepEqual(
    record(readFileSync(join(root, ".oxfmtrc.json"), "utf8")),
    standardBlock(standard, "### 7.1 Formatter ownership"),
    "Formatter policy differs",
  );
  const manifest = record(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(isRecord(manifest.scripts));
  for (const [name, expected] of Object.entries(COMMANDS)) {
    assert.equal(manifest.scripts[name], expected, `Required command changed: ${name}`);
  }
  assert.deepEqual(CHECKS, [
    "format:check",
    "lint",
    "typecheck",
    "policy:check",
    "test",
    "test:quality",
    "pack:check",
  ]);
  for (const file of inventory) {
    if (
      /^(?:\.ox(?:lint|fmt)rc\.|ox(?:lint|fmt)\.config\.|tsconfig.*\.|\.eslint|eslint\.config|\.prettier|prettier\.config)/.test(
        basename(file),
      )
    ) {
      assert.ok(
        [".oxlintrc.json", ".oxfmtrc.json", "tsconfig.json"].includes(file),
        `Unmapped quality configuration: ${file}`,
      );
    }
  }
}

function checkCompiler(root: string, sources: string[], standard: string): void {
  const tsc = join(root, "node_modules/typescript/bin/tsc");
  const config = record(command(root, process.execPath, [tsc, "--showConfig"]));
  assert.ok(isRecord(config.compilerOptions));
  const required = standardBlock(standard, "### 4.2 Compiler settings").compilerOptions;
  assert.ok(isRecord(required));
  for (const [name, value] of Object.entries({ ...required, allowJs: true, checkJs: true })) {
    assert.equal(config.compilerOptions[name], value, `Compiler requirement: ${name}`);
  }
  for (const name of [
    "noImplicitAny",
    "noImplicitThis",
    "strictNullChecks",
    "strictFunctionTypes",
    "strictBindCallApply",
    "strictBuiltinIteratorReturn",
    "strictPropertyInitialization",
    "alwaysStrict",
    "useUnknownInCatchVariables",
  ]) {
    assert.notEqual(
      config.compilerOptions[name],
      false,
      `Compiler strict-family relaxation: ${name}`,
    );
  }
  const files = new Set(
    command(root, process.execPath, [tsc, "--listFilesOnly"])
      .trim()
      .split(/\r?\n/)
      .map((path) => resolve(path)),
  );
  for (const source of sources) {
    assert.ok(files.has(resolve(root, source)), `Unowned compiler source: ${source}`);
    assert.ok(
      !/\.d\.[cm]?ts$/.test(source),
      `${source}: add an independently checked skipLibCheck:false declaration project before owning declarations`,
    );
  }
}

function checkCoverage(root: string, inventory: string[]): string[] {
  const sources = inventory.filter((file) => SOURCE.test(file));
  assert.ok(sources.length > 0, "Empty source inventory");
  const lint = join(root, "node_modules/oxlint/bin/oxlint");
  const selected = new Set(
    command(root, process.execPath, [lint, "--debug=files", "."])
      .trim()
      .split(/\r?\n/)
      .map((file) => resolve(root, file)),
  );
  for (const file of sources) {
    assert.ok(selected.has(resolve(root, file)), `Unowned lint source: ${file}`);
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) {
      assert.ok(
        /^test\/(?:quality\/)?[^/]+\.test\.ts$/.test(file),
        `Unmapped test command/profile: ${file}`,
      );
    } else if (file.startsWith("test/")) {
      assert.ok(
        file.startsWith("test/support/") || /\.test-d\.[cm]?ts$/.test(file),
        `Unmapped test support: ${file}`,
      );
    }
  }
  const ignored = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
    cwd: root,
    input: inventory.filter((file) => FORMAT.test(file)).join("\n") + "\n",
    encoding: "utf8",
  });
  if (ignored.error) {
    throw ignored.error;
  }
  assert.ok(ignored.status === 0 || ignored.status === 1, ignored.stderr);
  assert.equal(
    ignored.stdout.trim(),
    "",
    "Maintained files excluded from the formatter by Git ignores",
  );
  return sources;
}

export function checkPolicy(root: string): void {
  const inventory = [
    ...new Set(
      command(root, "git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split(
        "\0",
      ),
    ),
  ].filter((file) => file.length > 0 && existsSync(join(root, file)));
  const standard = readFileSync(join(root, "docs/engineering-standard.md"), "utf8");
  checkConfiguration(root, standard, inventory);
  const sources = checkCoverage(root, inventory);
  checkCompiler(root, sources, standard);
  for (const file of sources) {
    checkSource(file, readFileSync(join(root, file), "utf8"));
  }
  console.log(
    `Policy and coverage: ${sources.length} maintained JS/TS files, one checked compiler project.`,
  );
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  checkPolicy(ROOT);
}
