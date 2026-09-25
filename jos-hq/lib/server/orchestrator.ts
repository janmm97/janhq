// The Orchestrator pipeline (CLAUDE.md golden path) as code:
//   understand -> route -> open log -> discover -> line -> log check -> PLAN session -> check plan -> executor prompt
//   -> PREVIEW dispatch -> [approval gate; Auto mode approves validated actions itself]
//   -> EXECUTE dispatch -> verify -> close log -> respond
// Each task is advanced by a single in-process driver; it pauses (never blocks a request) on
// clarifications and approvals and resumes when the operator answers. Execution belongs to the
// executor; HQ itself only reads, plans, instructs, gates and evaluates.
import path from "node:path";
import { josRoot, loadConfig, logFileFor, workspaceRoot, type WorkspaceId } from "./env";
import { all, get, parseJson, run } from "./db";
import { emit } from "./events";
import { logTimestamp, nowIso } from "./util/time";
import { containsSecret, redactDeep, redactSecrets } from "./util/redact";
import { routeRequest, mailboxQuestion, detectEntities, impliedPlatforms, continuesConversation, type RouteSelection } from "./routing";
import { conversationContext } from "./conversation";
import { listConnections, listFlows, rememberFlows, type ConnectionInfo, type FlowInfo } from "./one/discovery";
import { runOneReadOnly } from "./one/cli";
import { verifyIdentity } from "./identity";
import { buildPlannerPrompt, checkPlan, isV2Plan, knowledgeCallsFor } from "./planning";
import { agentHistory, decide, findMatches, logSources, readEntries, renderEntry, renderLessons } from "./memory";
import { isAgentLogFile, resolveScope } from "./agent-files";
import type { PlannerResult } from "./executors/plan-schema";
import { buildExecutorPrompt } from "./prompt";
import { assertRuntimeReady, dispatch, cancelExecution, isExecutionLive, phasePolicy, settleDeadOrphans, DispatchError, type ExecutionOutcome } from "./dispatch";
import { createApproval, getApproval, approvedActionsFor, resolveApproval, type ApprovalAction } from "./approvals";
import { openLogEntry, closeLogEntry, appendLogNote, type LogStatus } from "./logs";
import { ensureAgentLog, findAgent, recordAgentTaskResult, recordAgentUserMessage } from "./agents";
import { recordWorkflowRunResult } from "./workflows";
import { chatBuildsFlow, checkFlowBuild } from "./flowbuild";
import { flowScopeProblems } from "./flow-scope";
import { admitNext, lineInfo, type LineInfo } from "./queue";
import {
  addMessage,
  createTaskRow,
  getTask,
  lifecycleEvent,
  patchContext,
  setStage,
  taskContext,
  titleFrom,
  updateTask,
  renameChat,
  type ConversationContext,
  type Stage,
  type TaskContext,
  type TaskRow,
  type TaskStatus,
} from "./tasks";
import type { ExecutorResult, TaskMode } from "./executors/types";
import { actionPayloadHash, emptyToNull, tryParseJson } from "../../gateway/lib/canonical.mjs";
import { classifyRequest } from "../../gateway/lib/classify.mjs";

const driving = new Set<string>();
/** Asked to drive while already driving (a kick admitted it mid-pass): run once more when this pass ends. */
const redrive = new Set<string>();

function sys(t: TaskRow): "orchestrator" | WorkspaceId {
  return t.route === "One" || t.route === "Studio" ? t.route : "orchestrator";
}

// ------------------------------------------------------------------------------------------------
// Entry points

export interface SubmitInput {
  chatId: string | null;
  text: string;
  routeSelection: RouteSelection;
  mode: TaskMode;
  attachmentIds?: string[];
  origin?: "chat" | "cli" | "workflow" | "agent";
  agent?: { workspace: WorkspaceId; name: string } | null;
  flow?: { workspace: WorkspaceId; key: string } | null;
  orchestratorBrief?: string | null;
  title?: string;
  /** What the chat shows as the operator's message (defaults to text). */
  displayText?: string;
  messageData?: Record<string, unknown>;
  /** Earlier context supplied by the caller (an agent chat); a main chat's is derived from the chat itself. */
  conversation?: ConversationContext | null;
}

export function submitTask(input: SubmitInput): TaskRow {
  // Only this chat's own, not-yet-used uploads can be attached to the task.
  const requested = [...new Set(input.attachmentIds ?? [])];
  const attachmentIds = requested.length
    ? all<{ id: string }>(
        `SELECT id FROM attachments WHERE id IN (${requested.map(() => "?").join(",")}) AND task_id IS NULL AND chat_id IS ?`,
        [...requested, input.chatId],
      ).map((r) => r.id)
    : [];
  // Captured before the new row exists, so the history is exactly the tasks that came before it.
  const conversation = input.conversation !== undefined ? input.conversation : (input.origin ?? "chat") === "chat" ? conversationContext(input.chatId, null) : null;
  const t = createTaskRow({
    chatId: input.chatId,
    origin: input.origin ?? "chat",
    request: input.text,
    mode: input.mode,
    routeSelection: input.routeSelection,
    title: input.title,
    context: {
      clarifications: [],
      attachmentIds,
      agent: input.agent ?? null,
      flow: input.flow ?? null,
      orchestratorBrief: input.orchestratorBrief ?? null,
      conversation,
      buildFlow: (input.origin ?? "chat") === "chat" && chatBuildsFlow(input.chatId),
    },
  });
  for (const id of attachmentIds) run("UPDATE attachments SET task_id = ? WHERE id = ? AND task_id IS NULL", [t.id, id]);
  if (input.chatId) {
    const chat = get<{ title: string }>("SELECT title FROM chats WHERE id = ?", [input.chatId]);
    if (chat && chat.title === "Untitled") renameChat(input.chatId, titleFrom(input.displayText ?? input.text));
    // The operator's message is recorded before the driver can post anything.
    addMessage(input.chatId, "user", "text", input.displayText ?? input.text, t.id, { route: input.routeSelection, mode: input.mode, attachmentIds, ...(input.messageData ?? {}) });
  }
  lifecycleEvent(t.id, "task_created", `Task created: ${t.title}`, "info", { mode: t.mode, routeSelection: t.route_selection, origin: t.origin });
  void drive(t.id);
  return t;
}

/** Run a Plan-mode task's plan: a new task (its own log entry) on the same route, reusing the plan. */
export function executePlan(planTaskId: string, mode: TaskMode): TaskRow {
  const src = getTask(planTaskId);
  if (!src || src.status !== "planned" || (src.route !== "One" && src.route !== "Studio")) throw new Error("Only a planned task with a One or Studio route can be executed");
  if (mode === "plan") throw new Error("Choose Manual, Edit automatically or Auto to execute a plan");
  const srcCtx = taskContext(src);
  // An agent's plan runs as that agent: its SOP, its connection scope and its LOGS.md come along.
  const t = createTaskRow({
    chatId: src.chat_id,
    origin: srcCtx.agent ? "agent" : "chat",
    request: src.request,
    mode,
    routeSelection: src.route,
    title: src.title,
    context: {
      clarifications: srcCtx.clarifications,
      attachmentIds: srcCtx.attachmentIds ?? [],
      mailbox: srcCtx.mailbox ?? null,
      reusePlanFrom: src.id,
      conversation: srcCtx.conversation ?? null,
      buildFlow: srcCtx.buildFlow ?? false,
      agent: srcCtx.agent ?? null,
      agentConversationId: srcCtx.agentConversationId ?? null,
    },
  });
  addMessage(src.chat_id, "user", "text", `Execute the plan (${mode})`, t.id, { executePlanOf: src.id });
  if (srcCtx.agentConversationId) recordAgentUserMessage(srcCtx.agentConversationId, `Execute the plan (${mode})`, t.id);
  lifecycleEvent(t.id, "task_created", `Task created to execute plan ${src.id}`, "info");
  void drive(t.id);
  return t;
}

export async function answerClarification(taskId: string, answer: string): Promise<void> {
  const t = getTask(taskId);
  if (!t) throw new Error("Task not found");
  if (t.status !== "needs_clarification") throw new Error(`Task is ${t.status}, not waiting for an answer`);
  const ctx = taskContext(t);
  const q = ctx.pendingQuestion;
  if (!q) throw new Error("No pending question on this task");
  const clean = redactSecrets(answer).trim().slice(0, 2000);
  if (!clean) throw new Error("Answer is empty");
  addMessage(t.chat_id, "user", "text", clean, t.id, { answers: q.question });
  ctx.clarifications.push({ kind: q.kind, question: q.question, answer: clean });
  ctx.pendingQuestion = null;
  const patch: Partial<TaskRow> & { context: TaskContext } = { context: ctx };
  if (q.kind === "route") {
    const choice = q.options.find((o) => o.value.toLowerCase() === clean.toLowerCase() || o.label.toLowerCase() === clean.toLowerCase());
    const v = choice?.value ?? (/^Studio\b/.test(clean) ? "Studio" : /^one\b/i.test(clean) ? "One" : /^(neither|none|orchestrator)/i.test(clean) ? "none" : null);
    if (!v) {
      ctx.clarifications.pop();
      ctx.pendingQuestion = q;
      updateTask(t.id, { context: ctx });
      addMessage(t.chat_id, "assistant", "clarify", `Please choose ${q.options.map((o) => o.label).join(", ")}.`, t.id, { question: q.question, options: q.options, kind: q.kind });
      return;
    }
    patch.route = v as TaskRow["route"];
    patch.route_reason = `Operator clarified: ${v === "none" ? "Orchestrator only" : v} (${t.route_reason ?? "routing asked"})`;
    patch.status = "routing";
  } else if (q.kind === "mailbox") {
    ctx.mailbox = clean;
    // A mailbox is asked during discovery, before the line, so the answer joins the line.
    Object.assign(patch, afterDiscovery(t.mode));
  } else if (q.kind === "planner") {
    // The planner asked about intent. Its plan stands; the answer travels to the executor with it.
    if (t.mode === "plan") {
      updateTask(t.id, patch);
      if (t.log_file && t.log_opened_at) await safeNote(t, "Clarified", `${q.question} → ${clean}`);
      await finish(getTask(t.id)!, {
        status: "planned",
        logStatus: "done",
        outcome: `Plan mode: planned, and the operator answered the planner's question (${clean}); nothing was executed by design.`,
        answer: "Plan ready with your answer. Nothing was executed (Plan mode). Use “Execute this plan” to run it.",
        verification: "none",
      });
      return;
    }
    patch.status = "dispatching";
    patch.stage = "prompt";
  } else {
    // The executor asked about intent during PREVIEW: re-run PREVIEW with the answer in context.
    patch.status = "dispatching";
    patch.stage = "prompt";
  }
  updateTask(t.id, patch);
  if (t.log_file && t.log_opened_at) await safeNote(t, "Clarified", `${q.question} → ${clean}`);
  void drive(t.id);
}

export async function approveTask(approvalId: string, note: string | null): Promise<void> {
  const ap = getApproval(approvalId);
  if (!ap) throw new Error("Approval not found");
  resolveApproval(approvalId, "approved", note);
  const t = getTask(ap.taskId);
  if (!t) return;
  addMessage(t.chat_id, "system", "approval_resolved", "Approved", t.id, { approvalId, decision: "approved" });
  updateTask(t.id, { status: "dispatching", stage: "execute" });
  await safeNote(t, "Approved", `operator approved ${ap.actions.length} action(s): ${ap.actions.map((a) => a.title).join("; ")}`);
  void drive(t.id);
}

export async function rejectTask(approvalId: string, note: string | null): Promise<void> {
  const ap = getApproval(approvalId);
  if (!ap) throw new Error("Approval not found");
  resolveApproval(approvalId, "rejected", note);
  const t = getTask(ap.taskId);
  if (!t) return;
  addMessage(t.chat_id, "system", "approval_resolved", `Rejected${note ? `: ${note}` : ""}`, t.id, { approvalId, decision: "rejected" });
  await finish(t, {
    status: "rejected",
    logStatus: "abandoned",
    outcome: `Operator rejected the proposed action(s) (${ap.actions.map((a) => a.title).join("; ")})${note ? `: ${note}` : ""}. Nothing outward-facing was executed.`,
    answer: "Rejected. Nothing was sent, published, deleted or charged.",
    verification: "none",
  });
}

export async function cancelTask(taskId: string, force: boolean): Promise<{ ok: boolean; detail: string }> {
  const t = getTask(taskId);
  if (!t) throw new Error("Task not found");
  if (["completed", "unverified", "planned", "failed", "blocked", "cancelled", "rejected", "closed"].includes(t.status)) {
    return { ok: false, detail: `Task already ${t.status}` };
  }
  const ctx = taskContext(t);
  const execId = [ctx.executeExecutionId, ctx.previewExecutionId, ctx.planExecutionId].find((id) => id && isExecutionLive(id)) ?? null;
  if (execId && execId === ctx.executeExecutionId && ctx.approvalId) {
    const inFlight = (getApproval(ctx.approvalId)?.states ?? []).filter((s) => s.state === "executing");
    if (inFlight.length && !force) {
      return { ok: false, detail: "An approved action is executing right now. Stopping may leave it half-done with an unknown outcome. Confirm to stop anyway." };
    }
  }
  patchContext(taskId, (c) => ({ ...c, cancelRequested: true }));
  lifecycleEvent(taskId, "task_cancel_requested", "Cancellation requested by operator", "warning");
  if (execId) {
    const r = await cancelExecution(execId, force ? "operator stop (forced)" : "operator stop");
    return { ok: r.ok, detail: r.detail };
  }
  // Not executing: stop wherever the task is waiting.
  const fresh = getTask(taskId)!;
  if (fresh.status === "awaiting_approval" && ctx.approvalId) {
    try {
      resolveApproval(ctx.approvalId, "rejected", "task cancelled");
    } catch {
      /* already resolved */
    }
  }
  if (!driving.has(taskId)) await finishCancelled(fresh, "before execution started");
  return { ok: true, detail: "cancelled" };
}

/** Operator reconciliation for interrupted / needs_reconciliation tasks. */
export async function reconcileTask(taskId: string, logStatus: LogStatus, note: string): Promise<void> {
  const t = getTask(taskId);
  if (!t) throw new Error("Task not found");
  if (!["interrupted", "needs_reconciliation"].includes(t.status)) throw new Error(`Task is ${t.status}; only interrupted runs need reconciliation`);
  await finish(t, {
    status: logStatus === "done" ? "unverified" : logStatus === "abandoned" ? "cancelled" : logStatus === "blocked" ? "blocked" : "unverified",
    logStatus,
    outcome: `Reconciled by the operator after an interrupted run: ${note}`,
    answer: `Reconciled: ${note}`,
    verification: "failed",
    learned: "The run was interrupted (HQ restart or forced stop); its final state was established by the operator, not observed by HQ.",
  });
}

// ------------------------------------------------------------------------------------------------
// Driver

async function drive(taskId: string): Promise<void> {
  if (driving.has(taskId)) {
    redrive.add(taskId);
    return;
  }
  driving.add(taskId);
  try {
    for (let guard = 0; guard < 12; guard++) {
      const t = getTask(taskId);
      if (!t) return;
      if (taskContext(t).cancelRequested && !["completed", "unverified", "planned", "failed", "blocked", "cancelled", "rejected", "closed", "needs_reconciliation", "interrupted"].includes(t.status)) {
        await finishCancelled(t, `during ${t.stage}`);
        return;
      }
      const moved = await stepOnce(t);
      if (!moved) return;
    }
  } catch (e) {
    const t = getTask(taskId);
    if (t) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = e instanceof DispatchError ? e.code : "ORCHESTRATION_ERROR";
      await finish(t, {
        status: code === "IDENTITY_MISMATCH" || code === "RUNTIME_UNAVAILABLE" || code === "MODEL_UNVERIFIED" || code === "ONE_CLI_UNAVAILABLE" || code === "WORKSPACE_INVALID" || code === "AGENT_INVALID" ? "blocked" : "failed",
        logStatus: "blocked",
        outcome: `${codeLabel(code)}: ${msg}`,
        answer: `${codeLabel(code)}. ${msg}`,
        verification: "none",
      });
    }
  } finally {
    driving.delete(taskId);
    if (redrive.delete(taskId)) void drive(taskId);
  }
}

function codeLabel(code: string): string {
  const m: Record<string, string> = {
    IDENTITY_MISMATCH: "Identity mismatch — dispatch blocked",
    RUNTIME_UNAVAILABLE: "Dispatch blocked — no substitute runtime is used",
    MODEL_UNVERIFIED: "Executor model failed verification",
    ONE_CLI_UNAVAILABLE: "One CLI unavailable",
    WORKSPACE_INVALID: "Executor workspace invalid",
    LAUNCH_FAILED: "Executor failed before launch",
    INVALID_WORKSPACE: "Invalid executor workspace",
    EXECUTOR_ORIGIN: "Dispatch refused (executor origin)",
    AGENT_INVALID: "Sub-agent definition unusable",
    ORCHESTRATION_ERROR: "Orchestration error",
  };
  return m[code] ?? code;
}

/** Returns true when the task advanced and the driver should look again. */
async function stepOnce(t: TaskRow): Promise<boolean> {
  switch (t.status) {
    case "queued":
      return stageRoute(t);
    case "routing":
      return stageAfterRoute(t);
    case "discovering":
      return stageDiscover(t);
    case "in_line":
      return stageLine(t);
    case "planning":
      return stagePlan(t);
    case "dispatching":
      return t.stage === "execute" ? stageExecute(t) : stagePreview(t);
    default:
      return false;
  }
}

// ------------------------------------------------------------------------------------------------
// Stages

async function freshConnections(): Promise<Record<WorkspaceId, ConnectionInfo[] | null>> {
  const [a, b] = await Promise.all([listConnections("One"), listConnections("Studio")]);
  return { One: a.connections, "Studio": b.connections };
}
async function freshFlows(): Promise<Record<WorkspaceId, FlowInfo[] | null>> {
  const [a, b] = await Promise.all([listFlows("One"), listFlows("Studio")]);
  return { One: a.flows, "Studio": b.flows };
}

async function stageRoute(t: TaskRow): Promise<boolean> {
  setStage(t.id, "understand", "routing");
  const ent = detectEntities(t.request);
  const platforms = impliedPlatforms(t.request);
  emit({ taskId: t.id, system: "orchestrator", type: "understand", level: "info", visibility: "details", summary: `Understood: ${ent.one.length || ent.studio.length ? `entities ${[...ent.one, ...ent.studio].join(", ")}` : "no named entities"}${platforms.length ? `; platforms implied: ${platforms.join(", ")}` : ""}`, data: { entities: ent, platforms } });

  const ctx = taskContext(t);
  if (ctx.flow) {
    updateTask(t.id, { route: ctx.flow.workspace, route_reason: `Named flow: ${ctx.flow.key} (owned by ${ctx.flow.workspace}, from live flow discovery)`, stage: "route" });
    return announceRoute(getTask(t.id)!, { step: "flow", signals: [] });
  }
  if (ctx.agent) {
    // Fails the task before discovery when the agent or its SOP cannot be used.
    agentInstructions(ctx.agent.workspace, ctx.agent.name);
    updateTask(t.id, { route: ctx.agent.workspace, route_reason: `Sub-agent ${ctx.agent.name} belongs to ${ctx.agent.workspace}`, stage: "route" });
    return announceRoute(getTask(t.id)!, { step: "explicit", signals: [] });
  }

  setStage(t.id, "route");
  lifecycleEvent(t.id, "runtime_discovery_started", "Routing: checking explicit selection, named entities and flows, topic signals, then live connections", "info");
  const decision = await routeRequest({ text: t.request, selection: t.route_selection, flows: freshFlows, connections: freshConnections });
  updateTask(t.id, { route_evidence_json: JSON.stringify(decision) });
  const conv = ctx.conversation;
  if (continuesConversation(decision, conv?.route)) {
    updateTask(t.id, {
      route: conv!.route!,
      route_reason: `Continues this conversation: the earlier task "${conv!.lastTitle}" (${conv!.lastTaskId}) ran on ${conv!.route}, and this message names no business of its own`,
    });
    return announceRoute(getTask(t.id)!, { step: "conversation", signals: decision.signals, warnings: decision.warnings });
  }
  if (decision.kind === "clarify") {
    const ctx2 = taskContext(getTask(t.id)!);
    ctx2.pendingQuestion = { kind: "route", question: decision.question!, options: (decision.options ?? []).map((o) => ({ value: o.value, label: o.label })) };
    updateTask(t.id, { status: "needs_clarification", stage: "route", route_reason: decision.reason, context: ctx2 });
    emit({ taskId: t.id, system: "orchestrator", type: "route_decision", level: "warning", visibility: "chat", summary: `Needs clarification: ${decision.reason}`, data: decision });
    addMessage(t.chat_id, "assistant", "clarify", decision.question!, t.id, { kind: "route", reason: decision.reason, options: decision.options, signals: decision.signals, warnings: decision.warnings });
    return false;
  }
  updateTask(t.id, { route: decision.workspace!, route_reason: decision.reason });
  return announceRoute(getTask(t.id)!, decision);
}

async function announceRoute(t: TaskRow, decision: { step?: string; signals: unknown[]; warnings?: string[] }): Promise<boolean> {
  emit({ taskId: t.id, system: "orchestrator", type: "route_decision", level: "success", visibility: "chat", summary: `Routing decision: ${t.route} — ${t.route_reason}`, data: decision });
  addMessage(t.chat_id, "assistant", "route", `${t.route}`, t.id, { workspace: t.route, reason: t.route_reason, step: decision.step ?? null, signals: decision.signals, warnings: decision.warnings ?? [] });
  updateTask(t.id, { status: "routing" });
  return true;
}

async function stageAfterRoute(t: TaskRow): Promise<boolean> {
  // The destination is known: open the log entry before planning, delegating or touching a connection.
  if (t.route === "none") return orchestratorOnly(t);
  if (!t.route) return false;
  if (!t.log_opened_at) {
    setStage(t.id, "log");
    const file = logFileFor(t.route);
    const ctxA = taskContext(t);
    const conv = ctxA.conversation;
    const asked = conv && t.origin === "chat" ? `${t.request} (continues "${conv.lastTitle}", HQ task ${conv.lastTaskId})` : t.request;
    // An agent task is also logged in the agent's own LOGS.md; the two entries name each other.
    const agentDef = ctxA.agent ? findAgent(ctxA.agent.workspace, ctxA.agent.name) : null;
    const ensured = agentDef ? ensureAgentLog(agentDef) : null;
    const agentLog = ensured && isAgentLogFile(ensured.file) ? ensured.file : null;
    if (ensured?.recreated) lifecycleEvent(t.id, "agent_log_recreated", `${agentDef!.key}'s LOGS.md was missing, so HQ recreated it; the agent's earlier history is not in it`, "warning", { file: ensured.file });
    const opened = await openLogEntry({ taskId: t.id, file, title: t.title, asked, route: `${t.route} — ${t.route_reason}`, extra: agentLog ? [{ label: "Agent log", text: path.relative(josRoot(), agentLog).replace(/\\/g, "/") }] : undefined });
    updateTask(t.id, { log_file: opened.file, log_opened_at: nowIso() });
    lifecycleEvent(t.id, "log_opened", `Log entry opened in ${opened.file} (${opened.openedAt})`, "info", { file: opened.file, anchor: `<!-- jos:run=${t.id} -->` });
    if (agentLog) {
      try {
        await openLogEntry({ taskId: t.id, file: agentLog, title: t.title, asked: t.request, extra: [{ label: "Central log", text: opened.file }] });
        patchContext(t.id, (c) => ({ ...c, agentLog: { file: agentLog, closed: false } }));
        lifecycleEvent(t.id, "agent_log_opened", `Agent log entry opened in ${agentLog}`, "info");
      } catch (e) {
        lifecycleEvent(t.id, "log_update_failed", `Agent log update failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    }
  }
  updateTask(t.id, { status: "discovering" });
  return true;
}

async function orchestratorOnly(t: TaskRow): Promise<boolean> {
  const file = logFileFor("none");
  await openLogEntry({ taskId: t.id, file, title: t.title, asked: t.request, route: "none — the operator chose Orchestrator-only when routing asked" });
  updateTask(t.id, { log_file: file, log_opened_at: nowIso() });
  lifecycleEvent(t.id, "log_opened", `Log entry opened in ${file}`, "info");
  await finish(getTask(t.id)!, {
    status: "closed",
    logStatus: "abandoned",
    outcome: "Not executed: J/OS HQ delegates platform work to One or Studio only. Orchestrator-only work (instruction edits, repository questions) belongs in a root Claude Code or Codex session at JOS/.",
    answer: "J/OS HQ executes only through the One or Studio executors. Orchestrator-only work — editing instruction files or answering questions about the repository — belongs in a root session at JOS/. Nothing was executed.",
    verification: "none",
  });
  return false;
}

/** Where a task goes once discovery is done. Every mode waits in line: Plan mode now launches a planning session too. */
export function afterDiscovery(_mode: TaskMode): { status: TaskStatus; stage?: Stage } {
  return { status: "in_line", stage: "queue" };
}

async function stageDiscover(t: TaskRow): Promise<boolean> {
  const ws = t.route as WorkspaceId;
  setStage(t.id, "discover");
  lifecycleEvent(t.id, "runtime_discovery_started", `Discovering ${ws}: identity, connections, flows (live, from JOS/${ws})`, "info", undefined, ws);
  const [identity, conns, flows] = await Promise.all([verifyIdentity(ws), listConnections(ws), listFlows(ws)]);
  emit({
    taskId: t.id,
    system: ws,
    type: "runtime_discovery_complete",
    level: identity.ok ? "success" : "error",
    visibility: "details",
    summary: `${ws}: ${identity.ok ? "identity OK" : "identity MISMATCH"} · ${conns.connections?.length ?? "?"} connections · ${flows.flows?.length ?? "?"} flows`,
    data: { identity, connections: (conns.connections ?? []).map((c) => ({ platform: c.platform, name: c.name, state: c.state })), connectionsError: conns.error, flows: flows.flows, flowsError: flows.error },
  });
  patchContext(t.id, (c) => ({ ...c, identity: { projectRoot: identity.actual.projectRoot, email: identity.actual.email } }));
  if (!identity.ok) {
    throw new DispatchError("IDENTITY_MISMATCH", identity.problems.join("; "), { identity });
  }
  if (conns.connections === null) throw new DispatchError("ONE_CLI_UNAVAILABLE", `connection discovery failed for ${ws}: ${conns.error}`);
  // An agent task may use only its SOP's connections (spec 3.4). Unreadable or all-dead scope blocks here.
  const scope = agentScope(getTask(t.id)!, conns.connections);
  if (scope) {
    patchContext(t.id, (c) => ({ ...c, agentScope: scope }));
    if (scope.missing.length) lifecycleEvent(t.id, "agent_scope_partial", `Some of this agent's allowed connections are not live in ${ws}: ${scope.missing.join(", ")}. It runs with the others.`, "warning", scope, ws);
  }
  // The pinned executor runtime must be there before any planning is paid for. Plan mode never
  // launches an executor, so it may still plan, with the gap stated.
  try {
    await assertRuntimeReady(ws);
  } catch (e) {
    if (t.mode !== "plan") throw e;
    lifecycleEvent(t.id, "runtime_unavailable", `${e instanceof Error ? e.message : String(e)} — planning only; this plan cannot be executed until Runtime Health shows the runtime again.`, "warning", undefined, ws);
  }
  const ctx = taskContext(getTask(t.id)!);
  if (!ctx.mailbox && !ctx.agent && !ctx.flow) {
    const mq = mailboxQuestion(t.request, ws, conns.connections);
    if (mq) {
      ctx.pendingQuestion = { kind: "mailbox", question: mq.question, options: mq.options.map((o) => ({ value: o, label: o })) };
      updateTask(t.id, { status: "needs_clarification", context: ctx });
      emit({ taskId: t.id, system: "orchestrator", type: "clarification_required", level: "warning", visibility: "chat", summary: mq.question });
      addMessage(t.chat_id, "assistant", "clarify", mq.question, t.id, { kind: "mailbox", options: ctx.pendingQuestion.options });
      return false;
    }
  }
  updateTask(t.id, afterDiscovery(t.mode));
  return true;
}

/** The workspace line (queue.ts): admitted now, or wait here until a kick admits this task. */
async function stageLine(t: TaskRow): Promise<boolean> {
  const ws = t.route as WorkspaceId;
  if (kickLine(ws, t.id) === t.id) return true;
  if (!taskContext(getTask(t.id) ?? t).line) {
    const info = lineInfo(t.id);
    const text = lineMessage(ws, info);
    patchContext(t.id, (c) => ({ ...c, line: { joinedAt: nowIso(), behindTaskId: info?.ahead?.taskId ?? null, behindTitle: info?.ahead?.title ?? null } }));
    lifecycleEvent(t.id, "line_joined", text, "info", info, ws);
    addMessage(t.chat_id, "system", "line", text, t.id, { workspace: ws, position: info?.position ?? null, aheadTaskId: info?.ahead?.taskId ?? null });
  }
  return false;
}

/** The chat line for a task that has to wait. Exported for tests. */
export function lineMessage(ws: WorkspaceId, info: LineInfo | null): string {
  if (!info) return `In line for ${ws}.`;
  const behind = info.ahead ? `, behind “${info.ahead.title}”` : "";
  const stuck = info.heldBy.find((h) => h.status === "needs_reconciliation");
  const why = !stuck
    ? ""
    : stuck.kind === "execution"
      ? ` An orphaned executor from “${stuck.title}” is still running in ${ws}; terminate it from that task in HQ.`
      : ` “${stuck.title}” needs reconciling in HQ before anything else runs in ${ws}.`;
  return `In line for ${ws}: ${info.ordinal} in line${behind}.${why}`;
}

/**
 * Admits the first task in `ws`'s line if `ws` is free, and starts its driver. `selfId` is a task
 * whose own driver is asking: it carries on by itself instead of being started again.
 */
function kickLine(ws: WorkspaceId, selfId: string | null = null): string | null {
  const admitted = admitNext(ws);
  if (!admitted) return null;
  afterAdmission(admitted);
  if (admitted.id !== selfId) void drive(admitted.id);
  return admitted.id;
}

/** Kicks both lines: at boot, and when the Runtime Health check or an orphan stops holding them. */
export function kickLines(): void {
  kickLine("One");
  kickLine("Studio");
}

/**
 * The once-a-minute safety net (boot.ts). An orphaned executor that exits on its own, or whose PID
 * is reused, frees its workspace without any event HQ sees; settle those, then kick both lines.
 */
export async function lineTick(): Promise<void> {
  await settleDeadOrphans();
  kickLines();
}

/** Bookkeeping when a task leaves the line. Exported for tests. */
export function afterAdmission(t: TaskRow): void {
  const ws = t.route as WorkspaceId;
  const ctx = taskContext(t);
  if (t.origin === "chat" && t.chat_id) {
    // Captured again now, so a follow-up that waited sees how the tasks sent before it ended.
    const fresh = conversationContext(t.chat_id, t.id);
    if (fresh) patchContext(t.id, (c) => ({ ...c, conversation: fresh }));
  }
  if (!ctx.line) {
    emit({ taskId: t.id, system: ws, type: "line_admitted", level: "info", visibility: "details", summary: `${ws} is free: starting without waiting` });
    return;
  }
  const at = (iso: string) => logTimestamp(new Date(iso)).slice(11, 16);
  const joined = at(ctx.line.joinedAt);
  const behind = ctx.line.behindTitle ? `“${ctx.line.behindTitle}”${ctx.line.behindTaskId ? ` (${ctx.line.behindTaskId})` : ""}` : "another task";
  lifecycleEvent(t.id, "line_admitted", `Your turn in ${ws}: in line since ${joined}`, "success", undefined, ws);
  addMessage(t.chat_id, "system", "line", "Your turn, starting now.", t.id, { workspace: ws, admitted: true });
  void safeNote(t, "In line", `waited ${joined}–${at(nowIso())} ${loadConfig().logTimezoneLabel} behind ${behind}`);
}

function attachmentsFor(t: TaskRow): Array<{ name: string; path: string }> {
  const ids = taskContext(t).attachmentIds ?? [];
  if (!ids.length) return [];
  return all<{ original_name: string; stored_path: string }>(`SELECT original_name, stored_path FROM attachments WHERE id IN (${ids.map(() => "?").join(",")})`, ids).map((a) => ({ name: a.original_name, path: a.stored_path }));
}

async function stagePlan(t: TaskRow): Promise<boolean> {
  const ctx = taskContext(t);
  if (ctx.reusePlanFrom) {
    const src = getTask(ctx.reusePlanFrom);
    if (src?.plan_json) {
      updateTask(t.id, { plan_json: src.plan_json, planner_model: `${src.planner_model ?? "planner"} (reused from Plan-mode task ${src.id})`, status: "dispatching", stage: "prompt" });
      lifecycleEvent(t.id, "planning_complete", `Reusing the plan from ${src.id}`, "info");
      return true;
    }
  }
  setStage(t.id, "plan");
  // The logs first (spec Part 2): a repeat that worked skips planning; lessons travel either way.
  const checked = logCheck(t);
  // A root-session brief (jos dispatch) carries its own plan, so the logs add only lessons (spec 1.6).
  const memory: NonNullable<TaskContext["memory"]> = ctx.orchestratorBrief ? { decision: "plan", match: null, hasPlan: false, reuseText: null, lessons: checked.memory.lessons } : checked.memory;
  const planJson = ctx.orchestratorBrief ? null : checked.planJson;
  if (!ctx.memory) {
    patchContext(t.id, (c) => ({ ...c, memory }));
    announceMemory(getTask(t.id)!, memory);
  }
  if (ctx.orchestratorBrief) {
    // A root Orchestrator session already planned and wrote the brief (jos dispatch).
    updateTask(t.id, { status: "dispatching", stage: "prompt", planner_model: "root Orchestrator session (jos dispatch)" });
    lifecycleEvent(t.id, "planning_complete", "Planning supplied by the root Orchestrator session (jos dispatch brief)", "info");
    return true;
  }
  if (memory.decision === "reuse" && memory.match && (t.mode !== "plan" || planJson)) {
    const m = memory.match;
    const label = `reused from ${m.taskId ?? m.file} (${m.date ?? "undated"})`;
    updateTask(t.id, { plan_json: planJson, planner_model: label });
    lifecycleEvent(t.id, "planning_complete", `Planning skipped: ${label}`, "info", memory);
    await safeNote(getTask(t.id)!, "Reused", `matched "${m.title}" (${label}); planning skipped`);
    if (t.mode === "plan") {
      const plan = JSON.parse(planJson!) as PlannerResult;
      addMessage(t.chat_id, "assistant", "plan", plan.objective, t.id, { plan, model: label, problems: [] });
      await finish(getTask(t.id)!, {
        status: "planned",
        logStatus: "done",
        outcome: `Plan mode: reused the plan of "${m.title}" (${label}); nothing was executed by design.`,
        answer: "Plan ready, reused from an earlier task. Nothing was executed (Plan mode). Use “Execute this plan” to run it.",
        verification: "none",
      });
      return false;
    }
    updateTask(t.id, { status: "dispatching", stage: "prompt" });
    return true;
  }
  return runPlanner(getTask(t.id)!);
}

/** The log check before planning. Exported for tests. */
export function logCheck(t: TaskRow): { memory: NonNullable<TaskContext["memory"]>; planJson: string | null } {
  const ws = t.route as WorkspaceId;
  const ctx = taskContext(t);
  const agentLog = ctx.agent ? (findAgent(ctx.agent.workspace, ctx.agent.name)?.logsFile ?? null) : null;
  const decision = decide(findMatches(t.request, readEntries(logSources(ws, agentLog)), t.id));
  const lessons = renderLessons(decision.lessons);
  if (decision.kind === "plan") return { memory: { decision: "plan", match: null, hasPlan: false, reuseText: null, lessons }, planJson: null };
  const e = decision.match.entry;
  const src = e.taskId ? getTask(e.taskId) : undefined;
  const parsed = src ? parseJson<unknown>(src.plan_json, null) : null;
  const planJson = isV2Plan(parsed) ? JSON.stringify(parsed) : null;
  const reuseText = `This request matches an earlier task that ended done, so planning was skipped. Reuse what worked, and verify it against live state: things may have changed since ${e.date ?? "then"}.${planJson ? " Its checked plan is under CHECKED PLAN below." : " It has no saved plan HQ can reuse; work from this entry."}\n${renderEntry(e)}`;
  return { memory: { decision: "reuse", match: { taskId: e.taskId, file: path.basename(e.file), date: e.date, title: e.title }, hasPlan: !!planJson, reuseText, lessons }, planJson };
}

function announceMemory(t: TaskRow, m: NonNullable<TaskContext["memory"]>) {
  if (m.decision === "reuse" && m.match) {
    const skipped = t.mode === "plan" && !m.hasPlan ? "no saved plan to reuse, so planning anyway." : "planning skipped.";
    const text = `Matched “${m.match.title}” (${m.match.date ?? "undated"}${m.match.taskId ? `, ${m.match.taskId}` : ""}): ${skipped}`;
    addMessage(t.chat_id, "system", "memory", text, t.id, { match: m.match, hasPlan: m.hasPlan });
    lifecycleEvent(t.id, "memory_matched", text, "info", m);
  } else if (m.lessons) {
    const text = taskContext(t).orchestratorBrief ? "A similar earlier task did not end done: its lessons go to the executor with the root session's brief." : "A similar earlier task did not end done: planning with its lessons.";
    addMessage(t.chat_id, "system", "memory", text, t.id, {});
    lifecycleEvent(t.id, "memory_lessons", text, "info", m);
  }
}

async function runPlanner(t: TaskRow): Promise<boolean> {
  const ws = t.route as WorkspaceId;
  const ctx = taskContext(t);
  const policy = phasePolicy(ws, "plan");
  const [conns, flows] = await Promise.all([listConnections(ws), listFlows(ws)]);
  const connections = conns.connections ?? [];
  const scope = agentScope(t, connections);
  const prompt = buildPlannerPrompt({
    taskId: t.id,
    workspace: ws,
    mode: t.mode,
    request: t.request,
    routeReason: t.route_reason ?? "",
    connections,
    flows: flows.flows ?? [],
    identity: ctx.identity ?? { projectRoot: null, email: null },
    clarifications: ctx.clarifications.map((c) => ({ question: c.question, answer: c.answer })),
    attachments: attachmentsFor(t),
    conversation: ctx.conversation?.text ?? null,
    buildFlow: !!ctx.buildFlow,
    agent: ctx.agent ? agentBrief(t) : null,
    lessons: ctx.memory?.lessons ?? null,
  });
  lifecycleEvent(t.id, "planning_started", `Planning session: ${policy.modelLabel} (${policy.effort}) in JOS/${ws}, read-only`, "info", { prompt: prompt.slice(0, 20000) }, ws);
  let outcome: ExecutionOutcome;
  try {
    const d = await dispatch({ taskId: t.id, workspace: ws, phase: "plan", mode: t.mode, prompt, extraReadDirs: readDirsFor(t), origin: { kind: "hq" }, allowedConnectionKeys: scope?.keys ?? null });
    patchContext(t.id, (c) => ({ ...c, planExecutionId: d.executionId }));
    outcome = await d.done;
  } catch (e) {
    return planningFailed(getTask(t.id)!, e instanceof Error ? e.message : String(e));
  }
  const fresh = getTask(t.id)!;
  if (outcome.status === "cancelled" || taskContext(fresh).cancelRequested) {
    await finishCancelled(fresh, "during planning (the planning session is read-only)");
    return false;
  }
  if (outcome.verification.ok !== true) return planningFailed(fresh, `the planning session's launch was not verified (${outcome.verification.reason ?? "no evidence"})`);
  const plan = outcome.exit.plan ?? null;
  if (!plan) return planningFailed(fresh, outcome.exit.error ?? "the planning session returned no structured plan");
  const check = checkPlan(plan, { workspace: ws, connections, allowedKeys: scope?.keys ?? null, knowledge: knowledgeCallsFor(outcome.executionId) });
  if (!check.identityOk) return planningFailed(fresh, "the planner did not confirm its One identity");
  const others = outcome.verification.mainModels.filter((m) => m !== policy.model);
  const flags = [...check.flags, ...(others.length ? [`Part of the planning session answered on ${others.join(", ")}, not ${policy.model}.`] : [])];
  const credited = `${policy.modelLabel} (${policy.effort})`;
  updateTask(fresh.id, { plan_json: JSON.stringify(plan), planner_model: credited, title: plan.title ? redactSecrets(plan.title).slice(0, 80) : fresh.title });
  patchContext(fresh.id, (c) => ({ ...c, planProblems: flags, planUnverifiedSteps: check.unverifiedSteps }));
  lifecycleEvent(fresh.id, "planning_complete", `Plan produced by ${credited}`, "success", { steps: plan.steps.length, flags }, ws);
  emit({
    taskId: fresh.id,
    system: "orchestrator",
    type: "plan_validated",
    level: flags.length ? "warning" : "success",
    visibility: "chat",
    summary: flags.length ? `Plan checked, ${flags.length} flag(s): ${flags.join(" ")}`.slice(0, 600) : "Plan checked against live connections and the planner's own lookups",
    data: { plan, flags },
  });
  const questions = plan.status === "blocked" ? plan.intent_questions : [];
  if (t.mode === "plan" || questions.length) addMessage(fresh.chat_id, "assistant", "plan", plan.objective, fresh.id, { plan, model: credited, problems: flags });
  if (questions.length) {
    const c2 = taskContext(getTask(fresh.id)!);
    c2.pendingQuestion = { kind: "planner", question: questions.join("\n"), options: [] };
    updateTask(fresh.id, { status: "needs_clarification", context: c2 });
    emit({ taskId: fresh.id, system: "orchestrator", type: "clarification_required", level: "warning", visibility: "chat", summary: `The planner needs input: ${questions.join(" ")}`.slice(0, 600) });
    addMessage(fresh.chat_id, "assistant", "clarify", questions.join("\n"), fresh.id, { kind: "planner", options: [] });
    return false;
  }
  if (plan.status === "blocked") return planningFailed(getTask(fresh.id)!, `the planner could not plan this: ${plan.notes || "no reason given"}`, true);
  if (t.mode === "plan") {
    await finish(getTask(fresh.id)!, {
      status: "planned",
      logStatus: "done",
      outcome: `Plan mode: planned by ${credited} in a read-only session; nothing was executed by design. Objective: ${plan.objective}`,
      answer: "Plan ready. Nothing was executed (Plan mode). Use “Execute this plan” to run it.",
      verification: "none",
      learned: flags.join(" ") || undefined,
    });
    return false;
  }
  updateTask(fresh.id, { status: "dispatching", stage: "prompt" });
  return true;
}

/** Manual and Plan mode stop without a plan; Edit and Auto continue and say the executor had none. */
async function planningFailed(t: TaskRow, reason: string, keepPlan = false): Promise<boolean> {
  emit({ taskId: t.id, system: "orchestrator", type: "planning_failed", level: "warning", visibility: "chat", summary: `Planning failed: ${reason}`.slice(0, 600) });
  if (t.mode === "plan" || t.mode === "manual") {
    await finish(t, {
      status: "blocked",
      logStatus: "blocked",
      outcome: `Planning failed, and ${t.mode} mode stops rather than dispatching without a plan: ${reason}`,
      answer: `Planning failed: ${reason}. Nothing was dispatched.`,
      verification: "none",
    });
    return false;
  }
  updateTask(t.id, { status: "dispatching", stage: "prompt", planner_model: `none (planning failed: ${reason.slice(0, 200)})`, ...(keepPlan ? {} : { plan_json: null }) });
  return true;
}

function promptContextBase(t: TaskRow) {
  const ctx = taskContext(t);
  const parsed = parseJson<unknown>(t.plan_json, null);
  const m = ctx.memory;
  return {
    taskId: t.id,
    workspace: t.route as WorkspaceId,
    mode: t.mode,
    request: t.request,
    routeReason: t.route_reason ?? "",
    plan: isV2Plan(parsed) ? parsed : null,
    plannerNote: t.planner_model,
    planFlags: ctx.planProblems ?? [],
    planUnverifiedSteps: ctx.planUnverifiedSteps ?? [],
    memory: m ? [m.reuseText, m.lessons ? `Similar earlier tasks that did not end done:\n${m.lessons}` : null].filter(Boolean).join("\n\n") || null : null,
    // A plan reused from an earlier, similar task (log check) describes that task: reference only.
    planReused: m?.decision === "reuse" && !!t.planner_model?.startsWith("reused from "),
    identity: ctx.identity ?? { projectRoot: null, email: null },
    clarifications: ctx.clarifications.map((c) => ({ question: c.question, answer: c.answer })),
    attachments: attachmentsFor(t),
    orchestratorBrief: ctx.orchestratorBrief ?? null,
    agent: ctx.agent ? (({ name, sop, history, logsFile }) => ({ name, instructions: sop, history, logsFile }))(agentBrief(t)) : null,
    conversation: ctx.conversation?.text ?? null,
    buildFlow: !!ctx.buildFlow,
  };
}

/** What a planner or executor is told about the agent it acts as: its SOP, its log memory and its connections. */
function agentBrief(t: TaskRow): { name: string; sop: string; history: string | null; allowedConnections: string[]; logsFile: string | null } {
  const ctx = taskContext(t);
  // agentInstructions first: a vanished agent or unusable SOP blocks the task as AGENT_INVALID.
  const sop = agentInstructions(ctx.agent!.workspace, ctx.agent!.name);
  const a = findAgent(ctx.agent!.workspace, ctx.agent!.name)!;
  return {
    name: a.key,
    sop,
    history: a.logsFile ? agentHistory(a.logsFile, t.request, t.id) : null,
    allowedConnections: a.allowedConnections.map((c) => `${c.platform} · "${c.name}"`),
    logsFile: a.logsFile,
  };
}

/** An agent task's allowed connection keys, or null for an ordinary task. Throws when the agent cannot run. */
function agentScope(t: TaskRow, connections: ConnectionInfo[]): { keys: string[]; missing: string[] } | null {
  const ctx = taskContext(t);
  if (!ctx.agent) return null;
  agentInstructions(ctx.agent.workspace, ctx.agent.name); // a missing agent or SOP → AGENT_INVALID
  const a = findAgent(ctx.agent.workspace, ctx.agent.name)!;
  if (!a.allowedConnections.length) {
    throw new DispatchError("AGENT_INVALID", `${a.key} lists no connection HQ can read in its "## Allowed connections" section (one "- <platform> · "<name>"" line each). Edit the agent in HQ.`);
  }
  const scope = resolveScope(a.allowedConnections, connections);
  if (!scope.keys.length) throw new DispatchError("AGENT_INVALID", `None of ${a.key}'s allowed connections is live and operational in ${a.workspace}: ${scope.missing.join(", ")}.`);
  return scope;
}

/** Folders a session may read outside its workspace: the task's attachments and, for an agent task, the agent's folder. */
function readDirsFor(t: TaskRow): string[] {
  const ctx = taskContext(t);
  const dirs = attachmentsFor(t).map((a) => path.dirname(a.path));
  if (ctx.agent) {
    const a = findAgent(ctx.agent.workspace, ctx.agent.name);
    if (a?.logsFile) dirs.push(path.dirname(a.logsFile));
  }
  return [...new Set(dirs)];
}

/** The agent's instructions (its SOP), re-read at every phase. A missing agent or unusable SOP blocks the task. */
function agentInstructions(ws: WorkspaceId, name: string): string {
  const a = findAgent(ws, name);
  if (!a) throw new DispatchError("AGENT_INVALID", `The sub-agent ${name} no longer exists in ${ws}.`);
  if (a.sopError) throw new DispatchError("AGENT_INVALID", `${name} cannot run: ${a.sopError}`);
  return `${a.description ? `Purpose: ${a.description}\n` : ""}${a.instructions}`;
}

async function stagePreview(t: TaskRow): Promise<boolean> {
  const ws = t.route as WorkspaceId;
  setStage(t.id, "prompt");
  const [conns, flows] = await Promise.all([listConnections(ws), listFlows(ws)]);
  const prompt = buildExecutorPrompt({ ...promptContextBase(t), phase: "preview", connections: conns.connections ?? [], flows: flows.flows ?? [] });
  patchContext(t.id, (c) => ({ ...c, flowsBefore: flows.flows?.map((f) => f.key) ?? null }));
  lifecycleEvent(t.id, "executor_prompt_ready", `Executor prompt ready (${prompt.length} characters, PREVIEW phase)`, "info", { prompt: prompt.slice(0, 20000) }, ws);
  setStage(t.id, "launch");
  const d = await dispatch({ taskId: t.id, workspace: ws, phase: "preview", mode: t.mode, prompt, extraReadDirs: readDirsFor(t), origin: { kind: "hq" }, allowedConnectionKeys: agentScope(t, conns.connections ?? [])?.keys ?? null });
  patchContext(t.id, (c) => ({ ...c, previewExecutionId: d.executionId }));
  updateTask(t.id, { status: "executing", stage: "execute" });
  const outcome = await d.done;
  return evaluatePreview(getTask(t.id)!, outcome);
}

async function evaluatePreview(t: TaskRow, outcome: ExecutionOutcome): Promise<boolean> {
  const res = outcome.exit.structured;
  patchContext(t.id, (c) => ({ ...c, previewResult: res }));
  if (outcome.status === "cancelled" || taskContext(t).cancelRequested) {
    await finishCancelled(t, "during the PREVIEW phase (no external side effect can run in PREVIEW; the gateway refuses writes)");
    return false;
  }
  if (outcome.verification.ok === false) {
    await finish(t, {
      status: "blocked",
      logStatus: "blocked",
      outcome: `Launch verification failed and the executor was stopped: ${outcome.verification.reason}`,
      answer: `${loadConfig().workspaces[t.route as WorkspaceId].executor.modelLabel} (${loadConfig().workspaces[t.route as WorkspaceId].executor.effort}) could not be verified: ${outcome.verification.reason}. Nothing was executed.`,
      verification: "failed",
    });
    return false;
  }
  if (!res) {
    await finish(t, {
      status: "failed",
      logStatus: "blocked",
      outcome: outcome.exit.error ?? "The executor returned no structured result.",
      answer: outcome.exit.error ?? "The executor returned no structured result.",
      verification: "failed",
    });
    return false;
  }
  const hasActions = res.proposed_actions.length > 0;
  if (res.status === "needs_approval" || (hasActions && res.status === "completed")) {
    if (!hasActions) {
      return finishFromResult(t, res, outcome, "preview");
    }
    setStage(t.id, "approve");
    const actions = await validateProposals(t, res, outcome.executionId);
    const summary = actions.map((a) => a.title).join("; ");
    const ap = createApproval(t.id, outcome.executionId, actions, summary, t.route as WorkspaceId);
    patchContext(t.id, (c) => ({ ...c, approvalId: ap.id }));
    if (autoApproves(t.mode, actions)) {
      // Auto mode: HQ approves on the operator's standing instruction. Nothing is awaited between
      // creating and resolving the approval, so a browser never sees it pending.
      resolveApproval(ap.id, "approved", "Auto mode: approved by HQ without asking", "auto");
      addMessage(t.chat_id, "assistant", "approval", res.answer || `${actions.length} action(s) proposed.`, t.id, { approvalId: ap.id, autoApproved: true });
      addMessage(t.chat_id, "system", "approval_resolved", "Auto-approved (Auto mode)", t.id, { approvalId: ap.id, decision: "approved", by: "auto" });
      updateTask(t.id, { status: "dispatching", stage: "execute" });
      await safeNote(t, "Auto-approved", `Auto mode approved ${actions.length} action(s) without asking: ${summary}`);
      return true;
    }
    updateTask(t.id, { status: "awaiting_approval", stage: "approve" });
    const why = t.mode === "auto" ? " Auto mode could not approve this on its own: resolve or reject the validation problems shown." : "";
    addMessage(t.chat_id, "assistant", "approval", `${res.answer || `Approval required for ${actions.length} action(s).`}${why}`, t.id, { approvalId: ap.id });
    await safeNote(t, "Approval requested", `${actions.length} action(s): ${summary}`);
    return false;
  }
  if (res.status === "blocked" && res.needs_user_input.trim()) {
    const ctx = taskContext(t);
    ctx.pendingQuestion = { kind: "executor", question: res.needs_user_input.trim(), options: [] };
    updateTask(t.id, { status: "needs_clarification", context: ctx });
    emit({ taskId: t.id, system: t.route as WorkspaceId, type: "clarification_required", level: "warning", visibility: "chat", summary: `Executor needs input: ${res.needs_user_input}` });
    addMessage(t.chat_id, "assistant", "clarify", res.needs_user_input.trim(), t.id, { kind: "executor", options: [], answer: res.answer });
    return false;
  }
  return finishFromResult(t, res, outcome, "preview");
}

/**
 * Auto mode needs no operator approval (the operator's instruction, 2026-09-23), but only for actions
 * HQ validated. One with problems cannot be approved by anyone, so it still waits to be rejected.
 */
export function autoApproves(mode: TaskMode, actions: Array<{ problems: string[] }>): boolean {
  return mode === "auto" && actions.length > 0 && actions.every((a) => a.problems.length === 0);
}

async function validateProposals(t: TaskRow, res: ExecutorResult, executionId: string): Promise<ApprovalAction[]> {
  const ws = t.route as WorkspaceId;
  const conns = (await listConnections(ws)).connections ?? [];
  const flows = (await listFlows(ws)).flows ?? [];
  // An agent's proposals must stay inside its allowed connections, or no one (Auto mode included) can approve them.
  const scope = agentScope(t, conns);
  const out: ApprovalAction[] = [];
  let index = 1;
  for (const p of res.proposed_actions) {
    const problems: string[] = [];
    const data = tryParseJson(p.data_json);
    const pv = tryParseJson(p.path_vars_json);
    const qp = tryParseJson(p.query_params_json);
    const fi = tryParseJson(p.flow_inputs_json);
    if (!data.ok) problems.push(`data_json is not valid JSON (${data.error})`);
    if (!pv.ok) problems.push(`path_vars_json is not valid JSON (${pv.error})`);
    if (!qp.ok) problems.push(`query_params_json is not valid JSON (${qp.error})`);
    if (!fi.ok) problems.push(`flow_inputs_json is not valid JSON (${fi.error})`);
    // A payload that carries a credential is never stored, shown or sent. Redacting it would change
    // what runs, so the redacted copy is kept only for display and the action cannot be approved.
    for (const part of [data, pv, qp, fi]) {
      if (containsSecret(part.value)) {
        part.value = redactDeep(part.value);
        if (!problems.some((x) => x.startsWith("the payload appears to contain a credential"))) {
          problems.push("the payload appears to contain a credential (key, token or password). HQ never stores or sends secrets: reject this and ask for the action without it.");
        }
      }
    }
    let dryRun: ApprovalAction["dryRun"] = null;
    let method: string | null = p.method || null;
    let connectionName: string | null = p.connection_name || null;
    if (p.kind === "one_action") {
      const conn = conns.find((c) => c.key === p.connection_key);
      if (!conn) problems.push(`connection ${p.connection_key || "(none)"} is not a live ${ws} connection`);
      else {
        connectionName = conn.name;
        if (conn.platform !== p.platform) problems.push(`connection ${conn.name} is ${conn.platform}, not ${p.platform}`);
        if (conn.state !== "operational") problems.push(`connection ${conn.name} is ${conn.state}`);
      }
      if (scope && p.connection_key && !scope.keys.includes(p.connection_key)) problems.push(`connection ${connectionName ?? p.connection_key} is outside this agent's allowed connections`);
      if (!p.action_id) problems.push("no action id");
      if (!problems.length) {
        // The same argument form jos-approved will run, so HQ previews exactly what would execute.
        const args = ["--agent", "actions", "execute", p.platform, p.action_id, p.connection_key];
        if (data.value !== null) args.push("-d", JSON.stringify(data.value));
        if (emptyToNull(pv.value) !== null) args.push("--path-vars", JSON.stringify(pv.value));
        if (emptyToNull(qp.value) !== null) args.push("--query-params", JSON.stringify(qp.value));
        args.push("--dry-run");
        const r = await runOneReadOnly<{ request?: { method?: string; url?: string } }>(ws, args, 60000);
        if (r.ok && r.json?.request) {
          method = r.json.request.method ?? method;
          dryRun = { ok: true, method: r.json.request.method ?? null, url: r.json.request.url ?? null, detail: null };
          const cls = classifyRequest(p.platform, r.json.request.method, r.json.request.url);
          if (cls.category === "read") problems.push("HQ's dry-run shows this is a read, not a side effect; it does not need approval (reject it and let the executor run it in PREVIEW).");
        } else {
          dryRun = { ok: false, method: null, url: null, detail: r.error ?? "dry-run failed" };
          problems.push(`HQ dry-run failed: ${r.error ?? "unknown error"}`);
        }
      }
    } else {
      const flow = flows.find((f) => f.key === p.flow_key);
      if (!flow) problems.push(`flow ${p.flow_key || "(none)"} does not exist in ${ws} (live flow list)`);
      else {
        // A flow runs its own actions inside the One CLI, out of the gateway's sight, so an agent's run is
        // checked against its connections from the flow's definition.
        if (scope) problems.push(...flowScopeProblems({ workspaceRoot: workspaceRoot(ws), flowKey: p.flow_key, inputs: (fi.value as Record<string, unknown>) ?? {}, scopeKeys: scope.keys, connections: conns }));
        const v = await runOneReadOnly(ws, ["--agent", "flow", "validate", p.flow_key], 60000);
        if (!v.ok) problems.push(`flow validate failed: ${v.error}`);
        const args = ["--agent", "flow", "execute", p.flow_key, "--dry-run"];
        for (const [k, val] of Object.entries((fi.value as Record<string, unknown>) ?? {})) args.push("-i", `${k}=${typeof val === "string" ? val : JSON.stringify(val)}`);
        const r = await runOneReadOnly(ws, args, 90000);
        dryRun = { ok: r.ok, method: null, url: null, detail: r.ok ? "flow dry-run resolved" : r.error ?? "flow dry-run failed" };
        if (!r.ok) problems.push(`flow dry-run failed: ${r.error}`);
      }
    }
    const payloadHash = actionPayloadHash({
      kind: p.kind,
      platform: p.platform,
      actionId: p.kind === "one_action" ? p.action_id : null,
      connectionKey: p.kind === "one_action" ? p.connection_key : null,
      data: p.kind === "one_action" ? data.value : null,
      pathVars: p.kind === "one_action" ? pv.value : null,
      queryParams: p.kind === "one_action" ? qp.value : null,
      flowKey: p.kind === "one_flow" ? p.flow_key : null,
      flowInputs: p.kind === "one_flow" ? fi.value : null,
    });
    const matched = !!get("SELECT 1 AS x FROM events WHERE execution_id = ? AND data_json LIKE ? LIMIT 1", [executionId, `%"payloadHash":"${payloadHash}"%`]);
    out.push({
      index: index++,
      kind: p.kind,
      title: p.title || `${p.platform} action`,
      platform: p.platform,
      actionId: p.kind === "one_action" ? p.action_id : null,
      connectionKey: p.kind === "one_action" ? p.connection_key : null,
      connectionName,
      method,
      target: p.target || null,
      data: p.kind === "one_action" ? data.value : null,
      pathVars: p.kind === "one_action" ? pv.value : null,
      queryParams: p.kind === "one_action" ? qp.value : null,
      flowKey: p.kind === "one_flow" ? p.flow_key : null,
      flowInputs: p.kind === "one_flow" ? ((fi.value as Record<string, unknown>) ?? {}) : null,
      sideEffect: p.side_effect,
      idempotent: p.idempotent,
      expectedCalls: p.expected_calls,
      estimatedCost: p.estimated_cost,
      payloadHash,
      dryRun,
      executorDryRunMatched: matched,
      problems,
    });
  }
  return out;
}

async function stageExecute(t: TaskRow): Promise<boolean> {
  const ws = t.route as WorkspaceId;
  const ctx = taskContext(t);
  if (!ctx.approvalId) throw new Error("no approval recorded for the EXECUTE phase");
  const approved = approvedActionsFor(ctx.approvalId);
  if (!approved.length) throw new Error("the approval has no approved actions");
  setStage(t.id, "prompt");
  const [conns, flows] = await Promise.all([listConnections(ws), listFlows(ws)]);
  const prev = ctx.previewResult as ExecutorResult | null;
  const prompt = buildExecutorPrompt({
    ...promptContextBase(t),
    phase: "execute",
    connections: conns.connections ?? [],
    flows: flows.flows ?? [],
    approvedActions: approved,
    previewSummary: prev ? `${prev.summary}\n${prev.answer}`.slice(0, 3000) : null,
  });
  lifecycleEvent(t.id, "executor_prompt_ready", `Executor prompt ready (${prompt.length} characters, EXECUTE phase, ${approved.length} approved action(s))`, "info", { prompt: prompt.slice(0, 20000) }, ws);
  setStage(t.id, "launch");
  // The EXECUTE run may need the same attachments the PREVIEW run read (e.g. "send the attached file").
  const d = await dispatch({ taskId: t.id, workspace: ws, phase: "execute", mode: t.mode, prompt, approvedActions: approved, extraReadDirs: readDirsFor(t), origin: { kind: "hq" }, allowedConnectionKeys: agentScope(t, conns.connections ?? [])?.keys ?? null });
  patchContext(t.id, (c) => ({ ...c, executeExecutionId: d.executionId }));
  updateTask(t.id, { status: "executing", stage: "execute" });
  const outcome = await d.done;
  return evaluateExecute(getTask(t.id)!, outcome);
}

async function evaluateExecute(t: TaskRow, outcome: ExecutionOutcome): Promise<boolean> {
  const ctx = taskContext(t);
  const ap = ctx.approvalId ? getApproval(ctx.approvalId) : null;
  const states = ap?.states ?? [];
  const byState = (s: string) => states.filter((x) => x.state === s).map((x) => ap!.actions.find((a) => a.index === x.index)?.title ?? `#${x.index}`);
  const executing = byState("executing");
  const ambiguous = byState("ambiguous");
  const succeeded = byState("succeeded");
  const failed = byState("failed");
  const notRun = byState("ready");
  const ids = states.flatMap((s) => ((s.outcome as { responseIds?: string[] } | null)?.responseIds ?? []).map((id) => `${ap!.actions.find((a) => a.index === s.index)?.title ?? s.index}: ${id}`));

  if (executing.length || ambiguous.length) {
    await finish(t, {
      status: "needs_reconciliation",
      logStatus: "partial",
      outcome: `Side-effect state unknown for: ${[...executing, ...ambiguous].join("; ")}. ${outcome.status === "cancelled" ? "The run was stopped while an approved action was executing." : "An approved action returned an ambiguous result."} It was NOT retried. Verify in the platform whether it happened.`,
      answer: `The outcome of ${[...executing, ...ambiguous].join("; ")} is unknown and it was not retried. Check whether it happened before doing anything else.`,
      verification: "failed",
      artifacts: ids.join("; "),
    });
    return false;
  }
  if (outcome.status === "cancelled" || ctx.cancelRequested) {
    await finish(t, {
      status: "cancelled",
      logStatus: succeeded.length ? "partial" : "abandoned",
      outcome: `Cancelled during the EXECUTE phase. ${succeeded.length ? `Completed before the stop: ${succeeded.join("; ")}.` : "No approved action had run."}${notRun.length ? ` Not run: ${notRun.join("; ")}.` : ""}`,
      answer: `Stopped. ${succeeded.length ? `Already done: ${succeeded.join("; ")}.` : "No approved action ran."}`,
      verification: "none",
      artifacts: ids.join("; "),
    });
    return false;
  }
  const res = outcome.exit.structured;
  if (!res) {
    await finish(t, {
      status: succeeded.length ? "unverified" : "failed",
      logStatus: succeeded.length ? "partial" : "blocked",
      outcome: `${outcome.exit.error ?? "The executor returned no structured result."}${succeeded.length ? ` Approved actions that succeeded: ${succeeded.join("; ")}.` : ""}`,
      answer: outcome.exit.error ?? "The executor returned no structured result.",
      verification: "failed",
      artifacts: ids.join("; "),
    });
    return false;
  }
  const problems: string[] = [];
  if (failed.length) problems.push(`approved action(s) failed: ${failed.join("; ")}`);
  if (notRun.length) problems.push(`approved action(s) not run: ${notRun.join("; ")}`);
  return finishFromResult(t, res, outcome, "execute", problems, ids);
}

async function finishFromResult(t: TaskRow, res: ExecutorResult, outcome: ExecutionOutcome, phase: "preview" | "execute", extraProblems: string[] = [], extraArtifacts: string[] = []): Promise<boolean> {
  setStage(t.id, "verify");
  lifecycleEvent(t.id, "verification_started", "Evaluating the result against the objective", "info");
  const ws = t.route as WorkspaceId;
  const policy = loadConfig().workspaces[ws].executor;
  const problems = [...extraProblems];
  if (outcome.verification.ok !== true) problems.push(`launch not verified (${outcome.verification.reason ?? "no evidence"})`);
  const others = outcome.verification.mainModels.filter((m) => m !== policy.model);
  if (others.length) problems.push(`part of the run used ${others.join(", ")} instead of ${policy.model}`);
  if (res.status !== "completed") problems.push(`executor status is ${res.status}`);
  if (!res.verification.performed) problems.push("the executor did not verify the outcome");
  else if (!res.verification.passed) problems.push(`the executor's verification failed (${res.verification.evidence || res.verification.method})`);
  if (!res.identity_check.passed) problems.push("the executor did not confirm its One identity");
  const ctx = taskContext(t);
  if (ctx.buildFlow) {
    const after = await listFlows(ws);
    if (after.flows) rememberFlows(ws, after.flows); // so the Workflows page shows it without waiting out the cache
    const check = checkFlowBuild({ workspace: ws, workspaceRoot: workspaceRoot(ws), before: ctx.flowsBefore ?? null, since: t.created_at, after });
    problems.push(...check.problems);
    extraArtifacts = [...extraArtifacts, ...check.created.map((k) => `one_flow ${k} (new, confirmed by HQ's live flow list)`), ...check.updated.map((k) => `one_flow ${k} (changed, confirmed by HQ's live flow list)`)];
    lifecycleEvent(t.id, "flow_build_checked", check.problems.length ? check.problems[0] : `HQ confirmed the flow in JOS/${ws}: ${[...check.created, ...check.updated].join(", ")}`, check.problems.length ? "warning" : "success", check, ws);
  }
  const verified = problems.length === 0;
  const executionComplete = res.status === "completed" || res.status === "partial";
  emit({
    taskId: t.id,
    system: ws,
    type: verified ? "verification_passed" : "verification_failed",
    level: verified ? "success" : "warning",
    visibility: "chat",
    summary: verified ? `Verified Complete — ${res.verification.method}: ${res.verification.evidence}`.slice(0, 600) : `${executionComplete ? "Execution Complete, not verified" : "Not complete"}: ${problems.join("; ")}`,
    data: { problems, verification: res.verification, phase },
  });
  const artifacts = [...res.artifacts.map((a) => [a.kind, a.id, a.path].filter(Boolean).join(" ")), ...extraArtifacts].filter(Boolean);
  for (const a of res.artifacts) {
    run("INSERT INTO artifacts(task_id, kind, ref, path, description, created_at) VALUES (?, ?, ?, ?, ?, ?)", [t.id, a.kind, a.id, a.path, a.description, nowIso()]);
  }
  const status: TaskStatus = verified ? "completed" : res.status === "failed" ? "failed" : res.status === "blocked" ? "blocked" : "unverified";
  const logStatus: LogStatus = verified ? "done" : res.status === "blocked" || res.status === "failed" ? "blocked" : "partial";
  await finish(t, {
    status,
    logStatus,
    outcome: `${verified ? "Verified Complete" : executionComplete ? "Execution Complete, verification incomplete" : `Executor reported ${res.status}`}: ${res.summary || res.answer}${problems.length ? ` (${problems.join("; ")})` : ""}`,
    answer: res.answer,
    verification: verified ? "verified" : executionComplete ? "execution_complete" : "failed",
    artifacts: artifacts.join("; "),
    learned: [...res.learned, ...res.limitations].join(" ") || undefined,
    result: res,
  });
  return false;
}

// ------------------------------------------------------------------------------------------------
// Close-out

interface FinishInput {
  status: TaskStatus;
  logStatus: LogStatus;
  outcome: string;
  answer: string;
  verification: "none" | "execution_complete" | "verified" | "failed";
  artifacts?: string;
  learned?: string;
  result?: ExecutorResult;
}

async function safeNote(t: TaskRow, label: string, text: string) {
  if (!t.log_file) return;
  try {
    await appendLogNote(t.id, t.log_file, label, text);
  } catch (e) {
    lifecycleEvent(t.id, "log_update_failed", `Markdown log update failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

async function finish(t: TaskRow, f: FinishInput): Promise<void> {
  let fresh = getTask(t.id) ?? t;
  setStage(t.id, "close");
  let logNote = "";
  if (!fresh.log_opened_at) {
    // Every task gets exactly one entry. One that ended before a destination was settled is
    // Orchestrator-only work (CLAUDE.md §14), so it is logged in JOSMEMORY.md.
    try {
      const file = logFileFor(fresh.route === "One" || fresh.route === "Studio" ? fresh.route : "none");
      await openLogEntry({ taskId: t.id, file, title: fresh.title, asked: fresh.request, route: fresh.route && fresh.route !== "none" ? `${fresh.route} — ${fresh.route_reason}` : `none — ended (${f.status}) before a destination was settled` });
      updateTask(t.id, { log_file: file, log_opened_at: nowIso() });
      fresh = getTask(t.id) ?? fresh;
    } catch (e) {
      logNote = ` (Markdown log update failed: ${e instanceof Error ? e.message : String(e)})`;
    }
  }
  if (fresh.log_file && fresh.log_opened_at && !fresh.log_closed_at) {
    try {
      const ctx = taskContext(fresh);
      const plannerLine = fresh.planner_model ? `Planned by ${fresh.planner_model}.` : "";
      const learned = [f.learned, (ctx.planProblems ?? []).join(" "), plannerLine].filter(Boolean).join(" ");
      await closeLogEntry({ taskId: t.id, file: fresh.log_file, status: f.logStatus, outcome: f.outcome, artifacts: f.artifacts ?? "none", learned });
      updateTask(t.id, { log_closed_at: nowIso(), log_status: f.logStatus });
      lifecycleEvent(t.id, "log_closed", `Log entry closed in ${fresh.log_file} as ${f.logStatus}`, "info");
    } catch (e) {
      logNote = ` (Markdown log update failed: ${e instanceof Error ? e.message : String(e)})`;
      lifecycleEvent(t.id, "log_update_failed", `Markdown log update failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }
  // The agent's own LOGS.md entry closes with the central one (spec 3.5): same outcome, plus the
  // approved actions' end states and what is still open. A failure here never breaks close-out.
  const ctxF = taskContext(getTask(t.id) ?? fresh);
  const al = ctxF.agentLog;
  if (al && !al.closed) {
    try {
      const ap = ctxF.approvalId ? getApproval(ctxF.approvalId) : null;
      const actions = ap ? ap.actions.map((a) => `${a.title}: ${ap.states.find((s) => s.index === a.index)?.state ?? ap.status}`).join("; ") : null;
      const open = f.logStatus === "done" ? null : [...(f.result?.limitations ?? []), f.result?.needs_user_input ?? ""].filter(Boolean).join(" ") || "see Outcome";
      await closeLogEntry({ taskId: t.id, file: al.file, status: f.logStatus, outcome: f.outcome, artifacts: f.artifacts ?? "none", learned: f.learned ?? "", extra: [{ label: "Actions", text: actions }, { label: "Open", text: open }] });
      patchContext(t.id, (c) => ({ ...c, agentLog: { file: al.file, closed: true } }));
    } catch (e) {
      lifecycleEvent(t.id, "log_update_failed", `Agent log update failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }
  updateTask(t.id, {
    status: f.status,
    stage: "respond",
    verification: f.verification,
    result_json: f.result ? JSON.stringify(f.result) : fresh.result_json,
    error: ["failed", "blocked"].includes(f.status) ? redactSecrets(f.outcome).slice(0, 2000) : null,
    ended_at: nowIso(),
  });
  const typeMap: Partial<Record<TaskStatus, string>> = { completed: "task_complete", unverified: "task_complete", planned: "task_complete", cancelled: "task_cancelled", rejected: "task_cancelled", blocked: "task_blocked", failed: "task_failed", closed: "task_complete", needs_reconciliation: "task_blocked" };
  lifecycleEvent(t.id, typeMap[f.status] ?? "task_updated", `Task ${f.status.replace("_", " ")}${logNote}`, f.status === "completed" ? "success" : ["failed", "blocked", "needs_reconciliation"].includes(f.status) ? "error" : "warning", { status: f.status, verification: f.verification });
  addMessage(fresh.chat_id, "assistant", "result", f.answer + logNote, t.id, { status: f.status, verification: f.verification, outcome: f.outcome, artifacts: f.artifacts ?? null, route: fresh.route, logFile: fresh.log_file, logStatus: f.logStatus });
  const done = getTask(t.id) ?? fresh;
  const dctx = taskContext(done);
  try {
    if (dctx.agentConversationId) recordAgentTaskResult(dctx.agentConversationId, done.id, f.status, f.answer);
    if (dctx.workflowRunId) recordWorkflowRunResult(dctx.workflowRunId, f.status);
  } catch {
    /* display bookkeeping must never break close-out */
  }
  // Whatever this task held is free now: start the next task in its workspace's line.
  if (done.route === "One" || done.route === "Studio") kickLine(done.route);
}

async function finishCancelled(t: TaskRow, where: string) {
  if (!t.route || t.route === "none" || !t.log_opened_at) {
    // Destination never became known: a cancelled routing decision is Orchestrator-only work.
    const file = logFileFor("none");
    try {
      await openLogEntry({ taskId: t.id, file, title: t.title, asked: t.request, route: `none — cancelled ${where}, before a destination was settled` });
      updateTask(t.id, { log_file: file, log_opened_at: nowIso() });
    } catch (e) {
      lifecycleEvent(t.id, "log_update_failed", `Markdown log update failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }
  await finish(getTask(t.id) ?? t, {
    status: "cancelled",
    logStatus: "abandoned",
    outcome: `Cancelled by the operator ${where}. No external side effect was executed.`,
    answer: "Cancelled. Nothing outward-facing was executed.",
    verification: "none",
  });
}

/** Called at boot for tasks whose driver died with HQ. Never marks anything complete. */
export async function reconcileTasksAfterRestart(): Promise<number> {
  // `in_line` is deliberately not listed: a waiting task never started anything, so it keeps its
  // place, and the boot kick (boot.ts) admits whoever is first.
  const rows = all<TaskRow>(`SELECT * FROM tasks WHERE status IN ('queued','routing','discovering','planning','dispatching','executing','verifying')`);
  for (const t of rows) {
    const ctx = taskContext(t);
    const ap = ctx.approvalId ? getApproval(ctx.approvalId) : null;
    const inFlight = (ap?.states ?? []).some((s) => s.state === "executing" || s.state === "ambiguous");
    const execRows = all<{ status: string }>("SELECT status FROM executions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1", [t.id]);
    const orphan = execRows[0]?.status === "needs_reconciliation";
    const status: TaskStatus = inFlight || orphan ? "needs_reconciliation" : "interrupted";
    updateTask(t.id, { status, ended_at: nowIso(), error: "HQ restarted while this task was active; its final state was not observed." });
    lifecycleEvent(t.id, "task_interrupted", status === "needs_reconciliation" ? "HQ restarted mid-run — side-effect state unknown; needs reconciliation" : "HQ restarted mid-run — task interrupted; outcome unknown", "warning");
    if (t.log_file && t.log_opened_at && !t.log_closed_at) {
      await safeNote(t, "Interrupted", `${nowIso()} — HQ restarted while this run was ${t.status}; outcome not observed${inFlight ? "; an approved action may or may not have executed" : ""}. Needs operator reconciliation.`);
    }
    if (ctx.agentLog && !ctx.agentLog.closed) {
      try {
        await appendLogNote(t.id, ctx.agentLog.file, "Interrupted", `${nowIso()} — HQ restarted while this run was ${t.status}; outcome not observed${inFlight ? "; an approved action may or may not have executed" : ""}. Needs operator reconciliation.`);
      } catch (e) {
        lifecycleEvent(t.id, "log_update_failed", `Agent log update failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    }
  }
  return rows.length;
}
