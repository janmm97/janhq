import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// A throwaway J/OS root and database, so no real task is touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-attention-"));
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
  for (const table of ["tasks", "executions", "chats"]) run(`DELETE FROM ${table}`);
});

let n = 0;
async function task(status: string, opts: { route?: "One" | "Studio" | null; chat?: boolean; origin?: "chat" | "agent" | "probe" } = {}) {
  const { createChat, createTaskRow, updateTask, getTask } = await import("@/lib/server/tasks");
  const chatId = opts.chat ? createChat(`Chat ${++n}`).id : null;
  const t = createTaskRow({ chatId, origin: opts.origin ?? "chat", request: `Task ${++n}`, mode: "auto", routeSelection: "auto", context: { clarifications: [] } });
  updateTask(t.id, { status: status as never, route: opts.route === undefined ? "One" : opts.route });
  return getTask(t.id)!;
}

async function execution(taskId: string, status: string) {
  const { run } = await import("@/lib/server/db");
  run(
    `INSERT INTO executions(id, task_id, phase, workspace, cwd, adapter, runtime, binary, model, effort, status, created_at)
     VALUES (?, ?, 'execute', 'One', 'x', 'claude-code', 'Claude Code', 'claude.exe', 'claude-opus-5-5', 'medium', ?, ?)`,
    [`exe_attention_${++n}`, taskId, status, new Date().toISOString()],
  );
}

describe("what needs the operator", () => {
  it("lists approvals, questions and reconciliations, oldest first, with where to open each", async () => {
    const { attentionView } = await import("@/lib/server/views");
    const approval = await task("awaiting_approval", { chat: true });
    const question = await task("needs_clarification", { route: null });
    const held = await task("needs_reconciliation", { route: "Studio" });
    const interrupted = await task("interrupted");

    expect(attentionView()).toEqual([
      { taskId: approval.id, title: approval.title, route: "One", kind: "approval", since: expect.any(String), href: `/chat/${approval.chat_id}` },
      { taskId: question.id, title: question.title, route: null, kind: "question", since: expect.any(String), href: `/tasks/${question.id}` },
      { taskId: held.id, title: held.title, route: "Studio", kind: "reconcile", since: expect.any(String), href: `/tasks/${held.id}` },
      { taskId: interrupted.id, title: interrupted.title, route: "One", kind: "reconcile", since: expect.any(String), href: `/tasks/${interrupted.id}` },
    ]);
  });

  it("leaves out work that is running, finished, or a Runtime Health probe", async () => {
    const { attentionView } = await import("@/lib/server/views");
    for (const s of ["executing", "planning", "in_line", "completed", "failed", "cancelled", "planned"]) await task(s);
    await task("needs_clarification", { origin: "probe" });
    expect(attentionView()).toEqual([]);
  });

  it("counts an orphaned execution once, even after its task ended", async () => {
    const { attentionView } = await import("@/lib/server/views");
    const ended = await task("failed");
    await execution(ended.id, "needs_reconciliation");
    const listed = await task("needs_reconciliation");
    await execution(listed.id, "needs_reconciliation");

    expect(attentionView().map((i) => [i.taskId, i.kind, i.href])).toEqual([
      [listed.id, "reconcile", `/tasks/${listed.id}`],
      [ended.id, "reconcile", `/tasks/${ended.id}`],
    ]);
  });
});
