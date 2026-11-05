// Decide whether the documented live /goal proof applies to this release candidate.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "../src/validation.ts";
import { requiredOption } from "./automation.ts";

const { values: parsed } = parseArgs({
  options: {
    repository: { type: "string" },
    "source-ref": { type: "string" },
    version: { type: "string" },
    output: { type: "string" },
  },
});
const values = {
  repository: requiredOption(parsed["repository"], "repository"),
  "source-ref": requiredOption(parsed["source-ref"], "source-ref"),
  version: requiredOption(parsed["version"], "version"),
  output: requiredOption(parsed["output"], "output"),
};
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command: string, args: string[]) =>
  spawnSync(command, args, { cwd: source, encoding: "utf8" });
const head = run("git", ["rev-parse", "HEAD"]);
assert.equal(head.status, 0, head.stderr);
assert.equal(head.stdout.trim(), values["source-ref"], "Scope check must use the candidate source");
const RUNTIME_FIELDS = [
  "type",
  "main",
  "module",
  "exports",
  "imports",
  "bin",
  "engines",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundledDependencies",
];

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return items.map(normalize);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key): [string, unknown] => [key, normalize(value[key])]),
    );
  }
  return value;
}

function resources(manifest: Record<string, unknown>): Record<string, unknown> {
  const pi = isRecord(manifest.pi) ? manifest.pi : {};
  return Object.fromEntries(
    ["extensions", "skills", "prompts", "themes"]
      .filter((key) => pi[key] !== undefined)
      .map((key): [string, unknown] => [key, pi[key]]),
  );
}

function runtimeMetadataChanged(baseline: string, candidate: string): boolean {
  const previous = run("git", ["show", `${baseline}:package.json`]);
  const current = run("git", ["show", `${candidate}:package.json`]);
  assert.equal(previous.status, 0, `Could not read published package metadata: ${previous.stderr}`);
  assert.equal(current.status, 0, `Could not read candidate package metadata: ${current.stderr}`);
  const left: unknown = JSON.parse(previous.stdout);
  const right: unknown = JSON.parse(current.stdout);
  assert.ok(isRecord(left) && isRecord(right));
  return (
    RUNTIME_FIELDS.some(
      (key) => JSON.stringify(normalize(left[key])) !== JSON.stringify(normalize(right[key])),
    ) || JSON.stringify(normalize(resources(left))) !== JSON.stringify(normalize(resources(right)))
  );
}

interface ScopeReport {
  source: string;
  required: boolean;
  changedPaths: string[];
  relevantPaths: string[];
  baselineTag?: string;
  baseline?: string;
  reason?: string;
}

const report: ScopeReport = {
  source: values["source-ref"],
  required: true,
  changedPaths: [],
  relevantPaths: [],
};

function inspect() {
  const releases = run("gh", [
    "api",
    "--paginate",
    `repos/${values.repository}/releases?per_page=100`,
    "--jq",
    ".[] | select(.draft == false and .prerelease == false) | .tag_name",
  ]);
  assert.equal(
    releases.status,
    0,
    `Could not resolve the prior published release: ${releases.stderr}`,
  );
  const tag = releases.stdout
    .split("\n")
    .find(
      (value) => value.length > 0 && value !== `v${values.version}` && value !== values.version,
    );
  if (tag === undefined) {
    return "No prior published release exists";
  }
  report.baselineTag = tag;
  const base = run("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
  assert.equal(
    base.status,
    0,
    `The prior published tag is unavailable in this checkout: ${base.stderr}`,
  );
  report.baseline = base.stdout.trim();
  const ancestor = run("git", ["merge-base", "--is-ancestor", report.baseline, report.source]);
  assert.equal(
    ancestor.status,
    0,
    "The prior published source is not an ancestor of the candidate",
  );
  const diff = run("git", ["diff", "--name-only", "-z", report.baseline, report.source]);
  assert.equal(
    diff.status,
    0,
    `Could not compare the candidate with its published baseline: ${diff.stderr}`,
  );
  report.changedPaths = diff.stdout.split("\0").filter(Boolean);
  const prefixes = ["src/", "extensions/", "prompts/"];
  report.relevantPaths = report.changedPaths.filter((path) =>
    prefixes.some((prefix) => path.startsWith(prefix)),
  );
  if (
    report.changedPaths.includes("package.json") &&
    runtimeMetadataChanged(report.baseline, report.source)
  ) {
    report.relevantPaths.push("package.json (runtime metadata)");
  }
  report.required = report.relevantPaths.length > 0;
  return report.required
    ? "Release-sensitive inputs changed"
    : "No release-sensitive inputs changed";
}
report.reason = inspect();
writeFileSync(resolve(values.output), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
