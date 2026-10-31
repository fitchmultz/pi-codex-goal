// Pack the pull-request source and run delivery proofs without publishing or a live provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { proveDelivery } from "./delivery-candidate-proof.mjs";

const { values } = parseArgs({ options: {
  automation: { type: "string" }, "fork-artifact": { type: "string" }, "source-ref": { type: "string" },
  "official-version": { type: "string" }, "fork-ref": { type: "string" }, output: { type: "string" },
} });
for (const key of ["automation", "fork-artifact", "source-ref", "official-version", "fork-ref", "output"]) {
  assert.ok(values[key], `Missing --${key}`);
}
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(values.output);
const { isolatedEnvironment, readJson, sha256 } = await import(pathToFileURL(join(resolve(values.automation), "scripts/common.mjs")));
const { prepareHost } = await import(pathToFileURL(join(resolve(values.automation), "scripts/hosts.mjs")));
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" });
assert.equal(git.status, 0, git.stderr);
assert.equal(git.stdout.trim(), values["source-ref"], "Pull-request proof must use the checked-out source");
mkdirSync(output, { recursive: false });
const env = isolatedEnvironment(join(output, "isolation"));
const official = await prepareHost(join(output, "hosts/official"), "official", values["official-version"], env);
const fork = await prepareHost(join(output, "hosts/fork"), "fork", resolve(values["fork-artifact"]), env);
assert.equal(fork.provenance.ref, values["fork-ref"]);
const manifest = readJson(join(source, "package.json"));
assert.equal(manifest.name, "pi-codex-goal");
const destination = join(output, "tarball");
mkdirSync(destination);
const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
  { cwd: source, env, encoding: "utf8" });
writeFileSync(join(output, "pack.log"), `${packed.stdout ?? ""}\n${packed.stderr ?? ""}`);
if (packed.error) throw packed.error;
assert.equal(packed.status, 0, "Could not pack pull-request source");
const data = JSON.parse(packed.stdout);
const entries = Array.isArray(data) ? data : Object.values(data);
assert.equal(entries.length, 1);
assert.equal(entries[0].name, manifest.name);
assert.equal(entries[0].version, manifest.version);
const tarball = join(destination, entries[0].filename);
const hash = sha256(tarball);
proveDelivery({ source, tarball, version: manifest.version, hosts: { official, fork }, output, env });
assert.equal(sha256(tarball), hash, "Pull-request tarball changed during qualification");
const report = { source: values["source-ref"], candidateSha256: hash, candidateVersion: manifest.version,
  hosts: { official, fork }, offline: "passed" };
writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
