import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskMode } from "@/lib/server/executors/types";

// A throwaway J/OS root and database, so no real task is touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-bench-"));
process.env.JOS_HQ_JOS_ROOT = path.join(tmp, "JOS");
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
fs.mkdirSync(path.join(tmp, "JOS", "One"), { recursive: true });
fs.mkdirSync(path.join(tmp, "JOS", "Studio"), { recursive: true });
Object.assign(globalThis, {
  __josOneCli: { ok: false, shim: null, cliJs: null, node: process.execPath, version: null, error: "One CLI disabled in unit tests" },
  __josOneCliAt: Number.MAX_SAFE_INTEGER,
});

beforeEach(async () => {
  const { run } = await import("@/lib/server/db");
  for (const table of ["tasks", "executions", "approvals", "events", "chats"]) run(`DELETE FROM ${table}`);
});
afterEach(() => {
  delete (globalThis as { __josHealth?: unknown }).__josHealth;
});

let n = 0;
async function task(route: "One" | "Studio", status: string, opts: { admitted?: boolean; mode?: TaskMode; origin?: "chat" | "probe"; context?: Record<string, unknown> } = {}) {
  const { createTaskRow, updateTask, getTask } = await import("@/lib/server/tasks");
  const t = createTaskRow({ chatId: null, origin: opts.origin ?? "chat", request: `Task ${++n}`, mode: opts.mode ?? "auto", routeSelection: route, context: { clarifications: [], ...opts.context } as never });
  updateTask(t.id, { route, status: status as never, admitted_at: opts.admitted ? new Date().toISOString() : null });
  return getTask(t.id)!;
}
async function execution(taskId: string, phase: string, status: string) {
  const { run } = await import("@/lib/server/db");
  run(
    `INSERT INTO executions(id, task_id, phase, workspace, cwd, adapter, runtime, binary, model, effort, status, created_at)
     VALUES (?, ?, ?, 'One', 'x', 'claude-code', 'Claude Code', 'claude.exe', 'claude-opus-5-5', 'medium', ?, ?)`,
    [`exe_bench_${++n}`, taskId, phase, status, new Date().toISOString()],
  );
}
async function event(taskId: string, type: string, data: unknown) {
  const { run } = await import("@/lib/server/db");
  run("INSERT INTO events(task_id, system, type, level, visibility, summary, data_json, created_at) VALUES (?, 'One', ?, 'info', 'chat', 'x', ?, ?)", [taskId, type, JSON.stringify(data), new Date().toISOString()]);
}

describe("the bench", () => {
  it("shows each bay's pins; an idle bay holds nothing and its line is empty", async () => {
    const { benchView } = await import("@/lib/server/views");
    const bench = benchView();
    expect(bench.One).toMatchObject({ workspace: "One", executor: { model: "claude-opus-5-5", effort: "medium" }, planner: { model: "claude-opus-5-5", effort: "medium" }, state: "Idle", blocker: null, holder: null, line: [] });
    expect(bench["Studio"]).toMatchObject({ workspace: "Studio", executor: { model: "gpt-6-sol", modelLabel: "GPT 6 Sol" }, planner: { model: "gpt-6-astra", modelLabel: "GPT 6 Astra" }, holder: null });
  });

  it("puts the task holding a workspace in its bay, with its stations and what it waits on", async () => {
    const { benchView } = await import("@/lib/server/views");
    const { run } = await import("@/lib/server/db");
    const t = await task("One", "awaiting_approval", { admitted: true, mode: "manual" });
    await execution(t.id, "preview", "exited");
    run("INSERT INTO approvals(id, task_id, execution_id, status, actions_json, summary, created_at) VALUES ('apr_bench_1', ?, NULL, 'pending', '[{},{}]', 'Send two drafts', ?)", [t.id, new Date().toISOString()]);

    const bench = benchView();
    expect(bench.One).toMatchObject({
      state: "Waiting",
      holder: { kind: "task", taskId: t.id, title: t.title, status: "awaiting_approval", mode: "manual", since: t.admitted_at, limitMs: null, waitingOn: "2 actions to approve", approvalId: "apr_bench_1", executions: [{ phase: "preview", status: "exited" }], approvals: [{ status: "pending" }] },
    });
    expect(bench["Studio"].holder).toBeNull();
  });

  it("says a holder's question, and a planning holder carries the planning limit", async () => {
    const { benchView } = await import("@/lib/server/views");
    await task("One", "needs_clarification", { admitted: true, context: { pendingQuestion: { kind: "mailbox", question: "Which mailbox should this send from?", options: [] } } });
    await task("Studio", "planning", { admitted: true });
    const bench = benchView();
    expect(bench.One.holder?.waitingOn).toBe("Which mailbox should this send from?");
    expect(bench["Studio"]).toMatchObject({ state: "Working", holder: { status: "planning", waitingOn: null, limitMs: 600000 } });
  });

  it("lists the line in the order tasks were sent, behind the holder", async () => {
    const { benchView } = await import("@/lib/server/views");
    const holder = await task("One", "executing", { admitted: true });
    const first = await task("One", "in_line", { mode: "edit" });
    const second = await task("One", "in_line");
    const bay = benchView().One;
    expect(bay.holder?.taskId).toBe(holder.id);
    expect(bay.line.map((l) => [l.taskId, l.mode])).toEqual([
      [first.id, "edit"],
      [second.id, "auto"],
    ]);
  });

  it("names a blocked workspace's blocker from Runtime Health", async () => {
    const { benchView } = await import("@/lib/server/views");
    (globalThis as { __josHealth?: unknown }).__josHealth = { report: { executors: { One: { dispatchable: false, blockers: ["Identity: expected one-operator@example.com"] }, "Studio": { dispatchable: true, blockers: [] } } } };
    const bench = benchView();
    expect(bench.One).toMatchObject({ state: "Blocked", blocker: "Identity: expected one-operator@example.com" });
    expect(bench["Studio"]).toMatchObject({ state: "Idle", blocker: null });
  });
});

describe("the drying line", () => {
  it("lists finished tasks newest first with what their runs reported costing, and leaves out running work and probes", async () => {
    const { dryingLine } = await import("@/lib/server/views");
    const done = await task("One", "completed");
    await event(done.id, "executor_result", { costUsd: 0.42 });
    await event(done.id, "planning_complete", { model: "claude-opus-5-5", attempts: [{ usage: { cost: 0.08 } }] });
    const failed = await task("Studio", "failed");
    await task("One", "executing", { admitted: true });
    await task("One", "completed", { origin: "probe" });

    const rows = dryingLine("all", "7d");
    expect(rows.map((r) => [r.taskId, r.route, r.status])).toEqual([
      [failed.id, "Studio", "failed"],
      [done.id, "One", "completed"],
    ]);
    expect(rows[0].cost).toBeNull();
    expect(rows[1].cost).toBeCloseTo(0.5, 10);
    expect(dryingLine("One", "7d").map((r) => r.taskId)).toEqual([done.id]);
  });
});
