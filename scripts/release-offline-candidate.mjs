// Qualify the prepared npm bytes against the exact selected Pi hosts, without a live provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { proveDelivery } from "./delivery-candidate-proof.mjs";

const { values } = parseArgs({ options: {
  artifact: { type: "string" }, "fork-artifact": { type: "string" }, automation: { type: "string" },
  repository: { type: "string" }, "source-ref": { type: "string" }, "release-source": { type: "string" }, "official-version": { type: "string" },
  "fork-ref": { type: "string" }, output: { type: "string" },
} });
for (const key of ["artifact", "fork-artifact", "automation", "repository", "source-ref", "release-source", "official-version", "fork-ref", "output"]) {
  assert.ok(values[key], `Missing --${key}`);
}
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = resolve(values.artifact);
const output = resolve(values.output);
const { isolatedEnvironment, readJson, sha256 } = await import(pathToFileURL(join(resolve(values.automation), "scripts/common.mjs")));
const { prepareHost } = await import(pathToFileURL(join(resolve(values.automation), "scripts/hosts.mjs")));
const release = readJson(join(artifact, "release.json"));
assert.equal(release.repository, values.repository, "Candidate repository differs from the caller");
assert.equal(release.name, "pi-codex-goal");
assert.equal(release.source, values["source-ref"], "Candidate source differs from the plan");
assert.equal(release.releaseSource, values["release-source"], "Candidate queue source differs from the plan");
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" });
assert.equal(git.status, 0, git.stderr);
assert.equal(git.stdout.trim(), release.source, "Proof scripts must come from the candidate source");
assert.equal(release.hosts.official.version, values["official-version"]);
assert.equal(release.hosts.fork.provenance.ref, values["fork-ref"]);
const tarball = join(artifact, release.filename);
assert.equal(sha256(tarball), release.sha256, "Candidate tarball differs from its receipt");
mkdirSync(output, { recursive: false });
const env = isolatedEnvironment(join(output, "isolation"));
const hostRoot = join(output, "hosts");
const official = await prepareHost(join(hostRoot, "official"), "official", values["official-version"], env);
const fork = await prepareHost(join(hostRoot, "fork"), "fork", resolve(values["fork-artifact"]), env);
for (const [name, actual] of Object.entries({ official, fork })) {
  const expected = release.hosts[name];
  for (const key of ["runtimeLockSha256", "runtimeGraphSha256"]) {
    assert.match(expected[key], /^[0-9a-f]{64}$/, `${name} candidate receipt lacks ${key}`);
  }
  for (const key of ["version", "indexSha256", "cliSha256", "runtimeLockSha256", "runtimeGraphSha256"]) {
    assert.equal(actual[key], expected[key], `${name} host ${key} differs from candidate preparation`);
  }
  assert.deepEqual(actual.cohort, expected.cohort, `${name} host Pi cohort differs`);
  assert.deepEqual(actual.companions, expected.companions, `${name} host companions differ`);
}

proveDelivery({ source, tarball, version: release.version, hosts: { official, fork }, output, env });
const report = { source: release.source, releaseSource: release.releaseSource, candidateSha256: release.sha256, candidateVersion: release.version,
  hosts: { official, fork }, offline: "passed" };
writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
