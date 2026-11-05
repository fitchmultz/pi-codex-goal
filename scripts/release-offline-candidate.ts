// Qualify the prepared npm bytes against the exact selected Pi hosts, without a live provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "../src/validation.ts";
import { loadAutomation, requiredOption } from "./automation.ts";
import { proveDelivery } from "./delivery-candidate-proof.ts";

const { values: parsed } = parseArgs({
  options: {
    artifact: { type: "string" },
    "fork-artifact": { type: "string" },
    automation: { type: "string" },
    repository: { type: "string" },
    "source-ref": { type: "string" },
    "release-source": { type: "string" },
    "official-version": { type: "string" },
    "fork-ref": { type: "string" },
    output: { type: "string" },
  },
});
const values = {
  artifact: requiredOption(parsed["artifact"], "artifact"),
  "fork-artifact": requiredOption(parsed["fork-artifact"], "fork-artifact"),
  automation: requiredOption(parsed["automation"], "automation"),
  repository: requiredOption(parsed["repository"], "repository"),
  "source-ref": requiredOption(parsed["source-ref"], "source-ref"),
  "release-source": requiredOption(parsed["release-source"], "release-source"),
  "official-version": requiredOption(parsed["official-version"], "official-version"),
  "fork-ref": requiredOption(parsed["fork-ref"], "fork-ref"),
  output: requiredOption(parsed["output"], "output"),
};
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = resolve(values.artifact);
const output = resolve(values.output);
const { isolatedEnvironment, readJson, sha256, prepareHost } = await loadAutomation(
  values.automation,
);
const release = readJson(join(artifact, "release.json"));
assert.ok(isRecord(release) && isRecord(release.hosts));
assert.ok(typeof release.version === "string" && typeof release.filename === "string");
assert.equal(release.repository, values.repository, "Candidate repository differs from the caller");
assert.equal(release.name, "pi-codex-goal");
assert.equal(release.source, values["source-ref"], "Candidate source differs from the plan");
assert.equal(
  release.releaseSource,
  values["release-source"],
  "Candidate queue source differs from the plan",
);
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" });
assert.equal(git.status, 0, git.stderr);
assert.equal(
  git.stdout.trim(),
  release.source,
  "Proof scripts must come from the candidate source",
);
const officialReceipt = release.hosts.official;
const forkReceipt = release.hosts.fork;
assert.ok(isRecord(officialReceipt) && isRecord(forkReceipt) && isRecord(forkReceipt.provenance));
assert.equal(officialReceipt.version, values["official-version"]);
assert.equal(forkReceipt.provenance.ref, values["fork-ref"]);
const tarball = join(artifact, release.filename);
assert.equal(sha256(tarball), release.sha256, "Candidate tarball differs from its receipt");
mkdirSync(output, { recursive: false });
const env = isolatedEnvironment(join(output, "isolation"));
const hostRoot = join(output, "hosts");
const official = await prepareHost(
  join(hostRoot, "official"),
  "official",
  values["official-version"],
  env,
);
const fork = await prepareHost(
  join(hostRoot, "fork"),
  "fork",
  resolve(values["fork-artifact"]),
  env,
);
for (const [name, actual] of Object.entries({ official, fork })) {
  const expected: unknown = release.hosts[name];
  assert.ok(isRecord(expected));
  for (const key of ["runtimeLockSha256", "runtimeGraphSha256"]) {
    const hash = expected[key];
    assert.ok(typeof hash === "string", `${name} candidate receipt lacks ${key}`);
    assert.match(hash, /^[0-9a-f]{64}$/, `${name} candidate receipt lacks ${key}`);
  }
  for (const key of [
    "version",
    "indexSha256",
    "cliSha256",
    "runtimeLockSha256",
    "runtimeGraphSha256",
  ]) {
    assert.equal(
      actual[key],
      expected[key],
      `${name} host ${key} differs from candidate preparation`,
    );
  }
  assert.deepEqual(actual.cohort, expected.cohort, `${name} host Pi cohort differs`);
  assert.deepEqual(actual.companions, expected.companions, `${name} host companions differ`);
}

proveDelivery({
  source,
  tarball,
  version: release.version,
  hosts: { official, fork },
  output,
  env,
});
const report = {
  source: release.source,
  releaseSource: release.releaseSource,
  candidateSha256: release.sha256,
  candidateVersion: release.version,
  hosts: { official, fork },
  offline: "passed",
};
writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
