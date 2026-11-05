import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isRecord } from "../src/validation.ts";
import { requiredOption } from "./automation.ts";

function readMetadata(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(isRecord(value), `${file}: expected evidence object`);
  return value;
}

const { values } = parseArgs({ options: { root: { type: "string" } } });
const root = requiredOption(values.root, "root");
const release = readMetadata(join(root, "npm-candidate/release.json"));
const offline = readMetadata(join(root, "goal-evidence/report.json"));
const scope = readMetadata(join(root, "goal-evidence/scope.json"));
assert.ok(typeof release.filename === "string");
const hash = createHash("sha256")
  .update(readFileSync(join(root, "npm-candidate", release.filename)))
  .digest("hex");
assert.equal(hash, release.sha256);
assert.equal(offline.candidateSha256, hash);
assert.equal(scope.source, release.source);
assert.ok(typeof scope.required === "boolean");
if (scope.required) {
  assert.ok(isRecord(offline.hosts));
  for (const host of ["official", "fork"]) {
    const dir = join(root, "goal-evidence", host, "live");
    const live = readMetadata(join(dir, "verification.json"));
    const invocation = readMetadata(join(dir, "invocation.json"));
    const identity: unknown = offline.hosts[host];
    assert.ok(isRecord(identity));
    assert.equal(live.candidateSha256, hash);
    assert.equal(invocation.hostCliSha256, identity.cliSha256);
  }
}
