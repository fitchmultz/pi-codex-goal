// Pack the pull-request source and run delivery proofs without publishing or a live provider.
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
    automation: { type: "string" },
    "fork-artifact": { type: "string" },
    "source-ref": { type: "string" },
    "official-version": { type: "string" },
    "fork-ref": { type: "string" },
    output: { type: "string" },
  },
});
const values = {
  automation: requiredOption(parsed["automation"], "automation"),
  "fork-artifact": requiredOption(parsed["fork-artifact"], "fork-artifact"),
  "source-ref": requiredOption(parsed["source-ref"], "source-ref"),
  "official-version": requiredOption(parsed["official-version"], "official-version"),
  "fork-ref": requiredOption(parsed["fork-ref"], "fork-ref"),
  output: requiredOption(parsed["output"], "output"),
};
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(values.output);
const { isolatedEnvironment, readJson, sha256, prepareHost } = await loadAutomation(
  values.automation,
);
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" });
assert.equal(git.status, 0, git.stderr);
assert.equal(
  git.stdout.trim(),
  values["source-ref"],
  "Pull-request proof must use the checked-out source",
);
mkdirSync(output, { recursive: false });
const env = isolatedEnvironment(join(output, "isolation"));
const official = await prepareHost(
  join(output, "hosts/official"),
  "official",
  values["official-version"],
  env,
);
const fork = await prepareHost(
  join(output, "hosts/fork"),
  "fork",
  resolve(values["fork-artifact"]),
  env,
);
assert.equal(fork.provenance.ref, values["fork-ref"]);
const manifest = readJson(join(source, "package.json"));
assert.ok(isRecord(manifest) && typeof manifest.version === "string");
assert.equal(manifest.name, "pi-codex-goal");
const destination = join(output, "tarball");
mkdirSync(destination);
const packed = spawnSync(
  "npm",
  ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
  { cwd: source, env, encoding: "utf8" },
);
writeFileSync(join(output, "pack.log"), `${packed.stdout}\n${packed.stderr}`);
if (packed.error) {
  throw packed.error;
}
assert.equal(packed.status, 0, "Could not pack pull-request source");
const data: unknown = JSON.parse(packed.stdout);
assert.ok(isRecord(data));
const entries = Object.values(data);
assert.equal(entries.length, 1);
const [entry] = entries;
assert.ok(isRecord(entry) && typeof entry.filename === "string");
assert.equal(entry.name, manifest.name);
assert.equal(entry.version, manifest.version);
const tarball = join(destination, entry.filename);
const hash = sha256(tarball);
proveDelivery({
  source,
  tarball,
  version: manifest.version,
  hosts: { official, fork },
  output,
  env,
});
assert.equal(sha256(tarball), hash, "Pull-request tarball changed during qualification");
const report = {
  source: values["source-ref"],
  candidateSha256: hash,
  candidateVersion: manifest.version,
  hosts: { official, fork },
  offline: "passed",
};
writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
