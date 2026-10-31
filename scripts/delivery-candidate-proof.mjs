// Run the existing delivery-contract proofs against an extracted npm candidate and selected hosts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function proveDelivery({ source, tarball, version, hosts, output, env }) {
  function run(name, command, args, options = {}) {
    const log = join(output, `${name}.log`);
    const fd = openSync(log, "w");
    let result;
    try {
      result = spawnSync(command, args, { cwd: source, env, stdio: ["ignore", fd, fd], ...options });
    } finally {
      closeSync(fd);
    }
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${name} failed (${result.signal ?? result.status}); inspect ${log}`);
  }

  const extracted = join(output, "candidate");
  mkdirSync(extracted);
  run("extract", "tar", ["-xzf", tarball, "-C", extracted]);
  const packed = join(extracted, "package");
  const manifest = JSON.parse(readFileSync(join(packed, "package.json"), "utf8"));
  assert.equal(manifest.name, "pi-codex-goal");
  assert.equal(manifest.version, version);
  mkdirSync(join(packed, "scripts"), { recursive: true });
  for (const file of ["host-sdk.ts", "delivery-identity-proof.ts", "delivery-role-proof.ts"]) {
    copyFileSync(join(source, "scripts", file), join(packed, "scripts", file));
  }
  for (const [name, host] of Object.entries(hosts)) {
    const evidence = join(output, name);
    mkdirSync(evidence);
    const hostEnv = { ...env, PI_SDK_PACKAGE: join(host.packageDir, "package.json") };
    const loader = join(packed, "scripts/host-sdk.ts");
    for (const proof of ["identity", "role"]) {
      run(`${name}-${proof}`, process.execPath,
        ["--import", loader, join(packed, `scripts/delivery-${proof}-proof.ts`), join(evidence, proof)], { env: hostEnv });
    }
    for (const [proof, options] of [["deliver", []], ["restore", ["--restore"]], ["fullscreen", ["--restore", "--tui-mode", "fullscreen"]]]) {
      run(`${name}-${proof}`, "python3", [join(source, "scripts/delivery-ownership-pty.py"),
        "--node", process.execPath, "--host", host.packageDir, "--source", packed,
        "--output", join(evidence, proof), ...options]);
    }
  }
}
