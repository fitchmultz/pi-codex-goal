// Decide whether the documented live /goal proof applies to this release candidate.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  repository: { type: "string" }, "source-ref": { type: "string" }, version: { type: "string" }, output: { type: "string" },
} });
for (const key of ["repository", "source-ref", "version", "output"]) assert.ok(values[key], `Missing --${key}`);
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args) => spawnSync(command, args, { cwd: source, encoding: "utf8" });
const head = run("git", ["rev-parse", "HEAD"]);
assert.equal(head.status, 0, head.stderr);
assert.equal(head.stdout.trim(), values["source-ref"], "Scope check must use the candidate source");
const report = { source: values["source-ref"], required: true, changedPaths: [], relevantPaths: [] };

function inspect() {
  const releases = run("gh", ["api", "--paginate", `repos/${values.repository}/releases?per_page=100`, "--jq",
    ".[] | select(.draft == false and .prerelease == false) | .tag_name"]);
  if (releases.status !== 0) return "Could not resolve the prior published release";
  const tag = releases.stdout.split("\n").find((value) => value && value !== `v${values.version}` && value !== values.version);
  if (!tag) return "No prior published release exists";
  report.baselineTag = tag;
  const base = run("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
  if (base.status !== 0) return "The prior published tag is unavailable in this checkout";
  report.baseline = base.stdout.trim();
  const ancestor = run("git", ["merge-base", "--is-ancestor", report.baseline, report.source]);
  if (ancestor.status !== 0) return "The prior published source is not an ancestor of the candidate";
  const diff = run("git", ["diff", "--name-only", "-z", report.baseline, report.source]);
  if (diff.status !== 0) return "Could not compare the candidate with its published baseline";
  report.changedPaths = diff.stdout.split("\0").filter(Boolean);
  const prefixes = ["src/", "extensions/", "prompts/"];
  const proof = new Set(["scripts/release-interactive-pty.py", ".github/workflows/release-qualification.yml"]);
  report.relevantPaths = report.changedPaths.filter((path) => prefixes.some((prefix) => path.startsWith(prefix)) || proof.has(path));
  if (report.changedPaths.includes("package.json")) {
    const previous = run("git", ["show", `${report.baseline}:package.json`]);
    const current = run("git", ["show", `${report.source}:package.json`]);
    if (previous.status !== 0 || current.status !== 0) return "Could not compare package runtime metadata";
    let left, right;
    try {
      left = JSON.parse(previous.stdout);
      right = JSON.parse(current.stdout);
    } catch {
      return "Could not parse package runtime metadata";
    }
    const runtime = ["type", "main", "module", "exports", "imports", "bin", "files", "engines",
      "dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bundledDependencies"];
    const normalize = (value) => {
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
      return value;
    };
    const resources = (manifest) => Object.fromEntries(["extensions", "skills", "prompts", "themes"]
      .filter((key) => manifest.pi?.[key] !== undefined).map((key) => [key, manifest.pi[key]]));
    if (runtime.some((key) => JSON.stringify(normalize(left[key])) !== JSON.stringify(normalize(right[key])))
        || JSON.stringify(normalize(resources(left))) !== JSON.stringify(normalize(resources(right)))) {
      report.relevantPaths.push("package.json (runtime metadata)");
    }
  }
  report.required = report.relevantPaths.length > 0;
  return report.required ? "Release-sensitive inputs changed" : "No release-sensitive inputs changed";
}
report.reason = inspect();
writeFileSync(resolve(values.output), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
