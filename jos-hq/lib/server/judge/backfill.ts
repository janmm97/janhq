// Backfill (spec 7.4): replay HQ's finished tasks through D1, D2 and D3 in shadow (nothing acts), label
// them from their recorded outcomes, then retune. One request at a time; each task at most once per
// question version. D3 only sees log entries dated on or before the task.
import { all, get, parseJson } from "../db";
import type { WorkspaceId } from "../env";
import { findCandidates, logSources, readEntries } from "../memory";
import { listConnections } from "../one/discovery";
import { GATES } from "./config";
import { decideFastPath } from "./fastpath";
import { labelTask } from "./labels";
import { gateVersion } from "./questions";
import { judgeRepeat } from "./repeat";
import { retune } from "./tuner";
import { understand } from "./understand";

export interface BackfillStatus { state: "idle" | "running" | "done" | "failed"; tasks: number; labelled: number; skipped: number; error: string | null; at: string | null }
const g = globalThis as unknown as { __josBackfill?: BackfillStatus };

export function backfillStatus(): BackfillStatus {
  return g.__josBackfill ?? { state: "idle", tasks: 0, labelled: 0, skipped: 0, error: null, at: null };
}

export async function backfill(o: { limit?: number } = {}): Promise<BackfillStatus> {
  const s: BackfillStatus = (g.__josBackfill = { state: "running", tasks: 0, labelled: 0, skipped: 0, error: null, at: new Date().toISOString() });
  try {
    const rows = all<{ id: string; request: string; route: WorkspaceId; created_at: string; context_json: string | null }>(
      "SELECT id, request, route, created_at, context_json FROM tasks WHERE route IN ('One', 'Studio') AND status IN ('completed', 'unverified', 'failed', 'blocked') AND origin IN ('chat', 'cli') ORDER BY created_at",
    );
    const conns = { One: (await listConnections("One")).connections, "Studio": (await listConnections("Studio")).connections };
    const v = gateVersion("understand.mail_role");
    for (const t of rows.slice(0, o.limit ?? rows.length)) {
      // A single task's failure (a throw from `understand`, a malformed log entry, …) must not abort
      // the run for every task after it — isolate it, count it as skipped, and keep the first error
      // for visibility without flipping the overall run to "failed".
      try {
        const ctx = parseJson<{ agent?: unknown; flow?: unknown; orchestratorBrief?: unknown; conversation?: { text?: string } | null }>(t.context_json, {});
        if (ctx.agent || ctx.flow || ctx.orchestratorBrief || get("SELECT 1 AS x FROM judge_records WHERE task_id = ? AND gate = 'understand.mail_role' AND version = ? LIMIT 1", [t.id, v])) {
          s.skipped++;
          continue;
        }
        const u = await understand({ taskId: t.id, request: t.request, conversation: ctx.conversation?.text ?? null, conns });
        if (!u) {
          s.skipped++;
          continue;
        }
        decideFastPath({ taskId: t.id, u, request: t.request, conns: conns[t.route] ?? [], excluded: "backfill (shadow)" });
        const day = t.created_at.slice(0, 10);
        const entries = readEntries(logSources(t.route, null)).filter((e) => e.taskId !== t.id && (e.date ?? "") <= day);
        const cands = findCandidates(t.request, entries, t.id);
        if (cands.length) await judgeRepeat({ taskId: t.id, request: t.request, candidates: cands });
        s.labelled += labelTask(t.id).labelled;
        s.tasks++;
      } catch (e) {
        s.skipped++;
        if (!s.error) s.error = e instanceof Error ? e.message : String(e);
      }
    }
    for (const gk of GATES) retune(gk);
    s.state = "done";
  } catch (e) {
    s.state = "failed";
    s.error = e instanceof Error ? e.message : String(e);
  }
  return s;
}

/** Starts a backfill in the background; a second start while one runs returns the running status. */
export function startBackfill(): BackfillStatus {
  if (backfillStatus().state === "running") return backfillStatus();
  void backfill();
  return backfillStatus();
}
