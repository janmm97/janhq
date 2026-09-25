// Side-effect approvals. A preview execution proposes actions; HQ validates each one (live connection,
// parseable payload, a dry-run HQ ran itself) and asks the operator. An approved action is released to
// the EXECUTE phase and can be claimed exactly once, atomically, with a payload hash that must match.
// A decision comes from the operator, or — for a task sent in Auto mode — from HQ acting on the
// operator's standing instruction (2026-09-23: "if it's set to auto it doesn't need my approval").
// Either way only a fully validated approval can be approved, and the payload hash still binds.
import { all, get, json, parseJson, run, tx } from "./db";
import { emit } from "./events";
import { newId } from "./util/ids";
import { nowIso } from "./util/time";
import { recordApprovedWrite } from "./telemetry";
import type { ApprovedAction } from "./dispatch";
import type { WorkspaceId } from "./env";

export interface ApprovalAction {
  index: number;
  kind: "one_action" | "one_flow";
  title: string;
  platform: string;
  actionId: string | null;
  connectionKey: string | null;
  connectionName: string | null;
  method: string | null;
  target: string | null;
  data: unknown;
  pathVars: unknown;
  queryParams: unknown;
  flowKey: string | null;
  flowInputs: Record<string, unknown> | null;
  sideEffect: string;
  idempotent: boolean;
  expectedCalls: number;
  estimatedCost: string;
  payloadHash: string;
  dryRun: { ok: boolean; method: string | null; url: string | null; detail: string | null } | null;
  executorDryRunMatched: boolean;
  problems: string[];
}

export interface ApprovalRecord {
  id: string;
  taskId: string;
  executionId: string | null;
  status: "pending" | "approved" | "rejected" | "superseded";
  summary: string;
  actions: ApprovalAction[];
  states: Array<{ index: number; state: string; outcome: unknown }>;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

interface ApprovalRow {
  id: string;
  task_id: string;
  execution_id: string | null;
  status: string;
  actions_json: string;
  summary: string;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

function toRecord(r: ApprovalRow): ApprovalRecord {
  const states = all<{ idx: number; state: string; outcome_json: string | null }>("SELECT idx, state, outcome_json FROM approval_actions WHERE approval_id = ? ORDER BY idx", [r.id]);
  return {
    id: r.id,
    taskId: r.task_id,
    executionId: r.execution_id,
    status: r.status as ApprovalRecord["status"],
    summary: r.summary,
    actions: parseJson<ApprovalAction[]>(r.actions_json, []),
    states: states.map((s) => ({ index: s.idx, state: s.state, outcome: parseJson(s.outcome_json, null) })),
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolutionNote: r.resolution_note,
  };
}

export function createApproval(taskId: string, executionId: string | null, actions: ApprovalAction[], summary: string, system: WorkspaceId): ApprovalRecord {
  const id = newId("apr");
  tx(() => {
    run("UPDATE approvals SET status = 'superseded', resolved_at = ? WHERE task_id = ? AND status = 'pending'", [nowIso(), taskId]);
    run("INSERT INTO approvals(id, task_id, execution_id, status, actions_json, summary, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)", [id, taskId, executionId, json(actions), summary, nowIso()]);
    for (const a of actions) {
      run("INSERT INTO approval_actions(approval_id, idx, payload_hash, state) VALUES (?, ?, ?, 'pending')", [id, a.index, a.payloadHash]);
    }
  });
  const rec = getApproval(id)!;
  emit({
    taskId,
    executionId,
    system,
    type: "approval_required",
    level: "warning",
    visibility: "chat",
    summary: `Approval required: ${summary}`,
    data: { approvalId: id, count: actions.length },
  });
  return rec;
}

export function getApproval(id: string): ApprovalRecord | null {
  const r = get<ApprovalRow>("SELECT * FROM approvals WHERE id = ?", [id]);
  return r ? toRecord(r) : null;
}

export function approvalsForTask(taskId: string): ApprovalRecord[] {
  return all<ApprovalRow>("SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at", [taskId]).map(toRecord);
}

export function pendingApprovals(): ApprovalRecord[] {
  return all<ApprovalRow>("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at").map(toRecord);
}

export function resolveApproval(id: string, decision: "approved" | "rejected", note: string | null, by: "operator" | "auto" = "operator"): ApprovalRecord {
  const rec = getApproval(id);
  if (!rec) throw new Error("Approval not found");
  if (rec.status !== "pending") throw new Error(`Approval is already ${rec.status}`);
  if (decision === "approved" && rec.actions.some((a) => a.problems.length > 0)) {
    throw new Error("This approval has unresolved validation problems and cannot be approved; reject it instead.");
  }
  tx(() => {
    run("UPDATE approvals SET status = ?, resolved_at = ?, resolution_note = ? WHERE id = ? AND status = 'pending'", [decision, nowIso(), note, id]);
    run("UPDATE approval_actions SET state = ? WHERE approval_id = ?", [decision === "approved" ? "ready" : "skipped", id]);
  });
  const updated = getApproval(id)!;
  emit({
    taskId: rec.taskId,
    system: "orchestrator",
    type: "approval_resolved",
    level: decision === "approved" ? "success" : "warning",
    visibility: "chat",
    summary:
      decision === "approved"
        ? `${by === "auto" ? "Auto mode approved" : "Operator approved"} ${rec.actions.length} action(s)`
        : `Operator rejected the proposed action(s)${note ? `: ${note}` : ""}`,
    data: { approvalId: id, decision, note, by },
  });
  return updated;
}

/** The actions a phase-2 executor may run, exactly as approved. */
export function approvedActionsFor(id: string): ApprovedAction[] {
  const rec = getApproval(id);
  if (!rec || rec.status !== "approved") return [];
  return rec.actions.map((a) => ({
    index: a.index,
    approvalId: id,
    kind: a.kind,
    title: a.title,
    platform: a.platform,
    actionId: a.actionId,
    connectionKey: a.connectionKey,
    connectionName: a.connectionName,
    target: a.target,
    data: a.data,
    pathVars: a.pathVars,
    queryParams: a.queryParams,
    flowKey: a.flowKey,
    flowInputs: a.flowInputs,
    payloadHash: a.payloadHash,
  }));
}

/** Atomic claim: only a `ready` action of an approved approval belonging to this task, once. */
export function claimApprovedAction(input: { approvalId: string; index: number; payloadHash: string; taskId: string }): { ok: true } | { ok: false; error: string } {
  return tx(() => {
    const ap = get<{ status: string; task_id: string }>("SELECT status, task_id FROM approvals WHERE id = ?", [input.approvalId]);
    if (!ap || ap.task_id !== input.taskId) return { ok: false as const, error: "approval does not belong to this task" };
    if (ap.status !== "approved") return { ok: false as const, error: `approval is ${ap.status}` };
    const row = get<{ state: string; payload_hash: string }>("SELECT state, payload_hash FROM approval_actions WHERE approval_id = ? AND idx = ?", [input.approvalId, input.index]);
    if (!row) return { ok: false as const, error: "no such approved action" };
    if (row.payload_hash !== input.payloadHash) return { ok: false as const, error: "payload does not match what was approved" };
    if (row.state !== "ready") return { ok: false as const, error: `action already ${row.state}; it will not run again` };
    run("UPDATE approval_actions SET state = 'executing', claimed_at = ? WHERE approval_id = ? AND idx = ? AND state = 'ready'", [nowIso(), input.approvalId, input.index]);
    return { ok: true as const };
  });
}

export function recordActionOutcome(input: {
  approvalId: string;
  index: number;
  outcome: "succeeded" | "failed" | "ambiguous" | "blocked";
  summary: string;
  responseIds?: string[];
  durationMs?: number;
  executionId: string | null;
  workspace: WorkspaceId;
}) {
  const rec = getApproval(input.approvalId);
  if (!rec) return;
  const action = rec.actions.find((a) => a.index === input.index);
  run("UPDATE approval_actions SET state = ?, finished_at = ?, outcome_json = ? WHERE approval_id = ? AND idx = ?", [
    input.outcome,
    nowIso(),
    json({ summary: input.summary, responseIds: input.responseIds ?? [], durationMs: input.durationMs ?? null }),
    input.approvalId,
    input.index,
  ]);
  if (action && input.outcome !== "blocked") {
    recordApprovedWrite({
      executionId: input.executionId,
      taskId: rec.taskId,
      workspace: input.workspace,
      platform: action.platform,
      connectionKey: action.connectionKey,
      connectionName: action.connectionName,
      actionId: action.actionId,
      ok: input.outcome === "succeeded",
      durationMs: input.durationMs,
      reason: input.summary,
    });
  }
  emit({
    taskId: rec.taskId,
    executionId: input.executionId,
    system: input.workspace,
    type: input.outcome === "succeeded" ? "approved_action_succeeded" : "approved_action_" + input.outcome,
    level: input.outcome === "succeeded" ? "success" : input.outcome === "ambiguous" ? "warning" : "error",
    visibility: "chat",
    summary: `${action?.title ?? `Action #${input.index}`}: ${input.outcome}${input.summary ? ` — ${input.summary}` : ""}`,
    data: input,
  });
}
