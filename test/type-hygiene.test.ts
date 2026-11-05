import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test as nodeTest } from "node:test";
import { checkSource } from "../scripts/quality-source.ts";

nodeTest(
  "directive authorization follows the actual SDK operation, not its count or identifier",
  () => {
    const file = "src/goal-compaction.ts";
    const source = readFileSync(file, "utf8");
    checkSource(file, source);
    assert.throws(() => checkSource("src/copied-filter.ts", source), /unauthorized directive/);
    assert.throws(
      () => checkSource(file, source.replace("QX-002:", "QX-999:")),
      /unauthorized exception/,
    );
    assert.throws(
      () => checkSource(file, source.replace("no-param-reassign --", "max-params --")),
      /unauthorized rule/,
    );
    const directive = source.split("\n").find((line) => line.includes("oxlint-disable-next-line"));
    assert.ok(directive !== undefined && directive.length > 0);
    const relocated =
      source.replace(directive + "\n", "") +
      `
export function other(preparation: { messagesToSummarize: unknown[] }): void {
${directive}
  preparation.messagesToSummarize = [];
}
`;
    assert.throws(() => checkSource(file, relocated), /unauthorized directive/);
    assert.throws(
      () => checkSource(file, source.replace(directive, directive + "\n" + directive)),
      /unauthorized directive/,
    );
    assert.throws(
      () => checkSource(file, source.replace(directive + "\n", "")),
      /stale exception inventory/,
    );
  },
);

nodeTest("SDK callback exceptions stay on the two registered tools", () => {
  const file = "src/tools.ts";
  const source = readFileSync(file, "utf8");
  checkSource(file, source);
  assert.throws(() => checkSource("src/other-tools.ts", source), /unauthorized directive/);
  assert.throws(
    () => checkSource(file, source.replace('name: "create_goal"', 'name: "other_tool"')),
    /deep-equal/,
  );
});

nodeTest(
  "comment policy distinguishes literals and rejects undocumented disables and compiler escapes",
  () => {
    checkSource(
      "example.ts",
      'export const example = "// oxlint-disable-next-line no-param-reassign -- QX-002: example";',
    );
    for (const comment of [
      "eslint-disable",
      "oxlint-disable",
      "oxlint-disable-line no-param-reassign",
      "@ts-ignore",
      "@ts-nocheck",
      "@ts-expect-error unsupported implementation escape",
    ]) {
      assert.throws(
        () => checkSource("example.ts", `// ${comment}\nexport const value = 1;`),
        /unauthorized directive/,
      );
    }
    checkSource(
      "contract.test-d.ts",
      "// @ts-expect-error numbers cannot satisfy strings\nconst value: string = 1;",
    );
    assert.throws(
      () =>
        checkSource("contract.test-d.ts", "// @ts-expect-error short\nconst value: string = 1;"),
      /unauthorized directive/,
    );
  },
);

nodeTest(
  "production cannot depend on test-only code through imports, exports or literal dynamic loads",
  () => {
    for (const source of [
      'import "../test/support/scenarios.ts";',
      'export * from "../test/support/scenarios.ts";',
      'export { createRuntimeHarness } from "../test/support/runtime-harness.ts";',
      'import("../test/support/scenarios.ts");',
      'require("../test/support/scenarios.ts");',
    ]) {
      assert.throws(() => checkSource("src/consumer.ts", source), /production imports test-only/);
      checkSource("test/consumer.test.ts", source);
    }
    checkSource("src/consumer.ts", 'import "./types.ts";');
  },
);
