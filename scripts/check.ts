import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CHECKS: readonly string[] = [
  "format:check",
  "lint",
  "typecheck",
  "policy:check",
  "test",
  "test:quality",
  "pack:check",
];

function runCheck(name: string, npm: string): Promise<number> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [npm, "run", name], { stdio: "inherit" });
    child.once("error", (error) => {
      console.error(`${name}: ${error.message}`);
      done(1);
    });
    child.once("exit", (code) => {
      done(code ?? 1);
    });
  });
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  const npm = process.env.npm_execpath;
  if (npm === undefined) {
    throw new Error("Run through npm run check so every gate uses the selected npm version.");
  }
  const codes = await Promise.all(CHECKS.map((name) => runCheck(name, npm)));
  process.exitCode = codes.every((code) => code === 0) ? 0 : 1;
}
