// Labels (spec 7.1): what really happened, read from HQ's own records once a task ends. Only tasks an
// executor actually ran are labelled, and a record is labelled once.
//
// "What the executor did" excludes the planning session's own gateway reads (a preview/execute
// execution is required, and usage is joined to the phase that made the call), matches
// telemetry.ts's USAGE_WHERE for what counts as a real platform call (reads and *approved* writes,
// never a dry-run/mock preview row), and stops short of guessing at a One Flow's actions, since those
// run inside the One CLI and never reach the gateway's connection_usage table at all.
import { all, get, parseJson } from "../db";
import { emit } from "../events";
import { GATES } from "./config";
import { setLabel, taskRecords } from "./records";
import { retune } from "./tuner";
import type { GateKey } from "./types";

/** Real platform calls only (telemetry.ts USAGE_WHERE), and only from a phase the executor itself ran
 * in — a planning session's own reads (phase 'plan') are not the executor's usage. */
const EXECUTOR_USAGE_SQL = `
  SELECT cu.platform AS platform, cu.connection_name AS connection_name
  FROM connection_usage cu
  JOIN executions e ON e.id = cu.execution_id
  WHERE cu.task_id = ? AND cu.connection_key IS NOT NULL AND cu.category IN ('read', 'write')
    AND cu.decision IN ('allowed', 'approved') AND e.phase IN ('preview', 'execute')
`;

export interface Observed {
  executed: boolean;
  verified: boolean;
  usedPlatforms: Set<string>;
  usedConnections: Set<string>;
  sideEffectsProposed: boolean;
  fastPathTaken: boolean;
  fastPathBounced: boolean;
  interrupted: boolean;
  reused: boolean;
  /** The earlier task this one's plan was reused from, when the task actually reused one (from
   * context.memory.match.taskId, or parsed off planner_model when that's the only copy of it left). */
  reusedTaskId: string | null;
  /** A flow build, or a task routed to run a named flow: its platform calls run inside the One CLI, out
   * of the gateway's sight, so connection-usage gates cannot be graded from what HQ happened to see. */
  flowTask: boolean;
  planSig: string | null;
}

export function planSignature(planJson: string | null): string | null {
  const p = parseJson<{ steps?: Array<{ connection_key?: string; action_id?: string }> } | null>(planJson, null);
  const steps = (p?.steps ?? []).filter((s) => s.action_id);
  return steps.length ? [...new Set(steps.map((s) => `${s.connection_key ?? ""}|${s.action_id}`))].sort().join(",") : null;
}

/** stagePlan (orchestrator.ts) sets planner_model to `reused from ${match.taskId ?? match.file} (...)`
 * and, in the same step, writes context.memory.match — the structured form is the reliable one. */
function reusedTaskId(plannerModel: string | null, contextJson: string | null): string | null {
  const ctx = parseJson<{ memory?: { match?: { taskId?: string | null } | null } | null }>(contextJson, {});
  if (ctx.memory?.match?.taskId) return ctx.memory.match.taskId;
  const m = plannerModel?.match(/^reused from (\S+) \(/);
  return m ? m[1] : null;
}

export function observe(taskId: string): Observed | null {
  const t = get<{ status: string; verification: string | null; plan_json: string | null; planner_model: string | null; context_json: string | null }>("SELECT status, verification, plan_json, planner_model, context_json FROM tasks WHERE id = ?", [taskId]);
  if (!t) return null;
  const ctx = parseJson<{ fastPathBounced?: boolean; previewResult?: { proposed_actions?: unknown[] } | null; buildFlow?: boolean; flow?: unknown }>(t.context_json, {});
  // Only a preview or execute execution is the executor actually running — a plan-only task (still
  // planning, or one that never got past planning) was never executed. dispatch.ts inserts the row
  // (status 'starting') before the launch is verified, so an execution whose launch never verified
  // (`verified = 0`, still the column's default) is not "ran" either: a launch fault leaves empty
  // usage, which is not evidence of anything the executor decided not to do.
  const ran = !!get("SELECT 1 AS x FROM executions WHERE task_id = ? AND phase IN ('preview', 'execute') AND verified = 1 LIMIT 1", [taskId]);
  const use = ran ? all<{ platform: string | null; connection_name: string | null }>(EXECUTOR_USAGE_SQL, [taskId]) : [];
  const executed = ["completed", "unverified", "failed", "blocked"].includes(t.status) && ran;
  return {
    executed,
    verified: t.verification === "verified",
    usedPlatforms: new Set(use.map((u) => u.platform).filter((x): x is string => !!x)),
    usedConnections: new Set(use.map((u) => u.connection_name).filter((x): x is string => !!x)),
    sideEffectsProposed: (ctx.previewResult?.proposed_actions?.length ?? 0) > 0 || !!get("SELECT 1 AS x FROM approvals WHERE task_id = ? LIMIT 1", [taskId]),
    fastPathTaken: !!t.planner_model?.startsWith("none (fast path"),
    fastPathBounced: !!ctx.fastPathBounced,
    interrupted: !!get("SELECT 1 AS x FROM events WHERE task_id = ? AND type = 'task_interrupted' LIMIT 1", [taskId]),
    reused: !!t.planner_model?.startsWith("reused from "),
    reusedTaskId: reusedTaskId(t.planner_model, t.context_json),
    flowTask: !!ctx.buildFlow || !!ctx.flow,
    planSig: planSignature(t.plan_json),
  };
}

export function labelTask(taskId: string): { labelled: number; gates: GateKey[] } {
  const o = observe(taskId);
  if (!o || !o.executed) return { labelled: 0, gates: [] };
  let n = 0;
  const gates = new Set<GateKey>();
  const put = (id: number, gate: GateKey, label: boolean, source: string) => {
    setLabel(id, label ? 1 : 0, source);
    n++;
    gates.add(gate);
  };
  for (const r of taskRecords(taskId)) {
    if (r.label !== null) continue;
    switch (r.gate) {
      case "understand.uses":
        // A flow's own actions never reach connection_usage (spec §7.1's flow-blindness), so a
        // flow task's "used" predictions are left unlabelled rather than graded as unused.
        // "add": Jev said needed where the keywords did not; "remove": the reverse. ("used"/"not_used"
        // are rows from before disagreement-only recording; still labelled, never tuned on.)
        if (!o.flowTask) put(r.id, r.gate, (r.predicted === "add" || r.predicted === "used") === o.usedPlatforms.has(r.subject ?? ""), "connection_usage");
        break;
      case "understand.mail_role":
        if (!o.flowTask && r.predicted !== "other") put(r.id, r.gate, (r.predicted === "operate_mailbox") === o.usedPlatforms.has("gmail"), "connection_usage");
        break;
      case "trim.connection":
        if (!o.flowTask) put(r.id, r.gate, !o.usedConnections.has(r.subject ?? ""), "connection_usage");
        break;
      case "fastpath":
        if (o.fastPathTaken || o.fastPathBounced) put(r.id, r.gate, o.fastPathTaken && o.verified && !o.fastPathBounced && !o.interrupted, "fast path outcome");
        else put(r.id, r.gate, o.verified && o.usedConnections.size <= 1 && !o.sideEffectsProposed && !o.interrupted, "planned task outcome");
        break;
      case "repeat.same_as": {
        if (o.reused) {
          // The task's own plan is a verbatim copy of the reused candidate's plan, so only that
          // candidate is gradeable by outcome — comparing the *other* candidates' plans against it
          // would just be asking whether they match the winner, not whether they were the same
          // request, so they are left unlabelled instead of guessed at.
          if (o.reusedTaskId && r.subject === o.reusedTaskId) put(r.id, r.gate, o.verified && !o.interrupted, "reused plan outcome");
          break;
        }
        const cand = r.subject ? get<{ plan_json: string | null }>("SELECT plan_json FROM tasks WHERE id = ?", [r.subject]) : undefined;
        const theirs = planSignature(cand?.plan_json ?? null);
        if (theirs && o.planSig) put(r.id, r.gate, theirs === o.planSig, "plan comparison");
        break;
      }
    }
  }
  return { labelled: n, gates: [...gates] };
}

/** Called when a task ends. Never throws: labelling must not break close-out. */
export function labelAndRetune(taskId: string): void {
  try {
    const r = labelTask(taskId);
    for (const g of r.gates) if (GATES.includes(g)) retune(g);
  } catch (e) {
    try {
      emit({ taskId, system: "orchestrator", type: "judge_label_failed", level: "warning", visibility: "details", summary: `Labelling failed: ${e instanceof Error ? e.message : String(e)}` });
    } catch {
      /* telemetry only */
    }
  }
}
