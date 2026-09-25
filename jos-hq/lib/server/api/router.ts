// The HQ HTTP API. Server-side only: the browser never receives credentials and there is no endpoint
// that runs arbitrary commands. Every mutation passes the CSRF guard; errors carry specific codes.
import { ensureBoot } from "../boot";
import { assertMutationAllowed, body, fail, ok } from "./http";
import { handleInternal } from "./internal";
import { sseResponse, taskEvents } from "../events";
import { all, get, parseJson } from "../db";
import { isWorkspaceId, loadConfig, josRoot, rolePolicy, type WorkspaceId } from "../env";
import { healthReport, verifyModels } from "../health";
import { discoverAll, discoverScope } from "../one/discovery";
import {
  answerClarification,
  approveTask,
  cancelTask,
  executePlan,
  kickLines,
  reconcileTask,
  rejectTask,
  submitTask,
} from "../orchestrator";
import { lineInfo } from "../queue";
import { chatMessages, createChat, deleteChat, getTask, listChats, renameChat, taskContext } from "../tasks";
import { approvalsForTask, getApproval, pendingApprovals } from "../approvals";
import { DispatchError, terminateOrphan, validateDispatchTarget } from "../dispatch";
import { activeSubAgents, attentionView, benchView, connectionsView, dashboardCircles, dryingLine, liveSystems, recentActivity, searchAll, taskMetrics, topConnectionsView, workflowsView, type Range, type SystemFilter } from "../views";
import {
  agentDeletable,
  agentEditState,
  agentNameTaken,
  conversationMessages,
  createAgentDefinition,
  createConversation,
  deleteAgentDefinition,
  draftAgentDefinition,
  draftAgentEdit,
  findAgent,
  listAgentsView,
  listConversations,
  migrateAgentDefinitions,
  sendAgentMessage,
  updateAgentDefinition,
  type AgentAnswers,
  type AgentChangeRefusal,
  type NewAgentAnswers,
} from "../agents";
import { inOrchestratorFolders } from "../agent-files";
import { suggestFrom, type AgentSuggestResponse } from "../agent-suggest";
import { runWorkflow } from "../workflows";
import { IssueError, draftIssue, fileIssue, filedIssue, issueEligible, issueRepo } from "../issues";
import { deleteUnusedAttachment, saveAttachment } from "../attachments";
import type { TaskMode } from "../executors/types";
import type { RouteSelection } from "../routing";

type Handler = (req: Request, params: Record<string, string>, url: URL) => Promise<Response> | Response;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  mutation: boolean;
}

const routes: Route[] = [];
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:[a-zA-Z]+/g, (m) => {
    keys.push(m.slice(1));
    return "([^/]+)";
  })}$`);
  routes.push({ method, pattern, keys, handler, mutation: method !== "GET" });
}

const MODES: TaskMode[] = ["manual", "edit", "plan", "auto"];
function mode(v: unknown): TaskMode {
  return MODES.includes(v as TaskMode) ? (v as TaskMode) : "auto";
}
function routeSel(v: unknown): RouteSelection {
  return v === "One" || v === "Studio" ? v : "auto";
}
function range(v: string | null): Range {
  return v === "today" || v === "30d" ? v : "7d";
}
function system(v: string | null): SystemFilter {
  return v === "One" || v === "Studio" ? v : "all";
}

// ---- runtime -------------------------------------------------------------------------------------

route("GET", "/api/runtime", async (_req, _p, url) => {
  const fresh = url.searchParams.get("fresh") === "1";
  const d = await discoverAll({ fresh });
  const cfg = loadConfig();
  const shape = (s: (typeof d)["root"]) => ({
    identity: s.identity,
    connections: (s.connections ?? []).map((c) => ({ platform: c.platform, name: c.name, state: c.state })),
    connectionsError: s.connectionsError,
    flows: s.flows?.map((f) => ({ key: f.key, name: f.name, description: f.description })) ?? null,
    flowsError: s.flowsError,
    discoveredAt: s.discoveredAt,
  });
  return ok({
    josRoot: josRoot(),
    root: shape(d.root),
    One: { ...shape(d.One), executor: cfg.workspaces.One.executor, planner: rolePolicy("One", "planner") },
    "Studio": { ...shape(d["Studio"]), executor: cfg.workspaces["Studio"].executor, planner: rolePolicy("Studio", "planner") },
  });
});
route("GET", "/api/runtime/health", async (_req, _p, url) => ok(await healthReport({ fresh: url.searchParams.get("fresh") === "1" })));
route("POST", "/api/runtime/health/refresh", async () => ok(await healthReport({ fresh: true })));
route("POST", "/api/runtime/verify-models", async () => ok(await verifyModels()));

// ---- chats ---------------------------------------------------------------------------------------

route("GET", "/api/chats", () => ok({ chats: listChats() }));
route("POST", "/api/chats", async (req) => {
  const b = await body<{ title?: string; purpose?: string }>(req);
  return ok({ chat: createChat(b.title?.trim() || "Untitled", b.purpose === "workflow" ? "workflow" : null) }, 201);
});
route("GET", "/api/chats/:id", (_req, p) => {
  const chat = get("SELECT * FROM chats WHERE id = ?", [p.id]);
  if (!chat) return fail(404, "CHAT_NOT_FOUND", "No such chat");
  const tasks = all<Record<string, unknown>>("SELECT * FROM tasks WHERE chat_id = ? ORDER BY created_at", [p.id]).map((t) => ({
    ...t,
    plan: parseJson(t.plan_json, null),
    result: parseJson(t.result_json, null),
    context: parseJson(t.context_json, {}),
    routeEvidence: parseJson(t.route_evidence_json, null),
    approvals: approvalsForTask(String(t.id)),
    executions: all("SELECT id, phase, workspace, cwd, runtime, model, effort, pid, status, verified, verified_model, verified_effort, started_at, ended_at, exit_code, error FROM executions WHERE task_id = ? ORDER BY created_at", [String(t.id)]),
    line: t.status === "in_line" ? lineInfo(String(t.id)) : null,
  }));
  const messages = chatMessages(p.id).map((m) => ({ ...m, data: parseJson(m.data_json, null) }));
  const attachments = all("SELECT id, task_id, original_name, size, created_at FROM attachments WHERE chat_id = ? ORDER BY created_at", [p.id]);
  return ok({ chat, messages, tasks, attachments });
});
route("PATCH", "/api/chats/:id", async (req, p) => {
  const b = await body<{ title?: string }>(req);
  if (!b.title?.trim()) return fail(400, "TITLE_REQUIRED", "Title is required");
  renameChat(p.id, b.title.trim());
  return ok({ renamed: true });
});
route("DELETE", "/api/chats/:id", (_req, p) => {
  const r = deleteChat(p.id);
  if (r.deleted) return ok({ deleted: true });
  if (r.reason === "not_found") return fail(404, "CHAT_NOT_FOUND", "No such chat");
  return fail(409, "CHAT_BUSY", "A task in this chat is still running, waiting on you, or needs reconciling. Stop or reconcile it first.", { tasks: r.tasks });
});
route("POST", "/api/chats/:id/messages", async (req, p) => {
  const b = await body<{ content?: string; route?: string; mode?: string; attachmentIds?: string[] }>(req);
  // Checked after the body is read, so a chat deleted meanwhile cannot gain a task.
  const chat = get("SELECT id FROM chats WHERE id = ?", [p.id]);
  if (!chat) return fail(404, "CHAT_NOT_FOUND", "No such chat");
  const content = String(b.content ?? "").trim();
  if (!content) return fail(400, "EMPTY_MESSAGE", "Message is empty");
  const waiting = get<{ id: string }>("SELECT id FROM tasks WHERE chat_id = ? AND status = 'needs_clarification' ORDER BY created_at DESC LIMIT 1", [p.id]);
  if (waiting && !(b.attachmentIds ?? []).length) {
    await answerClarification(waiting.id, content);
    return ok({ answered: waiting.id });
  }
  const t = submitTask({ chatId: p.id, text: content, routeSelection: routeSel(b.route), mode: mode(b.mode), attachmentIds: Array.isArray(b.attachmentIds) ? b.attachmentIds.map(String) : [] });
  return ok({ taskId: t.id }, 201);
});
route("POST", "/api/chats/:id/attachments", async (req, p) => {
  const form = await req.formData();
  if (!get("SELECT id FROM chats WHERE id = ?", [p.id])) return fail(404, "CHAT_NOT_FOUND", "No such chat");
  const saved = [];
  for (const v of form.getAll("file")) {
    if (typeof v === "string") continue;
    saved.push(await saveAttachment(p.id, v as File));
  }
  if (!saved.length) return fail(400, "NO_FILE", "No file in the upload");
  return ok({ attachments: saved }, 201);
});
route("DELETE", "/api/attachments/:id", (_req, p) => (deleteUnusedAttachment(p.id) ? ok({ deleted: true }) : fail(409, "ATTACHMENT_IN_USE", "Attachment is already part of a task or does not exist")));

// ---- tasks ---------------------------------------------------------------------------------------

route("GET", "/api/tasks/:id", (_req, p) => {
  const t = getTask(p.id);
  if (!t) return fail(404, "TASK_NOT_FOUND", "No such task");
  return ok({
    task: { ...t, plan: parseJson(t.plan_json, null), result: parseJson(t.result_json, null), context: taskContext(t), routeEvidence: parseJson(t.route_evidence_json, null), line: t.status === "in_line" ? lineInfo(t.id) : null },
    executions: all("SELECT * FROM executions WHERE task_id = ? ORDER BY created_at", [p.id]).map((e) => ({ ...e, gateway_token_hash: undefined })),
    approvals: approvalsForTask(p.id),
    usage: all("SELECT platform, connection_name, category, decision, method, path, ok, created_at FROM connection_usage WHERE task_id = ? ORDER BY id", [p.id]),
  });
});
route("GET", "/api/tasks/:id/events", (req, p) => sseResponse(req, { taskId: p.id, replay: true }));
route("GET", "/api/tasks/:id/events.json", (_req, p, url) => ok({ events: taskEvents(p.id, Number(url.searchParams.get("after") ?? 0) || 0) }));
route("POST", "/api/tasks/:id/cancel", async (req, p) => {
  const b = await body<{ force?: boolean }>(req);
  const r = await cancelTask(p.id, !!b.force);
  return r.ok ? ok(r) : fail(409, "CANCEL_NEEDS_CONFIRMATION", r.detail);
});
route("POST", "/api/tasks/:id/clarify", async (req, p) => {
  const b = await body<{ answer?: string }>(req);
  await answerClarification(p.id, String(b.answer ?? ""));
  return ok({ answered: true });
});
route("POST", "/api/tasks/:id/execute-plan", async (req, p) => {
  const b = await body<{ mode?: string }>(req);
  const t = executePlan(p.id, mode(b.mode ?? "auto"));
  return ok({ taskId: t.id }, 201);
});
route("POST", "/api/tasks/:id/reconcile", async (req, p) => {
  const b = await body<{ logStatus?: string; note?: string }>(req);
  const ls = ["done", "blocked", "abandoned", "partial"].includes(String(b.logStatus)) ? (b.logStatus as "done") : null;
  if (!ls || !b.note?.trim()) return fail(400, "RECONCILE_INPUT", "Choose a log status (done, blocked, abandoned, partial) and describe what actually happened.");
  await reconcileTask(p.id, ls, b.note.trim());
  return ok({ reconciled: true });
});
// Submit issue: failed and blocked tasks can be reported to the configured public repository.
function issueFail(e: unknown): Response {
  if (e instanceof IssueError) return fail(e.status, e.code, e.message, e.extra);
  throw e;
}
route("GET", "/api/tasks/:id/issue", (_req, p) => {
  const t = getTask(p.id);
  if (!t) return fail(404, "TASK_NOT_FOUND", "No such task");
  const repo = issueRepo();
  return ok({ enabled: !!repo, repo: repo ? `${repo.owner}/${repo.repo}` : null, eligible: issueEligible(t), issue: filedIssue(p.id) });
});
route("GET", "/api/tasks/:id/issue/draft", async (_req, p) => {
  try {
    return ok({ draft: await draftIssue(p.id) });
  } catch (e) {
    return issueFail(e);
  }
});
route("POST", "/api/tasks/:id/issue", async (req, p) => {
  const b = await body<{ title?: string; body?: string }>(req);
  try {
    return ok({ issue: await fileIssue(p.id, { title: b.title, body: b.body }) }, 201);
  } catch (e) {
    return issueFail(e);
  }
});
route("POST", "/api/executions/:id/terminate-orphan", async (_req, p) => {
  const r = await terminateOrphan(p.id);
  // The orphan held its workspace. Even a failed kill marks it interrupted, so the line may move either way.
  kickLines();
  return ok(r);
});

// ---- live stream, dashboard, search --------------------------------------------------------------

route("GET", "/api/stream", (req) => sseResponse(req, { replay: false, signals: true, visibility: "chat" }));
route("GET", "/api/dashboard", (_req, _p, url) => {
  const sys = system(url.searchParams.get("system"));
  const r = range(url.searchParams.get("range"));
  const topTab = url.searchParams.get("top");
  const subTab = url.searchParams.get("subs");
  return ok({
    metrics: taskMetrics(sys, r),
    live: liveSystems(),
    bench: benchView(),
    drying: dryingLine(sys, r),
    circles: dashboardCircles(sys, r),
    topConnections: topConnectionsView(topTab === "One" || topTab === "Studio" ? topTab : "overall", r),
    activeSubAgents: activeSubAgents(subTab === "One" || subTab === "Studio" ? subTab : "all"),
    recentActivity: recentActivity(sys, r),
    pendingApprovals: pendingApprovals().map((a) => ({ id: a.id, taskId: a.taskId, summary: a.summary, createdAt: a.createdAt })),
  });
});
route("GET", "/api/search", (_req, _p, url) => ok(searchAll(url.searchParams.get("q") ?? "")));
route("GET", "/api/attention", () => ok({ items: attentionView() }));

// ---- agents --------------------------------------------------------------------------------------

function ws(v: string): WorkspaceId {
  if (!isWorkspaceId(v)) throw new DispatchError("INVALID_WORKSPACE", `Unknown workspace "${v}" (One or Studio)`);
  return v;
}
/** The two answers from a request body; a connection name cannot carry a line break into the definition. */
function agentAnswers(b: Partial<AgentAnswers>): AgentAnswers {
  const line = (v: unknown) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();
  return {
    connections: (Array.isArray(b.connections) ? b.connections : []).filter((c) => c && c.platform && c.name).map((c) => ({ platform: line(c.platform), name: line(c.name) })),
    purpose: String(b.purpose ?? ""),
    mayDo: String(b.mayDo ?? ""),
    mustNever: String(b.mustNever ?? ""),
  };
}
route("GET", "/api/agents", (_req, _p, url) => {
  const w = url.searchParams.get("workspace");
  const list = w ? listAgentsView(ws(w)) : [...listAgentsView("One"), ...listAgentsView("Studio")];
  return ok({ agents: list.map((a) => ({ ...a, instructions: undefined, writable: inOrchestratorFolders(a.file) })) });
});
route("POST", "/api/agents/draft", async (req) => {
  const b = await body<NewAgentAnswers>(req);
  return ok(draftAgentDefinition({ ...b, workspace: ws(String(b.workspace)) }));
});
// New agent's suggestions (spec 3.3–3.4): read-only, from cached live discovery; a POST only for its body.
route("POST", "/api/agents/suggest", async (req) => {
  const b = await body<{ workspace?: string; purpose?: string; name?: string }>(req);
  const w = ws(String(b.workspace));
  const d = await discoverScope(w);
  const pin = rolePolicy(w, "planner");
  const r: AgentSuggestResponse = { ...suggestFrom({ workspace: w, purpose: String(b.purpose ?? ""), name: String(b.name ?? "") }, d.connections ?? [], d.connectionsError, (k) => agentNameTaken(w, k)), planner: { modelLabel: pin.modelLabel, effort: pin.effort } };
  return ok(r);
});
route("POST", "/api/agents", async (req) => {
  const b = await body<NewAgentAnswers & { confirm?: boolean }>(req);
  if (!b.confirm) return fail(400, "CONFIRM_REQUIRED", "Review the drafted definition and confirm to write it.");
  return ok(createAgentDefinition({ ...b, workspace: ws(String(b.workspace)) }), 201);
});
// Old-format definitions → minimal definition + SOP.md + LOGS.md (spec 3.8). Safe to repeat.
route("POST", "/api/agents/migrate", () => ok({ results: migrateAgentDefinitions() }));
route("GET", "/api/agents/:workspace/:agent", (_req, p) => {
  const a = findAgent(ws(p.workspace), decodeURIComponent(p.agent));
  return a ? ok({ agent: a, edit: agentEditState(a), deletable: agentDeletable(a) }) : fail(404, "AGENT_NOT_FOUND", `No sub-agent ${p.agent} configured for ${p.workspace}`);
});
function agentRefusal(r: AgentChangeRefusal, p: Record<string, string>): Response {
  if (r.reason === "not_found") return fail(404, "AGENT_NOT_FOUND", `No sub-agent ${p.agent} configured for ${p.workspace}`);
  if (r.reason === "read_only") return fail(409, "AGENT_READ_ONLY", r.message);
  if (r.reason === "changed") return fail(409, "AGENT_CHANGED", "This definition changed on disk after you opened it. Reload this page to start from the current file.");
  return fail(409, "AGENT_BUSY", "A task of this agent is still running, waiting on you, or needs reconciling. Stop or reconcile it first.", { tasks: r.tasks });
}
route("POST", "/api/agents/:workspace/:agent/draft", async (req, p) => {
  const b = await body<AgentAnswers>(req);
  return ok(draftAgentEdit(ws(p.workspace), decodeURIComponent(p.agent), agentAnswers(b)));
});
route("PATCH", "/api/agents/:workspace/:agent", async (req, p) => {
  const b = await body<AgentAnswers & { baseHash?: string; confirm?: boolean }>(req);
  if (!b.confirm) return fail(400, "CONFIRM_REQUIRED", "Review the drafted definition and confirm to save it.");
  const r = updateAgentDefinition(ws(p.workspace), decodeURIComponent(p.agent), agentAnswers(b), String(b.baseHash ?? ""));
  return r.updated ? ok(r) : agentRefusal(r, p);
});
route("DELETE", "/api/agents/:workspace/:agent", (_req, p) => {
  const r = deleteAgentDefinition(ws(p.workspace), decodeURIComponent(p.agent));
  return r.deleted ? ok(r) : agentRefusal(r, p);
});
route("GET", "/api/agents/:workspace/:agent/conversations", (_req, p) => ok({ conversations: listConversations(ws(p.workspace), decodeURIComponent(p.agent)) }));
route("POST", "/api/agents/:workspace/:agent/conversations", async (req, p) => {
  const b = await body<{ title?: string }>(req);
  return ok({ conversation: createConversation(ws(p.workspace), decodeURIComponent(p.agent), b.title) }, 201);
});
route("GET", "/api/agents/:workspace/:agent/conversations/:id", (_req, p) => ok({ messages: conversationMessages(p.id) }));
route("POST", "/api/agents/:workspace/:agent/conversations/:id/messages", async (req, p) => {
  const b = await body<{ content?: string; mode?: string }>(req);
  const t = sendAgentMessage(p.id, String(b.content ?? ""), mode(b.mode));
  return ok({ taskId: t.id }, 201);
});

// ---- connections, workflows, approvals, dispatch ---------------------------------------------------

route("GET", "/api/connections", async (_req, _p, url) => ok(await connectionsView(url.searchParams.get("fresh") === "1")));
route("GET", "/api/workflows", async (_req, _p, url) => ok(await workflowsView(url.searchParams.get("fresh") === "1")));
route("POST", "/api/workflows/:id/run", async (req, p) => {
  const b = await body<{ mode?: string; inputs?: Record<string, string> }>(req);
  return ok(await runWorkflow(decodeURIComponent(p.id), mode(b.mode), b.inputs ?? {}), 201);
});
route("GET", "/api/approvals", () => ok({ approvals: pendingApprovals() }));
route("GET", "/api/approvals/:id", (_req, p) => {
  const a = getApproval(p.id);
  return a ? ok({ approval: a, task: getTask(a.taskId) ?? null }) : fail(404, "APPROVAL_NOT_FOUND", "No such approval");
});
route("POST", "/api/approvals/:id/approve", async (req, p) => {
  const b = await body<{ note?: string }>(req);
  await approveTask(p.id, b.note ?? null);
  return ok({ approved: true });
});
route("POST", "/api/approvals/:id/reject", async (req, p) => {
  const b = await body<{ note?: string }>(req);
  await rejectTask(p.id, b.note ?? null);
  return ok({ rejected: true });
});
// The jos CLI client: the root Orchestrator session dispatches through HQ, never directly.
route("POST", "/api/dispatch", async (req) => {
  const b = await body<{ to?: string; prompt?: string; title?: string; mode?: string; origin?: { cwd?: string; executorExecutionId?: string | null } }>(req);
  const target = validateDispatchTarget({ workspace: String(b.to), origin: { kind: "cli", cwd: b.origin?.cwd ?? null, executorExecutionId: b.origin?.executorExecutionId ?? null } });
  const brief = String(b.prompt ?? "").trim();
  if (brief.length < 40) return fail(400, "PROMPT_TOO_THIN", "An executor prompt must be self-contained (CLAUDE.md §5); \"handle this\" is not a handoff.");
  const m = mode(b.mode);
  if (m === "plan") return fail(400, "PLAN_MODE_DISPATCH", "Plan mode never dispatches an executor.");
  const chat = createChat(b.title?.trim() || `jos dispatch → ${target}`);
  const t = submitTask({
    chatId: chat.id,
    text: b.title?.trim() || brief.split("\n").find((l) => l.trim())!.slice(0, 200),
    displayText: `jos dispatch --to ${target}${b.title?.trim() ? ` — ${b.title.trim()}` : ""}`,
    routeSelection: target,
    mode: m,
    origin: "cli",
    orchestratorBrief: brief,
    title: b.title?.trim(),
  });
  return ok({ taskId: t.id, chatId: chat.id }, 201);
});

// ---- dispatch ---------------------------------------------------------------------------------------

export async function handleApi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const internal = await handleInternal(req, url.pathname);
  if (internal) return internal;
  await ensureBoot();
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (!m) continue;
    if (r.mutation) {
      const guard = assertMutationAllowed(req);
      if (guard) return guard;
    }
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    try {
      return await r.handler(req, params, url);
    } catch (e) {
      if (e instanceof DispatchError) return fail(["IDENTITY_MISMATCH", "RUNTIME_UNAVAILABLE", "MODEL_UNVERIFIED", "WORKSPACE_BUSY"].includes(e.code) ? 409 : 400, e.code, e.message, e.details);
      const msg = e instanceof Error ? e.message : String(e);
      return fail(422, "REQUEST_FAILED", msg);
    }
  }
  return fail(404, "NOT_FOUND", `No API route ${req.method} ${url.pathname}`);
}
