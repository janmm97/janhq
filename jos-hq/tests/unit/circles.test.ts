import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// A throwaway J/OS root and database, so no real task or agent is touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-circles-"));
const josRoot = path.join(tmp, "JOS");
process.env.JOS_HQ_JOS_ROOT = josRoot;
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
for (const d of ["One", "Studio", ".claude/agents", ".codex/agents"]) fs.mkdirSync(path.join(josRoot, d), { recursive: true });
Object.assign(globalThis, {
  __josOneCli: { ok: false, shim: null, cliJs: null, node: process.execPath, version: null, error: "One CLI disabled in unit tests" },
  __josOneCliAt: Number.MAX_SAFE_INTEGER,
});

beforeEach(async () => {
  const { run } = await import("@/lib/server/db");
  for (const table of ["tasks", "executions", "approvals", "events", "chats"]) run(`DELETE FROM ${table}`);
  // Each test registers its own agents.
  for (const d of [".claude/agents", ".codex/agents"]) {
    fs.rmSync(path.join(josRoot, d), { recursive: true, force: true });
    fs.mkdirSync(path.join(josRoot, d), { recursive: true });
  }
});

let n = 0;
async function task(route: "One" | "Studio", status: string, opts: { origin?: "chat" | "probe" | "agent"; daysAgo?: number; agent?: { workspace: "One" | "Studio"; name: string } } = {}) {
  const { createTaskRow, updateTask, getTask } = await import("@/lib/server/tasks");
  const context = { clarifications: [], ...(opts.agent ? { agent: opts.agent } : {}) };
  const t = createTaskRow({ chatId: null, origin: opts.origin ?? "chat", request: `Task ${++n}`, mode: "auto", routeSelection: route, context: context as never });
  updateTask(t.id, { route, status: status as never, ...(opts.daysAgo ? { created_at: new Date(Date.now() - opts.daysAgo * 86400_000).toISOString() } : {}) });
  return getTask(t.id)!;
}
async function event(taskId: string, type: string, data: unknown) {
  const { run } = await import("@/lib/server/db");
  run("INSERT INTO events(task_id, system, type, level, visibility, summary, data_json, created_at) VALUES (?, 'One', ?, 'info', 'chat', 'x', ?, ?)", [taskId, type, JSON.stringify(data), new Date().toISOString()]);
}
async function agent(workspace: "One" | "Studio", name: string) {
  const { createAgentDefinition } = await import("@/lib/server/agents");
  const platform = workspace === "One" ? { platform: "gmail", name: "Main Operator" } : { platform: "notion", name: "Studio Notion" };
  return createAgentDefinition({ workspace, name, connections: [platform], purpose: "p", mayDo: "m", mustNever: "n" });
}

describe("the Dashboard's circles: tasks", () => {
  it("counts completed, failed and abandoned out of the range's tasks, leaving out probes and older work", async () => {
    const { dashboardCircles } = await import("@/lib/server/views");
    await task("One", "completed");
    await task("Studio", "unverified");
    await task("One", "failed");
    await task("Studio", "blocked");
    await task("One", "cancelled");
    await task("Studio", "rejected");
    await task("One", "executing");
    await task("One", "completed", { origin: "probe" });
    await task("One", "completed", { daysAgo: 40 });

    expect(dashboardCircles("all", "7d").tasks).toMatchObject({ total: 7, completed: 2, failed: 2, abandoned: 2 });
    expect(dashboardCircles("One", "7d").tasks).toMatchObject({ total: 4, completed: 1, failed: 1, abandoned: 1 });
  });

  it("counts the tasks in line now out of the open ones, whatever the range", async () => {
    const { dashboardCircles } = await import("@/lib/server/views");
    await task("One", "in_line", { daysAgo: 40 });
    await task("One", "planning");
    await task("Studio", "awaiting_approval");
    await task("One", "completed");

    expect(dashboardCircles("all", "today").tasks).toMatchObject({ inLine: 1, open: 3 });
    expect(dashboardCircles("Studio", "today").tasks).toMatchObject({ inLine: 0, open: 1 });
  });
});

describe("the Dashboard's circles: agents", () => {
  it("counts the registered agents and the ones working, per system", async () => {
    const { dashboardCircles } = await import("@/lib/server/views");
    const one = await agent("One", "circle worker");
    await agent("Studio", "circle idler");
    await task("One", "executing", { origin: "agent", agent: { workspace: "One", name: one.name } });

    expect(dashboardCircles("all", "7d").agents).toMatchObject({ total: 2, running: 1 });
    expect(dashboardCircles("One", "7d").agents).toMatchObject({ total: 1, running: 1 });
    expect(dashboardCircles("Studio", "7d").agents).toMatchObject({ total: 1, running: 0 });
  });

  it("averages only the costs agent tasks reported, and says none when nothing reported", async () => {
    const { dashboardCircles } = await import("@/lib/server/views");
    expect(dashboardCircles("all", "7d").agents).toMatchObject({ avgCostUsd: null, agentTasks: 0, costed: 0 });

    const a = await agent("One", "circle spender");
    const who = { workspace: "One" as const, name: a.name };
    const first = await task("One", "completed", { origin: "agent", agent: who });
    const second = await task("One", "completed", { origin: "agent", agent: who });
    await task("One", "failed", { origin: "agent", agent: who });
    await event(first.id, "executor_result", { costUsd: 0.4 });
    await event(second.id, "executor_result", { costUsd: 0.6 });

    const c = dashboardCircles("all", "7d").agents;
    expect(c.avgCostUsd).toBeCloseTo(0.5, 10);
    expect(c).toMatchObject({ costed: 2, agentTasks: 3 });
    expect(dashboardCircles("Studio", "7d").agents).toMatchObject({ avgCostUsd: null, agentTasks: 0, costed: 0 });
  });
});
