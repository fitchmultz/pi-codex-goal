import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "../src/validation.ts";

export interface HostIdentity extends Record<string, unknown> {
  packageDir: string;
  version: string;
  indexSha256: string;
  cliSha256: string;
  cohort: Record<string, string>;
  companions: Record<string, string>;
  provenance: Record<string, unknown>;
}

interface CommonModule {
  isolatedEnvironment: (root: string) => unknown;
  readJson: (file: string) => unknown;
  sha256: (file: string) => unknown;
}
interface HostsModule {
  prepareHost: (
    directory: string,
    flavor: "official" | "fork",
    target: string,
    env: NodeJS.ProcessEnv,
  ) => unknown;
}
interface Automation {
  isolatedEnvironment: (root: string) => NodeJS.ProcessEnv;
  readJson: CommonModule["readJson"];
  sha256: (file: string) => string;
  prepareHost: (
    directory: string,
    flavor: "official" | "fork",
    target: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<HostIdentity>;
}

function isCommonModule(value: unknown): value is CommonModule {
  return (
    isRecord(value) &&
    typeof value.isolatedEnvironment === "function" &&
    typeof value.readJson === "function" &&
    typeof value.sha256 === "function"
  );
}

function isHostsModule(value: unknown): value is HostsModule {
  return isRecord(value) && typeof value.prepareHost === "function";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isHostIdentity(value: unknown): value is HostIdentity {
  return (
    isRecord(value) &&
    typeof value.packageDir === "string" &&
    typeof value.version === "string" &&
    typeof value.indexSha256 === "string" &&
    typeof value.cliSha256 === "string" &&
    isStringRecord(value.cohort) &&
    isStringRecord(value.companions) &&
    isRecord(value.provenance)
  );
}

/** Adapt the selected shared automation's JavaScript API without trusting its return values. */
export async function loadAutomation(directory: string): Promise<Automation> {
  const common: unknown = await import(
    pathToFileURL(join(resolve(directory), "scripts/common.mjs")).href
  );
  const hosts: unknown = await import(
    pathToFileURL(join(resolve(directory), "scripts/hosts.mjs")).href
  );
  assert.ok(isCommonModule(common), "Shared automation must export common functions");
  assert.ok(isHostsModule(hosts), "Shared automation must export prepareHost");
  return {
    readJson: common.readJson,
    isolatedEnvironment(root) {
      const env = common.isolatedEnvironment(root);
      assert.ok(isStringRecord(env), "Shared automation must return a string environment");
      return env;
    },
    sha256(file) {
      const hash = common.sha256(file);
      assert.ok(typeof hash === "string", "Shared automation must return a SHA-256 string");
      return hash;
    },
    async prepareHost(destination, flavor, target, env) {
      const host: unknown = await hosts.prepareHost(destination, flavor, target, env);
      assert.ok(isHostIdentity(host), "Shared automation must return host identity evidence");
      return host;
    },
  };
}

export function requiredOption(value: string | undefined, name: string): string {
  assert.ok(value !== undefined && value.length > 0, `Missing --${name}`);
  return value;
}
