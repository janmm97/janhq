// One executor at a time per workspace (Jan, 2026-09-24; design in
// Tasks/Workspace-Queue-Design-2026-09-24.md). A task routed to One or Studio waits "in line" after
// discovery and is admitted once its workspace is free and no task sent before it is still waiting.
// Admission checks and writes with no await in between, so in this single Node process two tasks can
// never both be admitted.
import { all } from "./db";
import { isPidAlive } from "./proc";
import { getTask, updateTask, type TaskRow, type TaskStatus } from "./tasks";
import { nowIso } from "./util/time";
import type { WorkspaceId } from "./env";

/** A task in one of these no longer holds its workspace. needs_reconciliation is left out on purpose. */
export const RELEASING_STATUSES: TaskStatus[] = ["completed", "unverified", "planned", "failed", "blocked", "cancelled", "rejected", "closed", "interrupted"];

export interface Holder {
  kind: "task" | "execution" | "reserved";
  taskId: string | null;
  title: string;
  status: string;
}

export interface LineInfo {
  workspace: WorkspaceId;
  /** 1 runs next. Only waiting tasks are counted. */
  position: number;
  ordinal: string;
  /** Directly ahead: the task before it in line or, for the 1st, what holds the workspace. */
  ahead: { taskId: string | null; title: string; status: string } | null;
  heldBy: Holder[];
}

const g = globalThis as unknown as { __josReserved?: Map<WorkspaceId, string> };
function reservations(): Map<WorkspaceId, string> {
  g.__josReserved ??= new Map();
  return g.__josReserved;
}

/** Holds `ws` for work outside the task pipeline (the Runtime Health check) until released. */
export function reserveWorkspace(ws: WorkspaceId, reason: string): void {
  reservations().set(ws, reason);
}

export function releaseWorkspace(ws: WorkspaceId): void {
  reservations().delete(ws);
}

/** What keeps `ws` busy right now; empty means free. `exceptTaskId` is never counted against itself. */
export function workspaceHolders(ws: WorkspaceId, exceptTaskId: string | null = null): Holder[] {
  const tasks: Holder[] = all<{ id: string; title: string; status: string }>(
    // A task back in line holds nothing, even with admitted_at set (backfilled from before the line).
    `SELECT id, title, status FROM tasks
      WHERE route = ? AND admitted_at IS NOT NULL AND id IS NOT ? AND status <> 'in_line'
        AND status NOT IN (${RELEASING_STATUSES.map(() => "?").join(", ")})
      ORDER BY admitted_at, rowid`,
    [ws, exceptTaskId, ...RELEASING_STATUSES],
  ).map((t) => ({ kind: "task" as const, taskId: t.id, title: t.title, status: t.status }));
  const executions: Holder[] = all<{ task_id: string; title: string | null; status: string; pid: number | null }>(
    `SELECT e.task_id, t.title, e.status, e.pid FROM executions e LEFT JOIN tasks t ON t.id = e.task_id
      WHERE e.workspace = ? AND e.task_id IS NOT ? AND e.status IN ('starting', 'running', 'needs_reconciliation')
      ORDER BY e.created_at`,
    [ws, exceptTaskId],
  )
    // An orphan HQ lost track of holds the workspace only while its process is still alive.
    .filter((e) => e.status !== "needs_reconciliation" || isPidAlive(e.pid))
    .filter((e) => !tasks.some((t) => t.taskId === e.task_id))
    .map((e) => ({ kind: "execution" as const, taskId: e.task_id, title: e.title ?? e.task_id, status: e.status }));
  const reason = reservations().get(ws);
  return [...tasks, ...executions, ...(reason ? [{ kind: "reserved" as const, taskId: null, title: reason, status: "reserved" }] : [])];
}

/** Tasks waiting in `ws`'s line, in the order they were sent. A task being cancelled has left it. */
export function lineFor(ws: WorkspaceId): TaskRow[] {
  return all<TaskRow>(
    `SELECT * FROM tasks
      WHERE route = ? AND status = 'in_line' AND COALESCE(json_extract(context_json, '$.cancelRequested'), 0) = 0
      ORDER BY created_at, rowid`,
    [ws],
  );
}

/**
 * Admits the first task in `ws`'s line if `ws` is free: it becomes `planning`, with `admitted_at`
 * set. Returns it, or null when the workspace is busy or nobody is waiting. Synchronous on purpose.
 */
export function admitNext(ws: WorkspaceId): TaskRow | null {
  const next = lineFor(ws)[0];
  if (!next || workspaceHolders(ws, next.id).length) return null;
  updateTask(next.id, { status: "planning", stage: "plan", admitted_at: nowIso() });
  return getTask(next.id) ?? null;
}

/** Where a waiting task stands, or null if it is not in line. */
export function lineInfo(taskId: string): LineInfo | null {
  const t = getTask(taskId);
  if (!t || t.status !== "in_line" || (t.route !== "One" && t.route !== "Studio")) return null;
  const ws: WorkspaceId = t.route;
  const line = lineFor(ws);
  const i = line.findIndex((x) => x.id === t.id);
  if (i < 0) return null;
  const heldBy = workspaceHolders(ws, t.id);
  const prev = i > 0 ? line[i - 1] : null;
  const first = heldBy[0];
  const ahead = prev ? { taskId: prev.id, title: prev.title, status: prev.status } : first ? { taskId: first.taskId, title: first.title, status: first.status } : null;
  return { workspace: ws, position: i + 1, ordinal: ordinal(i + 1), ahead, heldBy };
}

export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}
