import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import { visibleWidth } from "@earendil-works/pi-tui";

import { formatGoalObjective } from "../src/format.ts";
import { createGoalRuntimeStatus, type StatusContext } from "../src/goal-runtime-status.ts";
import type { ThreadGoal } from "../src/types.ts";
import { createRuntimeHarness, sessionShutdownEvent } from "./support/runtime-harness.ts";

type WidgetFactory = Exclude<Parameters<StatusContext["ui"]["setWidget"]>[1], undefined>;

function themeNamed(name: string): StatusContext["ui"]["theme"] {
  const fg: StatusContext["ui"]["theme"]["fg"] = (_color, text) =>
    `\x1b[${name === "dark" ? 35 : 34}m${text}\x1b[39m`;
  return { fg } as StatusContext["ui"]["theme"];
}

const activeGoal: ThreadGoal = {
  goalId: "goal-a",
  objective: "完成 CSV 导出 🚀",
  status: "active",
  tokenBudget: null,
  usage: { tokensUsed: 0, activeSeconds: 0 },
  createdAt: 0,
  updatedAt: 0,
};

function createStatusHarness(initialGoal: ThreadGoal | null = activeGoal, mode: StatusContext["mode"] = "tui") {
  let goal = initialGoal;
  let widget: WidgetFactory | string[] | undefined;
  let theme = themeNamed("dark");
  const widgetCalls: Array<{ key: string; placement: string | undefined }> = [];
  const footerStatuses: Array<string | undefined> = [];
  const ctx: StatusContext = {
    mode,
    ui: {
      setStatus(_key, text) { footerStatuses.push(text); },
      setWidget(key, content, options) {
        widget = content;
        widgetCalls.push({ key, placement: options?.placement });
      },
      get theme() { return theme; },
    },
  };
  const runtime = createGoalRuntimeStatus({
    getGoalForDisplay: () => goal,
    getGoalStatus: () => goal?.status ?? null,
    getRecoveryAttention: () => null,
    isProviderLimitAutoResumeScheduled: () => false,
  });
  return {
    ctx,
    runtime,
    footerStatuses,
    widgetCalls,
    setGoal(next: ThreadGoal | null) { goal = next; },
    setTheme(name: string) { theme = themeNamed(name); },
    get widget() { return widget; },
    component() {
      assert.equal(typeof widget, "function");
      if (typeof widget !== "function") throw new Error("Expected a goal widget factory");
      // This stateless widget does not use the TUI argument or start a renderer.
      return widget({} as Parameters<WidgetFactory>[0], theme);
    },
  };
}

test("active goal gets a dedicated below-editor row without replacing footer usage", (t) => {
  const h = createStatusHarness();
  t.after(h.runtime.stopStatusRefresh);
  h.runtime.refreshUi(h.ctx);

  assert.deepEqual(h.widgetCalls, [{ key: "codex-goal-objective", placement: "belowEditor" }]);
  assert.equal(h.footerStatuses.at(-1), "Pursuing goal");
  assert.deepEqual(h.component().render(100).map(stripVTControlCharacters), ["Goal (active): 完成 CSV 导出 🚀"]);
});

test("unfinished goal states are explicit; completing or clearing removes the row", (t) => {
  const h = createStatusHarness();
  t.after(h.runtime.stopStatusRefresh);
  for (const [status, label] of [
    ["active", "active"], ["paused", "paused"], ["blocked", "blocked"], ["waiting", "waiting"], ["budgetLimited", "limited by budget"],
  ] as const) {
    h.setGoal({ ...activeGoal, status });
    h.runtime.refreshUi(h.ctx);
    assert.equal(stripVTControlCharacters(h.component().render(100)[0]!), `Goal (${label}): ${activeGoal.objective}`);
  }
  h.setGoal({ ...activeGoal, status: "complete" });
  h.runtime.refreshUi(h.ctx);
  assert.equal(h.widget, undefined);
  h.setGoal({ ...activeGoal, goalId: "goal-b", objective: "replacement objective" });
  h.runtime.refreshUi(h.ctx);
  assert.match(stripVTControlCharacters(h.component().render(100)[0]!), /replacement objective/);
  h.setGoal(null);
  h.runtime.refreshUi(h.ctx);
  assert.equal(h.widget, undefined);
  assert.equal(h.footerStatuses.at(-1), undefined);
});

test("objective is single-line plain text; source text is unchanged", () => {
  const goal = {
    ...activeGoal,
    objective: "  first\r\n\t\x1b[31m红色\x1b[0m\x1b]0;fake title\x07\x00\x85next\u2028last  ",
  };
  const original = goal.objective;
  assert.equal(formatGoalObjective(goal), "Goal (active): first 红色 next last");
  assert.equal(goal.objective, original);
  assert.equal(formatGoalObjective(null), undefined);
  assert.equal(formatGoalObjective({ ...activeGoal, status: "complete" }), undefined);
});

test("long CJK, emoji and combining text stays one row across narrow widths and resize", (t) => {
  const h = createStatusHarness({ ...activeGoal, objective: "修复导出 👩‍💻 é ".repeat(100) });
  t.after(h.runtime.stopStatusRefresh);
  h.runtime.refreshUi(h.ctx);
  const component = h.component();
  for (const width of [0, 1, 2, 5, 20, 40, 80, 160, 10]) {
    const lines = component.render(width);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]!) <= width, `line fits ${width} columns`);
    assert.doesNotMatch(stripVTControlCharacters(lines[0]!), /[\r\n\t]/);
    if (width > 0) assert.ok(stripVTControlCharacters(lines[0]!).endsWith("…"));
  }
});

test("existing widget uses the current theme after invalidation", (t) => {
  const h = createStatusHarness();
  t.after(h.runtime.stopStatusRefresh);
  h.runtime.refreshUi(h.ctx);
  const component = h.component();
  const dark = component.render(100)[0];
  h.setTheme("light");
  component.invalidate();
  const light = component.render(100)[0];
  assert.notEqual(light, dark);
  assert.equal(light, h.ctx.ui.theme.fg("accent", formatGoalObjective(activeGoal)!));
});

for (const mode of ["rpc", "json", "print"] as const) {
  test(`${mode} keeps goal status but never creates a terminal widget`, (t) => {
    const h = createStatusHarness(activeGoal, mode);
    t.after(h.runtime.stopStatusRefresh);
    h.runtime.refreshUi(h.ctx);
    assert.equal(h.footerStatuses.at(-1), "Pursuing goal");
    assert.deepEqual(h.widgetCalls, []);
    h.setGoal({ ...activeGoal, status: "waiting", waitingReason: "Explorer report" });
    h.runtime.refreshUi(h.ctx);
    assert.equal(h.footerStatuses.at(-1), "Goal waiting: Explorer report (/goal resume)");
    assert.deepEqual(h.widgetCalls, []);
  });
}

test("footer clock does not recreate the objective row and stops on pause", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = createStatusHarness();
  t.after(h.runtime.stopStatusRefresh);
  h.runtime.refreshUi(h.ctx);
  h.setGoal({ ...activeGoal, usage: { tokensUsed: 0, activeSeconds: 3 } });
  t.mock.timers.tick(1_000);
  assert.equal(h.footerStatuses.at(-1), "Pursuing goal (3s)");
  assert.equal(h.widgetCalls.length, 1);
  h.setGoal({ ...activeGoal, status: "paused" });
  h.runtime.refreshUi(h.ctx);
  const count = h.footerStatuses.length;
  t.mock.timers.tick(5_000);
  assert.equal(h.footerStatuses.length, count);
});

test("waiting keeps the objective and safe reason visible without a footer clock; waking restarts it", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = createStatusHarness();
  t.after(h.runtime.stopStatusRefresh);
  h.runtime.refreshUi(h.ctx);
  const waiting: ThreadGoal = {
    ...activeGoal,
    status: "waiting",
    waitingReason: "\x1b[31mExplorer\x1b[0m\n report\tA",
  };
  h.setGoal(waiting);
  h.runtime.refreshUi(h.ctx);
  const objective = formatGoalObjective(waiting)!;
  assert.equal(objective, `Goal (waiting): ${activeGoal.objective}`);
  assert.equal(h.component().render(100)[0], h.ctx.ui.theme.fg("warning", objective));
  assert.equal(h.footerStatuses.at(-1), "Goal waiting: Explorer report A (/goal resume)");
  const count = h.footerStatuses.length;
  t.mock.timers.tick(5_000);
  assert.equal(h.footerStatuses.length, count, "waiting has no live footer clock");
  assert.equal(h.widgetCalls.length, 2);
  h.setGoal(activeGoal);
  h.runtime.refreshUi(h.ctx);
  assert.equal(h.component().render(100)[0], h.ctx.ui.theme.fg("accent", formatGoalObjective(activeGoal)!));
  h.setGoal({ ...activeGoal, usage: { tokensUsed: 0, activeSeconds: 3 } });
  t.mock.timers.tick(1_000);
  assert.equal(h.footerStatuses.at(-1), "Pursuing goal (3s)");
  assert.equal(h.widgetCalls.length, 3, "footer ticks do not recreate the objective widget");
});

test("real command/tool transitions, reload and tree navigation refresh or clear the row", async (t) => {
  const h = createRuntimeHarness({ theme: themeNamed("dark") });
  t.after(async () => { await h.emit("session_shutdown", sessionShutdownEvent()); });
  const rows: Array<string | undefined> = [];
  h.ui.setWidget = (_key, content) => {
    if (typeof content === "function") {
      rows.push(stripVTControlCharacters(content({} as Parameters<WidgetFactory>[0], h.ui.theme).render(100)[0]!));
    } else {
      assert.equal(content, undefined);
      rows.push(undefined);
    }
  };
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  assert.equal(rows.at(-1), undefined);
  await h.runTool("create_goal", { objective: "tool objective" });
  assert.equal(rows.at(-1), "Goal (active): tool objective");
  await h.runCommand("pause");
  assert.equal(rows.at(-1), "Goal (paused): tool objective");
  await h.runCommand("resume");
  assert.equal(rows.at(-1), "Goal (active): tool objective");
  await h.runTool("update_goal", { status: "waiting", reason: "Explorer report" });
  assert.equal(rows.at(-1), "Goal (waiting): tool objective");
  await h.emit("session_shutdown", sessionShutdownEvent("reload"));
  await h.reloadSession("reload");
  assert.equal(rows.at(-1), "Goal (waiting): tool objective");
  await h.emit("session_tree", { type: "session_tree" });
  assert.equal(rows.at(-1), "Goal (waiting): tool objective");
  await h.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1 });
  await h.emit("message_start", { type: "message_start", message: {
    role: "custom", customType: "explorer-result", content: "Report A", display: true, timestamp: 1,
  } });
  assert.equal(rows.at(-1), "Goal (active): tool objective");
  await h.runTool("update_goal", { status: "waiting", reason: "Another explorer report" });
  assert.equal(rows.at(-1), "Goal (waiting): tool objective");
  await h.runCommand("pause");
  assert.equal(rows.at(-1), "Goal (paused): tool objective");
  await h.runCommand("resume");
  assert.equal(rows.at(-1), "Goal (active): tool objective");
  await h.runTool("update_goal", { status: "blocked", reason: "needs input" });
  assert.equal(rows.at(-1), "Goal (blocked): tool objective");
  await h.emit("session_shutdown", sessionShutdownEvent("reload"));
  await h.reloadSession("reload");
  assert.equal(rows.at(-1), "Goal (blocked): tool objective");
  await h.runCommand("resume");
  await h.runTool("update_goal", { status: "complete" });
  assert.equal(rows.at(-1), undefined);
  await h.runCommand("command objective");
  assert.equal(rows.at(-1), "Goal (active): command objective");
  await h.runCommand("clear");
  assert.equal(rows.at(-1), undefined);
  await h.runCommand("another branch objective");
  assert.equal(rows.at(-1), "Goal (active): another branch objective");
  h.entries.length = 0;
  await h.emit("session_tree", { type: "session_tree" });
  assert.equal(rows.at(-1), undefined);
});
