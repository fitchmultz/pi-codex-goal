import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test as nodeTest } from "node:test";
import { isRecord } from "../../src/validation.ts";

const root = resolve(import.meta.dirname, "../..");

nodeTest(
  "the actual policy gate rejects category downgrades and omitted maintained compiler inputs",
  (t) => {
    const scratch = mkdtempSync(join(tmpdir(), "goal-policy-"));
    const directory = join(scratch, "linked");
    const source = join(scratch, "source");
    mkdirSync(source);
    symlinkSync(source, directory, "junction");
    t.after(() => {
      rmSync(scratch, { recursive: true, force: true });
    });
    const inventory = spawnSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(inventory.status, 0, inventory.stderr);
    for (const file of new Set(inventory.stdout.split("\0"))) {
      if (file.length > 0 && existsSync(join(root, file))) {
        mkdirSync(dirname(join(directory, file)), { recursive: true });
        copyFileSync(join(root, file), join(directory, file));
      }
    }
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "junction");
    const initialized = spawnSync("git", ["init", "--quiet"], { cwd: directory, encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    const run = () =>
      spawnSync(process.execPath, [join(directory, "scripts/quality-policy.ts")], {
        cwd: directory,
        env: { ...process.env, PWD: directory },
        encoding: "utf8",
      });
    const valid = run();
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);

    const lintPath = join(directory, ".oxlintrc.json");
    const originalLint = readFileSync(lintPath, "utf8");
    const lint: unknown = JSON.parse(originalLint);
    assert.ok(isRecord(lint) && isRecord(lint.rules));
    lint.rules["use-isnan"] = "off";
    writeFileSync(lintPath, JSON.stringify(lint));
    const weakened = run();
    assert.equal(weakened.status, 1, weakened.stdout + weakened.stderr);
    assert.match(weakened.stderr, /Oxlint policy differs from Appendix A/);
    writeFileSync(lintPath, originalLint);

    writeFileSync(join(directory, "coverage-probe.ts"), "export const covered = true;\n");
    const discovered = run();
    assert.equal(discovered.status, 0, discovered.stdout + discovered.stderr);
    const compilerPath = join(directory, "tsconfig.json");
    const compiler: unknown = JSON.parse(readFileSync(compilerPath, "utf8"));
    assert.ok(isRecord(compiler));
    compiler.exclude = ["coverage-probe.ts"];
    writeFileSync(compilerPath, JSON.stringify(compiler));
    const omitted = run();
    assert.equal(omitted.status, 1, omitted.stdout + omitted.stderr);
    assert.match(omitted.stderr, /Unowned compiler source: coverage-probe.ts/);
    delete compiler.exclude;
    assert.ok(isRecord(compiler.compilerOptions));
    compiler.compilerOptions.strictBuiltinIteratorReturn = false;
    writeFileSync(compilerPath, JSON.stringify(compiler));
    const relaxed = run();
    assert.equal(relaxed.status, 1, relaxed.stdout + relaxed.stderr);
    assert.match(relaxed.stderr, /Compiler strict-family relaxation: strictBuiltinIteratorReturn/);
  },
);
