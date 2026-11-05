import assert from "node:assert/strict";
import { dirname, posix } from "node:path";
import {
  parseSync,
  Visitor,
  type Function as AstFunction,
  type CallExpression,
  type ObjectExpression,
  type ObjectPropertyKind,
  type Program,
  type ObjectProperty,
} from "oxc-parser";

interface Site {
  start: number;
  id: string;
  rule: string;
  operation: string;
}

function exportedFunction(program: Program, name: string): AstFunction | undefined {
  for (const statement of program.body) {
    if (
      statement.type === "ExportNamedDeclaration" &&
      statement.declaration?.type === "FunctionDeclaration" &&
      statement.declaration.id?.name === name
    ) {
      return statement.declaration;
    }
  }
  return undefined;
}

function compactionSites(program: Program): Site[] {
  const fn = exportedFunction(program, "filterGoalCompactionInput");
  assert.ok(fn?.body, "QX-002: missing compaction filter");
  const sites: Site[] = [];
  for (const statement of fn.body.body) {
    if (
      statement.type !== "ExpressionStatement" ||
      statement.expression.type !== "AssignmentExpression"
    ) {
      continue;
    }
    const { left } = statement.expression;
    if (
      left.type === "MemberExpression" &&
      !left.computed &&
      left.object.type === "Identifier" &&
      left.object.name === "preparation" &&
      left.property.type === "Identifier"
    ) {
      sites.push({
        start: statement.start,
        id: "QX-002",
        rule: "no-param-reassign",
        operation: left.property.name,
      });
    }
  }
  assert.deepEqual(sites.map((site) => site.operation).sort(), [
    "messagesToSummarize",
    "turnPrefixMessages",
  ]);
  return sites;
}

function namedProperty(properties: ObjectPropertyKind[], name: string): ObjectProperty | undefined {
  return properties.find(
    (property): property is ObjectProperty =>
      property.type === "Property" &&
      property.key.type === "Identifier" &&
      property.key.name === name,
  );
}

function registeredTool(call: CallExpression): ObjectExpression | undefined {
  const { callee, arguments: args } = call;
  if (
    callee.type !== "MemberExpression" ||
    callee.object.type !== "Identifier" ||
    callee.object.name !== "pi" ||
    callee.property.type !== "Identifier" ||
    callee.property.name !== "registerTool"
  ) {
    return undefined;
  }
  const [definition] = args;
  assert.ok(definition?.type === "ObjectExpression");
  return definition;
}

function toolSites(program: Program): Site[] {
  const fn = exportedFunction(program, "registerGoalTools");
  assert.ok(fn?.body, "QX-003: missing tool registration");
  const sites: Site[] = [];
  for (const statement of fn.body.body) {
    if (
      statement.type !== "ExpressionStatement" ||
      statement.expression.type !== "CallExpression"
    ) {
      continue;
    }
    const definition = registeredTool(statement.expression);
    if (!definition) {
      continue;
    }
    const name = namedProperty(definition.properties, "name");
    assert.ok(name?.value.type === "Literal" && typeof name.value.value === "string");
    if (name.value.value === "get_goal") {
      continue;
    }
    const execute = namedProperty(definition.properties, "execute");
    assert.ok(execute?.value.type === "FunctionExpression");
    assert.equal(execute.value.params.length, 5);
    sites.push({
      start: execute.start,
      id: "QX-003",
      rule: "max-params",
      operation: name.value.value,
    });
  }
  assert.deepEqual(sites.map((site) => site.operation).sort(), ["create_goal", "update_goal"]);
  return sites;
}

/** Check actual comments and their AST operations, never string or documentation examples. */
export function checkSource(file: string, source: string): void {
  const parsed = parseSync(file, source);
  assert.deepEqual(parsed.errors, [], `${file}: parser errors`);
  let sites: Site[] = [];
  if (file === "src/goal-compaction.ts") {
    sites = compactionSites(parsed.program);
  } else if (file === "src/tools.ts") {
    sites = toolSites(parsed.program);
  }
  const used = new Set<Site>();
  for (const comment of parsed.comments) {
    const text = comment.value.trim();
    if (!/^(?:oxlint|eslint|@ts-)/.test(text)) {
      continue;
    }
    const location = `${file}:${source.slice(0, comment.start).split("\n").length}`;
    if (text === "@ts-check") {
      continue;
    }
    if (/\.test-d\.[cm]?ts$/.test(file) && /^@ts-expect-error\s+.{10,}$/.test(text)) {
      continue;
    }
    const match = /^oxlint-disable-next-line ([\w/-]+) -- (QX-\d+): .+$/.exec(text);
    const site = sites.find(
      (candidate) =>
        candidate.start > comment.end &&
        /^\r?\n[ \t]*$/.test(source.slice(comment.end, candidate.start)),
    );
    assert.ok(match && site && !used.has(site), `${location}: unauthorized directive`);
    assert.equal(match[1], site.rule, `${location}: unauthorized rule`);
    assert.equal(match[2], site.id, `${location}: unauthorized exception`);
    used.add(site);
  }
  assert.equal(used.size, sites.length, `${file}: stale exception inventory`);
  checkImports(file, parsed.program);
}

function checkImports(file: string, program: Program): void {
  if (file.startsWith("test/")) {
    return;
  }
  const check = (specifier: string): void => {
    if (specifier.startsWith(".")) {
      const target = posix.normalize(posix.join(dirname(file), specifier));
      assert.ok(!target.startsWith("test/"), `${file}: production imports test-only ${target}`);
    }
  };
  new Visitor({
    ImportDeclaration(node) {
      check(node.source.value);
    },
    ExportNamedDeclaration(node) {
      if (node.source) {
        check(node.source.value);
      }
    },
    ExportAllDeclaration(node) {
      check(node.source.value);
    },
    ImportExpression(node) {
      if (node.source.type === "Literal" && typeof node.source.value === "string") {
        check(node.source.value);
      }
    },
    CallExpression(node) {
      const [argument] = node.arguments;
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        argument?.type === "Literal" &&
        typeof argument.value === "string"
      ) {
        check(argument.value);
      }
    },
  }).visit(program);
}
