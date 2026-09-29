import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskMode } from "@/lib/server/executors/types";

// A throwaway J/OS root and database, so no real log or task is touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-queue-"));
const josRoot = path.join(tmp, "JOS");
process.env.JOS_HQ_JOS_ROOT = josRoot;
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
// No test may reach a real One account. A task these tests start stops at its first One call,
// exactly as it would with the CLI missing (lib/server/one/cli.ts caches this on globalThis).
Object.assign(globalThis, {
  __josOneCli: { ok: false, shim: null, cliJs: null, node: process.execPath, version: null, error: "One CLI disabled in unit tests" },
  __josOneCliAt: Number.MAX_SAFE_INTEGER,
});

beforeAll(() => {
  for (const ws of ["One", "Studio"]) fs.mkdirSync(path.join(josRoot, ws), { recursive: true });
  fs.writeFileSync(path.join(josRoot, "ONEMEMORY.md"), "# J/OS — One session log\n\nWork routed to `One/`. Newest entry first.\n\n---\n");
  fs.writeFileSync(path.join(josRoot, "STUDIOMEMORY.md"), "# Studio — session log\n\n---\n");
  fs.writeFileSync(path.join(josRoot, "JOSMEMORY.md"), "# J/OS — Orchestrator session log\n\nWork that routes nowhere.\n");
});

beforeEach(async () => {
  const { run } = await import("@/lib/server/db");
  const { releaseWorkspace } = await import("@/lib/server/queue");
  for (const table of ["tasks", "executions", "chats", "chat_messages", "events", "approvals", "approval_actions"]) run(`DELETE FROM ${table}`);
  releaseWorkspace("One");
  releaseWorkspace("Studio");
});

let n = 0;
let clock = Date.parse("2026-09-24T05:00:00.000Z");
type Opts = { admitted?: boolean; mode?: TaskMode; chatId?: string | null; context?: Record<string, unknown> };

/** A task routed to `route` in `status`, sent one second after the previous one. */
async function task(route: "One" | "Studio", status: string, opts: Opts = {}) {
  const { createTaskRow, updateTask, getTask } = await import("@/lib/server/tasks");
  const t = createTaskRow({ chatId: opts.chatId ?? null, origin: "chat", request: `Task ${++n}`, mode: opts.mode ?? "auto", routeSelection: route, context: { clarifications: [], ...opts.context } as never });
  clock += 1000;
  const at = new Date(clock).toISOString();
  updateTask(t.id, { route, status: status as never, created_at: at, admitted_at: opts.admitted ? at : null });
  return getTask(t.id)!;
}

async function execution(taskId: string, workspace: "One" | "Studio", status: string, pid: number | null = null) {
  const { run } = await import("@/lib/server/db");
  run(
    `INSERT INTO executions(id, task_id, phase, workspace, cwd, adapter, runtime, binary, model, effort, pid, status, created_at)
     VALUES (?, ?, 'preview', ?, 'x', 'claude-code', 'Claude Code', 'claude.exe', 'claude-opus-5', 'medium', ?, ?, ?)`,
    [`exe_test_${++n}`, taskId, workspace, pid, status, new Date().toISOString()],
  );
}

describe("the workspace line", () => {
  it("admits the first task in a free workspace's line, and then holds the workspace for it", async () => {
    const { admitNext, workspaceHolders } = await import("@/lib/server/queue");
    const { getTask } = await import("@/lib/server/tasks");
    const first = await task("One", "in_line");
    const second = await task("One", "in_line");

    expect(admitNext("One")?.id).toBe(first.id);
    expect(getTask(first.id)).toMatchObject({ status: "planning", stage: "plan" });
    expect(getTask(first.id)?.admitted_at).toBeTruthy();
    expect(workspaceHolders("One").map((h) => h.taskId)).toEqual([first.id]);
    expect(admitNext("One")).toBeNull();
    expect(getTask(second.id)?.status).toBe("in_line");
  });

  it("keeps One and Studio in separate lines", async () => {
    const { admitNext } = await import("@/lib/server/queue");
    const { getTask } = await import("@/lib/server/tasks");
    await task("Studio", "executing", { admitted: true });
    const waitingStudio = await task("Studio", "in_line");
    const one = await task("One", "in_line");

    expect(admitNext("Studio")).toBeNull();
    expect(admitNext("One")?.id).toBe(one.id);
    expect(getTask(waitingStudio.id)?.status).toBe("in_line");
  });

  it.each(["planning", "dispatching", "executing", "verifying", "awaiting_approval", "needs_clarification", "needs_reconciliation"])(
    "an admitted task that is %s keeps its workspace",
    async (status) => {
      const { admitNext, workspaceHolders } = await import("@/lib/server/queue");
      const holder = await task("One", status, { admitted: true });
      await task("One", "in_line");

      expect(admitNext("One")).toBeNull();
      expect(workspaceHolders("One")).toEqual([{ kind: "task", taskId: holder.id, title: holder.title, status }]);
    },
  );

  it.each(["completed", "unverified", "planned", "failed", "blocked", "cancelled", "rejected", "closed", "interrupted"])(
    "a task that ended %s frees its workspace",
    async (status) => {
      const { admitNext } = await import("@/lib/server/queue");
      await task("One", status, { admitted: true });
      const next = await task("One", "in_line");

      expect(admitNext("One")?.id).toBe(next.id);
    },
  );

  it("does not count a task that was never admitted: a question before the line, or Plan mode", async () => {
    const { admitNext } = await import("@/lib/server/queue");
    await task("One", "needs_clarification");
    await task("One", "planning", { mode: "plan" });
    const next = await task("One", "in_line");

    expect(admitNext("One")?.id).toBe(next.id);
  });

  it("is held by a live executor, and by an orphan only while its process is alive", async () => {
    const { admitNext, workspaceHolders } = await import("@/lib/server/queue");
    const { run } = await import("@/lib/server/db");
    const ended = await task("One", "failed", { admitted: true });
    await execution(ended.id, "One", "running");
    const next = await task("One", "in_line");

    expect(workspaceHolders("One")).toMatchObject([{ kind: "execution", taskId: ended.id, status: "running" }]);
    expect(admitNext("One")).toBeNull();

    run("UPDATE executions SET status = 'needs_reconciliation', pid = ?", [process.pid]);
    expect(admitNext("One")).toBeNull();

    run("UPDATE executions SET pid = NULL"); // its process is gone
    expect(admitNext("One")?.id).toBe(next.id);
  });

  it("is held by the Runtime Health check's executor, whose task routes nowhere", async () => {
    const { admitNext } = await import("@/lib/server/queue");
    const { updateTask } = await import("@/lib/server/tasks");
    const probe = await task("One", "executing");
    updateTask(probe.id, { route: "none", origin: "probe" });
    await execution(probe.id, "One", "running");
    await task("One", "in_line");

    expect(admitNext("One")).toBeNull();
  });

  it("is held by a reservation until it is released", async () => {
    const { admitNext, releaseWorkspace, reserveWorkspace, workspaceHolders } = await import("@/lib/server/queue");
    const next = await task("Studio", "in_line");
    reserveWorkspace("Studio", "Runtime Health check");

    expect(workspaceHolders("Studio")).toEqual([{ kind: "reserved", taskId: null, title: "Runtime Health check", status: "reserved" }]);
    expect(admitNext("Studio")).toBeNull();
    releaseWorkspace("Studio");
    expect(admitNext("Studio")?.id).toBe(next.id);
  });

  it("skips a task that is being cancelled", async () => {
    const { admitNext } = await import("@/lib/server/queue");
    await task("One", "in_line", { context: { cancelRequested: true } });
    const next = await task("One", "in_line");

    expect(admitNext("One")?.id).toBe(next.id);
  });

  it("admits a task that holds its workspace from before the upgrade, instead of waiting on itself", async () => {
    const { admitNext } = await import("@/lib/server/queue");
    const self = await task("One", "in_line", { admitted: true });

    expect(admitNext("One")?.id).toBe(self.id);
  });

  it("does not let tasks backfilled from before the upgrade wait on each other once both are back in line", async () => {
    const { admitNext, workspaceHolders } = await import("@/lib/server/queue");
    const x1 = await task("One", "in_line", { admitted: true });
    await task("One", "in_line", { admitted: true });

    expect(workspaceHolders("One")).toEqual([]);
    expect(admitNext("One")?.id).toBe(x1.id);
  });

  it("settles an orphan whose process has exited or whose PID now belongs to another program", async () => {
    const { settleDeadOrphans } = await import("@/lib/server/dispatch");
    const { all } = await import("@/lib/server/db");
    const ended = await task("One", "cancelled", { admitted: true });
    await execution(ended.id, "One", "needs_reconciliation", null); // exited: no process left
    await execution(ended.id, "One", "needs_reconciliation", process.pid); // PID reused: this is node, not claude or codex
    await execution(ended.id, "One", "running", process.pid); // a supervised run is never touched

    expect(await settleDeadOrphans()).toBe(2);
    expect(all<{ status: string }>("SELECT status FROM executions WHERE task_id = ? ORDER BY rowid", [ended.id]).map((r) => r.status)).toEqual(["interrupted", "interrupted", "running"]);
  });

  it("tells a waiting task its place and what is directly ahead", async () => {
    const { lineInfo } = await import("@/lib/server/queue");
    const running = await task("One", "executing", { admitted: true });
    const b = await task("One", "in_line");
    const c = await task("One", "in_line");

    expect(lineInfo(b.id)).toMatchObject({ workspace: "One", position: 1, ordinal: "1st", ahead: { taskId: running.id, title: running.title } });
    expect(lineInfo(c.id)).toMatchObject({ workspace: "One", position: 2, ordinal: "2nd", ahead: { taskId: b.id, title: b.title } });
    expect(lineInfo(running.id)).toBeNull();
  });

  it("writes ordinals the way people read them", async () => {
    const { ordinal } = await import("@/lib/server/queue");
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]);
  });

  it("backfills admitted_at for tasks that predate the line, once", async () => {
    const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    const { migrateSchema } = await import("@/lib/server/db");
    const h = new sqlite.DatabaseSync(":memory:");
    h.exec("CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT, purpose TEXT, created_at TEXT, updated_at TEXT)");
    h.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, route TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL)");
    h.exec("INSERT INTO tasks VALUES ('a', 'One', 'awaiting_approval', '2026-09-24T01:00:00Z'), ('b', 'none', 'closed', '2026-09-24T02:00:00Z'), ('c', NULL, 'routing', '2026-09-24T03:00:00Z')");

    migrateSchema(h);
    migrateSchema(h);

    expect(h.prepare("SELECT id, admitted_at FROM tasks ORDER BY id").all()).toEqual([
      { id: "a", admitted_at: "2026-09-24T01:00:00Z" },
      { id: "b", admitted_at: null },
      { id: "c", admitted_at: null },
    ]);
  });
});

describe("the pipeline waits in line", () => {
  it("sends every mode to the line after discovery, Plan included: it launches a planning session", async () => {
    const { afterDiscovery } = await import("@/lib/server/orchestrator");
    for (const mode of ["auto", "manual", "edit", "plan"] as const) expect(afterDiscovery(mode)).toEqual({ status: "in_line", stage: "queue" });
  });

  it("tells a waiting task where it is and, if it matters, that the line is stuck", async () => {
    const { lineMessage } = await import("@/lib/server/orchestrator");
    expect(lineMessage("One", { workspace: "One", position: 2, ordinal: "2nd", ahead: { taskId: "jos_b", title: "Draft the MSA summary", status: "in_line" }, heldBy: [] })).toBe(
      "In line for One: 2nd in line, behind “Draft the MSA summary”.",
    );
    const stuck = { kind: "task" as const, taskId: "jos_a", title: "Send the scorecard", status: "needs_reconciliation" };
    expect(lineMessage("Studio", { workspace: "Studio", position: 1, ordinal: "1st", ahead: stuck, heldBy: [stuck] })).toBe(
      "In line for Studio: 1st in line, behind “Send the scorecard”. “Send the scorecard” needs reconciling in HQ before anything else runs in Studio.",
    );
    const orphan = { kind: "execution" as const, taskId: "jos_c", title: "Weekly scorecard", status: "needs_reconciliation" };
    expect(lineMessage("One", { workspace: "One", position: 1, ordinal: "1st", ahead: orphan, heldBy: [orphan] })).toBe(
      "In line for One: 1st in line, behind “Weekly scorecard”. An orphaned executor from “Weekly scorecard” is still running in One; terminate it from that task in HQ.",
    );
  });

  it("the minute tick starts a line that an orphan was holding, once the orphan is gone", async () => {
    const { getTask } = await import("@/lib/server/tasks");
    const { admitNext } = await import("@/lib/server/queue");
    const { lineTick } = await import("@/lib/server/orchestrator");
    const reconciled = await task("One", "unverified", { admitted: true });
    await execution(reconciled.id, "One", "needs_reconciliation", process.pid); // looks alive by PID alone
    const waiting = await task("One", "in_line");
    expect(admitNext("One")).toBeNull();

    await lineTick();

    expect(getTask(waiting.id)?.admitted_at).toBeTruthy();
    await vi.waitFor(() => expect(["blocked", "failed"]).toContain(getTask(waiting.id)?.status), { timeout: 10_000 });
  });

  it("a mailbox answer joins the line instead of jumping to planning, and says so once", async () => {
    const { createChat, chatMessages, getTask, taskContext } = await import("@/lib/server/tasks");
    const { answerClarification } = await import("@/lib/server/orchestrator");
    const chat = createChat("Mailbox");
    const holder = await task("One", "executing", { admitted: true });
    const asked = await task("One", "needs_clarification", {
      chatId: chat.id,
      context: { pendingQuestion: { kind: "mailbox", question: "Which mailbox?", options: [{ value: "Main Operator", label: "Main Operator" }] } },
    });

    await answerClarification(asked.id, "Main Operator");

    await vi.waitFor(() => expect(taskContext(getTask(asked.id)!).line).toBeTruthy());
    expect(getTask(asked.id)).toMatchObject({ status: "in_line", stage: "queue" });
    expect(taskContext(getTask(asked.id)!).mailbox).toBe("Main Operator");
    expect(chatMessages(chat.id).filter((m) => m.kind === "line").map((m) => m.content)).toEqual([`In line for One: 1st in line, behind “${holder.title}”.`]);
  });

  it("when a task ends, the next task in its line starts by itself", async () => {
    const { getTask } = await import("@/lib/server/tasks");
    const { all } = await import("@/lib/server/db");
    const { cancelTask } = await import("@/lib/server/orchestrator");
    const holder = await task("One", "needs_clarification", { admitted: true });
    const next = await task("One", "in_line");

    await cancelTask(holder.id, false);

    expect(getTask(holder.id)?.status).toBe("cancelled");
    await vi.waitFor(() => expect(getTask(next.id)?.admitted_at).toBeTruthy());
    // With the One CLI disabled, the started task stops at its first One call: proof that it was
    // started, and that nothing real ran.
    await vi.waitFor(() => expect(["blocked", "failed"]).toContain(getTask(next.id)?.status), { timeout: 10_000 });
    expect(all("SELECT id FROM executions WHERE task_id = ?", [next.id])).toEqual([]);
  });

  it("Stop on a waiting task ends it cancelled, and the task behind it moves up", async () => {
    const { getTask } = await import("@/lib/server/tasks");
    const { cancelTask } = await import("@/lib/server/orchestrator");
    const { lineInfo } = await import("@/lib/server/queue");
    await task("One", "executing", { admitted: true });
    const waiting = await task("One", "in_line");
    const behind = await task("One", "in_line");

    expect(await cancelTask(waiting.id, false)).toEqual({ ok: true, detail: "cancelled" });

    expect(getTask(waiting.id)?.status).toBe("cancelled");
    expect(getTask(waiting.id)?.admitted_at).toBeNull();
    expect(lineInfo(behind.id)).toMatchObject({ position: 1, ordinal: "1st" });
  });

  it("a restart leaves waiting tasks in line, and the next kick admits the first", async () => {
    const { getTask } = await import("@/lib/server/tasks");
    const { reconcileTasksAfterRestart } = await import("@/lib/server/orchestrator");
    const { admitNext } = await import("@/lib/server/queue");
    const running = await task("One", "executing", { admitted: true });
    const waiting = await task("One", "in_line");

    await reconcileTasksAfterRestart();

    expect(getTask(running.id)?.status).toBe("interrupted");
    expect(getTask(waiting.id)?.status).toBe("in_line");
    expect(admitNext("One")?.id).toBe(waiting.id);
  });

  it("admission refreshes a waiting follow-up's chat history and says whose turn it is", async () => {
    const { createChat, addMessage, chatMessages, getTask, taskContext, updateTask } = await import("@/lib/server/tasks");
    const { openLogEntry } = await import("@/lib/server/logs");
    const { admitNext } = await import("@/lib/server/queue");
    const { afterAdmission } = await import("@/lib/server/orchestrator");
    const chat = createChat("Follow-up");
    const first = await task("One", "completed", { admitted: true, chatId: chat.id });
    addMessage(chat.id, "assistant", "result", "Drafted the MSA summary.", first.id);
    const followUp = await task("One", "in_line", {
      chatId: chat.id,
      context: {
        conversation: { route: "One", lastTaskId: first.id, lastTitle: first.title, text: "stale history" },
        line: { joinedAt: "2026-09-24T05:40:00.000Z", behindTaskId: first.id, behindTitle: first.title },
      },
    });
    const sentLater = await task("One", "in_line", { chatId: chat.id });
    await openLogEntry({ taskId: followUp.id, file: "ONEMEMORY.md", title: followUp.title, asked: followUp.request, route: "One — test" });
    updateTask(followUp.id, { log_file: "ONEMEMORY.md", log_opened_at: new Date().toISOString() });

    const admitted = admitNext("One")!;
    expect(admitted.id).toBe(followUp.id);
    afterAdmission(admitted);

    const history = taskContext(getTask(followUp.id)!).conversation?.text ?? "";
    expect(history).toContain("Drafted the MSA summary.");
    expect(history).not.toContain(sentLater.request);
    expect(chatMessages(chat.id).filter((m) => m.task_id === followUp.id && m.kind === "line").map((m) => m.content)).toEqual(["Your turn, starting now."]);
    await vi.waitFor(() =>
      expect(fs.readFileSync(path.join(josRoot, "ONEMEMORY.md"), "utf8")).toMatch(/- \*\*In line:\*\* waited \d{2}:\d{2}–\d{2}:\d{2} [A-Z]+ behind “Task \d+” \(jos_/),
    );
  });
});

describe("Runtime Health and the line", () => {
  it("refuses to verify while a workspace is busy, and launches nothing", async () => {
    const { all } = await import("@/lib/server/db");
    const { verifyModels } = await import("@/lib/server/health");
    const holder = await task("Studio", "awaiting_approval", { admitted: true });

    await expect(verifyModels()).rejects.toMatchObject({ code: "WORKSPACE_BUSY", message: `Studio is busy with “${holder.title}”. Verify the models when it is free.` });
    expect(all("SELECT id FROM tasks WHERE origin = 'probe'")).toEqual([]);
  });

  it("releases both workspaces when the check ends, even when it fails, and starts the next task", async () => {
    // Fake runtimes (dispatch.ts caches adapters on globalThis), so the failure path never runs a real claude or codex binary.
    const fake = (id: string) => ({ id, checkAvailability: async () => ({ ok: false, binary: null, version: null, error: "not installed (unit test)" }) });
    Object.assign(globalThis, { __josAdapters: { One: fake("claude-code"), "Studio": fake("codex") } });
    try {
      const { getTask } = await import("@/lib/server/tasks");
      const { workspaceHolders } = await import("@/lib/server/queue");
      const { verifyModels } = await import("@/lib/server/health");
      const waiting = await task("One", "in_line");

      const r = await verifyModels();

      expect(r.results.map((x) => `${x.workspace} ${x.role} ${x.ok}`)).toEqual(["One planner false", "One executor false", "Studio planner false", "Studio executor false"]);
      expect(workspaceHolders("One").filter((h) => h.kind === "reserved")).toEqual([]);
      expect(workspaceHolders("Studio")).toEqual([]);
      expect(getTask(waiting.id)?.admitted_at).toBeTruthy();
      await vi.waitFor(() => expect(["blocked", "failed"]).toContain(getTask(waiting.id)?.status), { timeout: 10_000 });
    } finally {
      delete (globalThis as { __josAdapters?: unknown }).__josAdapters;
    }
  });
});

describe("what the dashboard shows", () => {
  it("counts each workspace's line", async () => {
    const { liveSystems } = await import("@/lib/server/views");
    await task("One", "executing", { admitted: true });
    await task("One", "in_line");
    await task("One", "in_line");

    const live = liveSystems();
    expect(live.executors.One.inLine).toBe(2);
    expect(live.executors["Studio"].inLine).toBe(0);
  });
});
