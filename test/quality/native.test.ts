import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import { isRecord } from "../../src/validation.ts";
import { checkSource } from "../../scripts/quality-source.ts";

const root = resolve(import.meta.dirname, "../..");

function project(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "goal-quality-"));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "junction");
  copyFileSync(join(root, ".oxlintrc.json"), join(directory, ".oxlintrc.json"));
  copyFileSync(join(root, ".gitignore"), join(directory, ".gitignore"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({ extends: join(root, "tsconfig.json"), include: ["**/*.ts"] }),
  );
  return directory;
}

function assertSelection(directory: string, files: string[]): void {
  const result = spawnSync(
    process.execPath,
    [join(root, "node_modules/oxlint/bin/oxlint"), "--debug=files", "."],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.stdout
      .trim()
      .split(/\r?\n/)
      .map((file) => file.replaceAll("\\", "/"))
      .sort(),
    files.toSorted(),
  );
}

nodeTest(
  "native Node registration allowance retains all six declaration and ownership boundaries",
  (t) => {
    const directory = project(t);
    const sources = {
      "test/valid.test.ts":
        'import { test as nodeTest, describe } from "node:test";\nnodeTest("top", async () => { await Promise.resolve(); });\nawait describe("suite", () => { nodeTest("nested registration", async () => { await Promise.resolve(); }); });\n',
      "test/context.test.ts":
        'import { test as nodeTest } from "node:test";\nnodeTest("parent", (t) => { t.test("child", async () => { await Promise.resolve(); }); });\n',
      "test/local.test.ts":
        "function nodeTest(): Promise<void> { return Promise.resolve(); }\nnodeTest();\n",
      "test/wrong-origin.test.ts": 'import { nodeTest } from "./other.ts";\nnodeTest();\n',
      "test/other.ts": "export function nodeTest(): Promise<void> { return Promise.resolve(); }\n",
      "test/body.test.ts":
        'import { test as nodeTest } from "node:test"; function work(): Promise<void> { return Promise.resolve(); }\nnodeTest("body", () => { work(); });\n',
      "test/unrelated.test.ts":
        "export function work(): Promise<void> { return Promise.resolve(); }\nwork();\n",
    };
    for (const [file, source] of Object.entries(sources)) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      writeFileSync(join(directory, file), source);
    }
    assertSelection(directory, Object.keys(sources));
    const compiler = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc")], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(compiler.status, 0, compiler.stdout + compiler.stderr);
    const result = spawnSync(
      process.execPath,
      [join(root, "node_modules/oxlint/bin/oxlint"), "--deny-warnings", "--format=json", "."],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report: unknown = JSON.parse(result.stdout);
    assert.ok(isRecord(report) && Array.isArray(report.diagnostics));
    const failures = new Set<string>();
    for (const diagnostic of report.diagnostics) {
      assert.ok(isRecord(diagnostic) && typeof diagnostic.filename === "string");
      assert.equal(diagnostic.code, "typescript(no-floating-promises)");
      assert.ok(Array.isArray(diagnostic.labels));
      const label: unknown = diagnostic.labels[0];
      assert.ok(isRecord(label) && isRecord(label.span));
      assert.equal(label.span.line, 2, diagnostic.filename);
      failures.add(diagnostic.filename.replaceAll("\\", "/"));
    }
    assert.equal(report.diagnostics.length, 5);
    assert.deepEqual([...failures].sort(), [
      "test/body.test.ts",
      "test/context.test.ts",
      "test/local.test.ts",
      "test/unrelated.test.ts",
      "test/wrong-origin.test.ts",
    ]);
  },
);

for (const scenario of [
  {
    rule: "no-param-reassign",
    id: "QX-002",
    source:
      "export function other(value: { count: number }): void {\nDIRECTIVE\n  value.count = 1;\n}\n",
  },
  {
    rule: "max-params",
    id: "QX-003",
    source:
      "\nDIRECTIVE\nexport function other(a: number, b: number, c: number, d: number, e: number): number { return a + b + c + d + e; }\n",
  },
]) {
  nodeTest(`a used ${scenario.rule} directive at an unauthorized operation fails policy`, (t) => {
    const directory = project(t);
    const directive = `// oxlint-disable-next-line ${scenario.rule} -- ${scenario.id}: copied authorization`;
    const source = scenario.source.replace("DIRECTIVE", directive);
    const file = join(directory, "other.ts");
    writeFileSync(file, source);
    assertSelection(directory, ["other.ts"]);
    const args = [
      join(root, "node_modules/oxlint/bin/oxlint"),
      "--deny-warnings",
      "--format=json",
      ".",
    ];
    const acceptedByLint = spawnSync(process.execPath, args, { cwd: directory, encoding: "utf8" });
    assert.equal(acceptedByLint.status, 0, acceptedByLint.stdout + acceptedByLint.stderr);
    assert.throws(() => checkSource("src/other.ts", source), /unauthorized directive/);
    writeFileSync(file, source.replace(directive, ""));
    const rejectedByLint = spawnSync(process.execPath, args, { cwd: directory, encoding: "utf8" });
    assert.equal(rejectedByLint.status, 1, rejectedByLint.stdout + rejectedByLint.stderr);
    const report: unknown = JSON.parse(rejectedByLint.stdout);
    assert.ok(isRecord(report) && Array.isArray(report.diagnostics));
    assert.equal(report.diagnostics.length, 1);
    const diagnostic: unknown = report.diagnostics[0];
    assert.ok(isRecord(diagnostic) && Array.isArray(diagnostic.labels));
    assert.equal(diagnostic.code, `eslint(${scenario.rule})`);
    assert.equal(diagnostic.filename, "other.ts");
    const label: unknown = diagnostic.labels[0];
    assert.ok(isRecord(label) && isRecord(label.span));
    assert.equal(label.span.line, 3);
  });
}
