// Read models for the command-center pages. Everything here is derived from live discovery or from
// HQ telemetry that recorded something that actually happened. Nothing is seeded or inferred.
import { all, get, parseJson } from "./db";
import { loadConfig, rolePolicy, workspaceRoot, type WorkspaceId } from "./env";
import { cachedDiscovery, discoverScope, type ScopeDiscovery } from "./one/discovery";
import { runningExecutions } from "./dispatch";
import { lastUsedByPlatform, topConnections } from "./telemetry";
import { listAgentDefinitions, listAgentsView } from "./agents";
import { ACTIVE_STATUSES, WAITING_STATUSES, getTask, listChats, taskContext } from "./tasks";
import { lineFor, workspaceHolders, type Holder } from "./queue";

export type Range = "today" | "7d" | "30d";
export type SystemFilter = "all" | WorkspaceId;

export function sinceFor(range: Range): string {
  const d = new Date();
  if (range === "today") {
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  return new Date(Date.now() - (range === "7d" ? 7 : 30) * 86400_000).toISOString();
}

function systemWhere(system: SystemFilter, col = "route"): { sql: string; params: string[] } {
  if (system === "all") return { sql: `${col} IN ('One','Studio')`, params: [] };
  return { sql: `${col} = ?`, params: [system] };
}

export function taskMetrics(system: SystemFilter, range: Range) {
  const sw = systemWhere(system);
  const rows = all<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM tasks WHERE origin != 'probe' AND ${sw.sql} AND created_at >= ? GROUP BY status`,
    [...sw.params, sinceFor(range)],
  );
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
  const sum = (...k: string[]) => k.reduce((a, s) => a + (by[s] ?? 0), 0);
  const total = rows.reduce((a, r) => a + r.n, 0);
  return {
    total,
    completed: sum("completed"),
    paused: sum("needs_clarification", "awaiting_approval"),
    discontinued: sum("cancelled", "rejected"),
    byStatus: by,
  };
}

function cachedHealth(): { executors?: Record<WorkspaceId, { dispatchable: boolean; blockers: string[] }> } | null {
  return (globalThis as unknown as { __josHealth?: { report: { executors: Record<WorkspaceId, { dispatchable: boolean; blockers: string[] }> } } }).__josHealth?.report ?? null;
}

const ORCH_STATE: Record<string, string> = {
  queued: "Working",
  routing: "Working",
  discovering: "Working",
  in_line: "Waiting",
  planning: "Planning",
  dispatching: "Working",
  executing: "Waiting",
  verifying: "Verifying",
  awaiting_approval: "Waiting",
  needs_clarification: "Waiting",
};

export function liveSystems() {
  const active = all<{ id: string; title: string; status: string; stage: string; route: string | null; route_reason: string | null; created_at: string; updated_at: string; planner_model: string | null }>(
    `SELECT id, title, status, stage, route, route_reason, created_at, updated_at, planner_model FROM tasks
     WHERE status IN ('queued','routing','discovering','in_line','planning','dispatching','executing','verifying','awaiting_approval','needs_clarification')
     ORDER BY updated_at DESC`,
  );
  const lead = active[0] ?? null;
  const plannerEvent = lead
    ? get<{ type: string; summary: string }>("SELECT type, summary FROM events WHERE task_id = ? AND type IN ('planning_started','planning_complete','planning_failed') ORDER BY id DESC LIMIT 1", [lead.id])
    : undefined;
  const orchestrator = lead
    ? {
        state: ORCH_STATE[lead.status] ?? "Working",
        taskId: lead.id,
        task: lead.title,
        stage: lead.stage,
        route: lead.route,
        routeReason: lead.route_reason,
        planner: plannerEvent ? plannerEvent.summary : lead.planner_model ? `Planned by ${lead.planner_model}` : "not started",
        activeTasks: active.length,
      }
    : { state: "Idle", taskId: null, task: null, stage: null, route: null, routeReason: null, planner: null, activeTasks: 0 };

  const running = runningExecutions();
  const health = cachedHealth();
  const cfg = loadConfig();

  const executorCard = (ws: WorkspaceId): ExecutorCard => {
    const policy = {
      runtimeLabel: cfg.workspaces[ws].executor.runtimeLabel,
      modelLabel: cfg.workspaces[ws].executor.modelLabel,
      model: cfg.workspaces[ws].executor.model,
      effort: cfg.workspaces[ws].executor.effort,
      workspacePath: workspaceRoot(ws),
    };
    const inLine = lineFor(ws).length;
    const mine = running.filter((x) => x.workspace === ws);
    const r = mine[0];
    if (r) {
      const row = get<{ runtime: string }>("SELECT runtime FROM executions WHERE id = ?", [r.id]);
      const task = get<{ title: string; stage: string }>("SELECT title, stage FROM tasks WHERE id = ?", [r.taskId]);
      return {
        policy,
        state: task?.stage === "verify" ? "Verifying" : "Working",
        taskId: r.taskId,
        task: task?.title ?? null,
        phase: r.phase,
        runtime: row?.runtime ?? null,
        runningCount: mine.length,
        inLine,
        blocker: null,
      };
    }
    const waiting = all<{ id: string; title: string; status: string }>(
      "SELECT id, title, status FROM tasks WHERE route = ? AND status IN ('awaiting_approval','needs_clarification') ORDER BY updated_at DESC LIMIT 1",
      [ws],
    )[0];
    const h = health?.executors?.[ws];
    const base = { policy, phase: null, runtime: null, runningCount: 0, inLine };
    if (h && !h.dispatchable) return { ...base, state: "Blocked", taskId: null, task: null, blocker: h.blockers[0] ?? "not dispatchable" };
    if (waiting) return { ...base, state: waiting.status === "awaiting_approval" ? "Paused" : "Waiting", taskId: waiting.id, task: waiting.title, blocker: null };
    return { ...base, state: "Idle", taskId: null, task: null, blocker: null };
  };

  return { orchestrator, executors: { One: executorCard("One"), "Studio": executorCard("Studio") } };
}

export interface ExecutorCard {
  policy: { runtimeLabel: string; modelLabel: string; model: string; effort: string; workspacePath: string };
  state: string;
  taskId: string | null;
  task: string | null;
  phase: string | null;
  runtime: string | null;
  runningCount: number;
  inLine: number;
  blocker: string | null;
}

export function topConnectionsView(tab: "overall" | WorkspaceId, range: Range) {
  const rows = topConnections({ workspace: tab === "overall" ? null : tab, sinceIso: sinceFor(range), limit: 5 });
  return rows.map((r, i) => ({ rank: i + 1, platform: r.platform, tool: toolLabel(r.platform), workspaces: String(r.workspace ?? "").split(","), calls: r.calls, lastUsed: r.last_used }));
}

export function activeSubAgents(tab: "all" | WorkspaceId) {
  const params: string[] = [];
  let where = "s.status = 'running'";
  if (tab !== "all") {
    where += " AND s.workspace = ?";
    params.push(tab);
  }
  const execSubs = all<{ agent: string; workspace: string; description: string | null; started_at: string; title: string | null; task_id: string | null }>(
    `SELECT s.agent, s.workspace, s.description, s.started_at, t.title, s.task_id FROM subagent_invocations s LEFT JOIN tasks t ON t.id = s.task_id WHERE ${where} ORDER BY s.started_at DESC`,
    params,
  );
  const agentTasks = all<{ id: string; title: string; status: string; created_at: string; context_json: string }>(
    `SELECT id, title, status, created_at, context_json FROM tasks WHERE origin = 'agent' AND status IN ('queued','routing','discovering','in_line','planning','dispatching','executing','verifying','awaiting_approval','needs_clarification')${tab !== "all" ? " AND route = ?" : ""}`,
    tab !== "all" ? [tab] : [],
  );
  return [
    ...agentTasks.map((t) => {
      const ctx = parseJson<{ agent?: { name: string; workspace: string } }>(t.context_json, {});
      return { agent: ctx.agent?.name ?? "sub-agent", workspace: ctx.agent?.workspace ?? "", task: t.title, taskId: t.id, status: t.status === "awaiting_approval" ? "Waiting" : "Working", since: t.created_at, source: "HQ sub-agent" };
    }),
    ...execSubs.map((s) => ({ agent: s.agent, workspace: s.workspace, task: s.title ?? s.description ?? "", taskId: s.task_id, status: "Working", since: s.started_at, source: "executor sub-agent" })),
  ];
}

const ACTIVITY_TYPES = [
  "task_created",
  "route_decision",
  "identity_verified",
  "identity_mismatch",
  "planning_started",
  "planning_complete",
  "planning_failed",
  "executor_started",
  "executor_result",
  "launch_verified",
  "launch_verification_failed",
  "subagent_started",
  "connection_used",
  "gateway_blocked",
  "approval_required",
  "approval_resolved",
  "approved_action_succeeded",
  "approved_action_failed",
  "approved_action_ambiguous",
  "verification_passed",
  "verification_failed",
  "task_complete",
  "task_blocked",
  "task_cancelled",
  "task_failed",
  "task_interrupted",
  "log_opened",
  "log_closed",
  "runtime_verification",
];

/**
 * What an event's own record says it cost, in USD: a Claude Code run's `total_cost_usd` (list price;
 * planning sessions included), or `usage.cost` summed over the attempts of an old OpenRouter planner
 * event. Codex reports no cost, and nothing is estimated from tokens, so every other event carries none.
 */
function reportedCost(type: string, dataJson: string | null): number | null {
  if (type === "executor_result") {
    const c = parseJson<{ costUsd?: unknown }>(dataJson, {}).costUsd;
    return typeof c === "number" ? c : null;
  }
  // planning_complete carries { model, attempts }; planning_failed carries the attempts themselves.
  const d = parseJson<unknown>(dataJson, null);
  const attempts = Array.isArray(d) ? d : (d as { attempts?: unknown } | null)?.attempts;
  if (!Array.isArray(attempts)) return null;
  const costs = attempts.map((a) => (a as { usage?: { cost?: unknown } } | null)?.usage?.cost).filter((c): c is number => typeof c === "number");
  return costs.length ? costs.reduce((a, b) => a + b, 0) : null;
}

export function recentActivity(system: SystemFilter, range: Range, limit = 40) {
  const params: (string | number)[] = [sinceFor(range)];
  let where = `created_at >= ? AND type IN (${ACTIVITY_TYPES.map(() => "?").join(",")})`;
  params.push(...ACTIVITY_TYPES);
  if (system !== "all") {
    where += " AND (system = ? OR task_id IN (SELECT id FROM tasks WHERE route = ?))";
    params.push(system, system);
  }
  params.push(limit);
  return all<{ id: number; created_at: string; system: string | null; type: string; level: string; summary: string; task_id: string | null; data_json: string | null }>(
    `SELECT id, created_at, system, type, level, summary, task_id,
            CASE WHEN type IN ('executor_result','planning_complete','planning_failed') THEN data_json END AS data_json
     FROM events WHERE ${where} ORDER BY id DESC LIMIT ?`,
    params,
  ).map((e) => ({ id: e.id, time: e.created_at, system: e.system === "orchestrator" || e.system === "hq" ? "Orchestrator" : e.system ?? "Orchestrator", event: e.summary, type: e.type, status: e.level, taskId: e.task_id, cost: e.data_json ? reportedCost(e.type, e.data_json) : null }));
}

// ---- J3 Connections ----------------------------------------------------------------------------

const TOOL_LABELS: Record<string, string> = {
  gmail: "Gmail",
  slack: "Slack",
  stripe: "Stripe",
  notion: "Notion",
  "open-router": "OpenRouter",
  firecrawl: "Firecrawl",
  tavily: "Tavily",
  exa: "Exa",
  "google-drive": "Google Drive",
  "google-calendar": "Google Calendar",
};
export function toolLabel(platform: string): string {
  return TOOL_LABELS[platform] ?? platform.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export async function connectionsView(fresh: boolean) {
  const scopes = await Promise.all([discoverScope("root", { fresh }), discoverScope("One", { fresh }), discoverScope("Studio", { fresh })]);
  const byPlatform = new Map<string, { platform: string; scopes: Set<string>; conns: Array<{ scope: string; name: string; state: string }> }>();
  const errors: string[] = [];
  const label = (s: ScopeDiscovery) => (s.scope === "root" ? "Orchestrator" : s.scope);
  for (const s of scopes) {
    if (!s.connections) {
      errors.push(`${label(s)}: ${s.connectionsError ?? "connection discovery failed"}`);
      continue;
    }
    for (const c of s.connections) {
      const e = byPlatform.get(c.platform) ?? { platform: c.platform, scopes: new Set(), conns: [] };
      e.scopes.add(label(s));
      e.conns.push({ scope: label(s), name: c.name, state: c.state });
      byPlatform.set(c.platform, e);
    }
  }
  const used = lastUsedByPlatform();
  const rows = [...byPlatform.values()].map((e) => {
    const order = ["One", "Studio", "Orchestrator"];
    const agents = order.filter((o) => e.scopes.has(o));
    const wsKeys = agents.map((a) => (a === "Orchestrator" ? "root" : a));
    const lastUsed = used.filter((u) => u.platform === e.platform && wsKeys.includes(u.workspace)).map((u) => u.last_used).sort().pop() ?? null;
    return {
      tool: toolLabel(e.platform),
      platform: e.platform,
      agents,
      agentLabel: agents.join(" + "),
      status: e.conns.every((c) => c.state === "operational") ? "Operational" : "Down",
      lastUsed,
      connections: e.conns,
    };
  });
  rows.sort((a, b) => a.tool.localeCompare(b.tool));
  return { rows, errors, discoveredAt: scopes.map((s) => s.discoveredAt).sort()[0] };
}

// ---- J4 Workflows ------------------------------------------------------------------------------

export async function workflowsView(fresh: boolean) {
  const scopes = await Promise.all([discoverScope("One", { fresh }), discoverScope("Studio", { fresh })]);
  const errors: string[] = [];
  const flows = scopes.flatMap((s) => {
    if (!s.flows) {
      errors.push(`${s.scope}: ${s.flowsError ?? "flow discovery failed"}`);
      return [];
    }
    return s.flows.map((f) => {
      const last = get<{ status: string; created_at: string }>("SELECT status, created_at FROM workflow_runs WHERE workspace = ? AND flow_key = ? ORDER BY created_at DESC LIMIT 1", [s.scope, f.key]);
      return { id: `${s.scope}:${f.key}`, key: f.key, name: f.name || f.key, owner: s.scope as WorkspaceId, description: f.description, status: last?.status ?? "Never run", lastRun: last?.created_at ?? null, requiresBash: !!f.raw.requiresBash, inputs: f.raw.inputs ?? null };
    });
  });
  return { flows, errors };
}

// ---- Global search (local data and cached discovery only; never triggers a platform call) --------

export function searchAll(q: string) {
  const needle = q.trim().toLowerCase();
  if (!needle) return { chats: [], agents: [], connections: [], workflows: [] };
  const chats = listChats()
    .filter((c) => c.title.toLowerCase().includes(needle) || (c.preview ?? "").toLowerCase().includes(needle))
    .slice(0, 8)
    .map((c) => ({ id: c.id, title: c.title, preview: c.preview }));
  const agents = listAgentDefinitions()
    .filter((a) => a.name.toLowerCase().includes(needle) || a.description.toLowerCase().includes(needle))
    .slice(0, 8)
    .map((a) => ({ key: a.key, name: a.name, workspace: a.workspace, description: a.description }));
  const connections: Array<{ tool: string; platform: string; scope: string; name: string }> = [];
  const workflows: Array<{ id: string; name: string; owner: string }> = [];
  for (const scope of ["root", "One", "Studio"] as const) {
    const d = cachedDiscovery(scope);
    for (const c of d?.connections ?? []) {
      if (c.platform.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle) || toolLabel(c.platform).toLowerCase().includes(needle)) {
        connections.push({ tool: toolLabel(c.platform), platform: c.platform, scope: scope === "root" ? "Orchestrator" : scope, name: c.name });
      }
    }
    if (scope !== "root") {
      for (const f of d?.flows ?? []) {
        if (f.key.toLowerCase().includes(needle) || f.name.toLowerCase().includes(needle)) workflows.push({ id: `${scope}:${f.key}`, name: f.name || f.key, owner: scope });
      }
    }
  }
  return { chats, agents, connections: connections.slice(0, 10), workflows: workflows.slice(0, 8) };
}

// ---- Needs you (the top-bar chip, spec 2.1 and Part 4) ------------------------------------------

export interface AttentionItem {
  taskId: string;
  title: string;
  route: string | null;
  kind: "approval" | "question" | "reconcile";
  since: string;
  href: string;
}

const ATTENTION_KIND: Record<string, AttentionItem["kind"]> = {
  awaiting_approval: "approval",
  needs_clarification: "question",
  needs_reconciliation: "reconcile",
  interrupted: "reconcile",
};

/** Everything waiting on the operator, oldest first. Read-only. */
export function attentionView(): AttentionItem[] {
  const items: AttentionItem[] = all<{ id: string; chat_id: string | null; title: string; route: string | null; status: string; updated_at: string }>(
    `SELECT id, chat_id, title, route, status, updated_at FROM tasks
      WHERE origin != 'probe' AND status IN (${Object.keys(ATTENTION_KIND).map(() => "?").join(",")})
      ORDER BY updated_at, rowid`,
    Object.keys(ATTENTION_KIND),
  ).map((t) => ({ taskId: t.id, title: t.title, route: t.route, kind: ATTENTION_KIND[t.status], since: t.updated_at, href: t.chat_id ? `/chat/${t.chat_id}` : `/tasks/${t.id}` }));
  // An orphaned executor still needs terminating or reconciling after its task has ended.
  const orphans = all<{ task_id: string; title: string | null; workspace: string; created_at: string }>(
    `SELECT e.task_id, t.title, e.workspace, e.created_at FROM executions e LEFT JOIN tasks t ON t.id = e.task_id
      WHERE e.status = 'needs_reconciliation' ORDER BY e.created_at, e.rowid`,
  );
  for (const o of orphans) {
    if (items.some((i) => i.taskId === o.task_id)) continue;
    items.push({ taskId: o.task_id, title: o.title ?? o.task_id, route: o.workspace, kind: "reconcile", since: o.created_at, href: `/tasks/${o.task_id}` });
  }
  return items;
}

// ---- J1 bench and drying line (spec 2.2 and Part 4) ---------------------------------------------

export interface BayHolder {
  kind: Holder["kind"];
  taskId: string | null;
  chatId: string | null;
  title: string;
  status: string;
  mode: string | null;
  stage: string | null;
  /** When the holder was admitted to the workspace (or created, for an orphan's task). */
  since: string | null;
  /** HQ's time limit for the phase it is in, when there is one (planning: limits.planTimeoutMs). */
  limitMs: number | null;
  /** What it waits on, in the product's words; null when it waits on nothing. */
  waitingOn: string | null;
  approvalId: string | null;
  executions: Array<{ phase: string; status: string }>;
  approvals: Array<{ status: string }>;
}

export interface BayView {
  workspace: WorkspaceId;
  executor: { runtimeLabel: string; modelLabel: string; model: string; effort: string };
  planner: { modelLabel: string; model: string; effort: string };
  state: "Idle" | "Working" | "Waiting" | "Blocked";
  blocker: string | null;
  holder: BayHolder | null;
  line: Array<{ taskId: string; chatId: string | null; title: string; mode: string; sentAt: string }>;
}

const NEEDS_OPERATOR = ["awaiting_approval", "needs_clarification", "needs_reconciliation", "interrupted"];

function bayHolder(h: Holder, planLimitMs: number): BayHolder {
  if (h.kind === "reserved" || !h.taskId) {
    return { kind: h.kind, taskId: null, chatId: null, title: h.title, status: h.status, mode: null, stage: null, since: null, limitMs: null, waitingOn: null, approvalId: null, executions: [], approvals: [] };
  }
  const t = getTask(h.taskId);
  const executions = all<{ phase: string; status: string }>("SELECT phase, status FROM executions WHERE task_id = ? ORDER BY created_at, rowid", [h.taskId]);
  const approvals = all<{ id: string; status: string; actions_json: string }>("SELECT id, status, actions_json FROM approvals WHERE task_id = ? ORDER BY created_at, rowid", [h.taskId]);
  // An orphaned executor holds the bay after its task ended; what the operator must do is reconcile it.
  const status = h.kind === "execution" && h.status === "needs_reconciliation" ? "needs_reconciliation" : t?.status ?? h.status;
  const pending = approvals.find((a) => a.status === "pending");
  let waitingOn: string | null = null;
  if (status === "awaiting_approval" && pending) {
    const count = parseJson<unknown[]>(pending.actions_json, []).length;
    waitingOn = `${count} action${count === 1 ? "" : "s"} to approve`;
  } else if (status === "needs_clarification") {
    waitingOn = (t ? taskContext(t).pendingQuestion?.question : null) ?? "an answer";
  } else if (status === "needs_reconciliation" || status === "interrupted") {
    waitingOn = h.kind === "execution" ? "an orphaned executor: terminate or reconcile it" : "reconciliation";
  }
  return {
    kind: h.kind,
    taskId: h.taskId,
    chatId: t?.chat_id ?? null,
    title: t?.title ?? h.title,
    status,
    mode: t?.mode ?? null,
    stage: t?.stage ?? null,
    since: t?.admitted_at ?? t?.created_at ?? null,
    limitMs: status === "planning" ? planLimitMs : null,
    waitingOn,
    approvalId: pending?.id ?? null,
    executions,
    approvals: approvals.map((a) => ({ status: a.status })),
  };
}

/** Each workspace's bay: its pins, what holds it, its line, and a blocker from Runtime Health. Read-only. */
export function benchView(): Record<WorkspaceId, BayView> {
  const cfg = loadConfig();
  const health = cachedHealth();
  const bay = (ws: WorkspaceId): BayView => {
    const e = cfg.workspaces[ws].executor;
    const p = rolePolicy(ws, "planner");
    const first = workspaceHolders(ws)[0];
    const holder = first ? bayHolder(first, cfg.limits.planTimeoutMs) : null;
    const h = health?.executors?.[ws];
    const blocker = h && !h.dispatchable ? h.blockers[0] ?? "not dispatchable" : null;
    return {
      workspace: ws,
      executor: { runtimeLabel: e.runtimeLabel, modelLabel: e.modelLabel, model: e.model, effort: e.effort },
      planner: { modelLabel: p.modelLabel, model: p.model, effort: p.effort },
      state: holder ? (NEEDS_OPERATOR.includes(holder.status) ? "Waiting" : "Working") : blocker ? "Blocked" : "Idle",
      blocker,
      holder,
      line: lineFor(ws).map((t) => ({ taskId: t.id, chatId: t.chat_id, title: t.title, mode: t.mode, sentAt: t.created_at })),
    };
  };
  return { One: bay("One"), "Studio": bay("Studio") };
}

export interface DryingRow {
  taskId: string;
  chatId: string | null;
  title: string;
  route: string;
  status: string;
  endedAt: string;
  cost: number | null;
}

const DRY_STATUSES = ["completed", "unverified", "planned", "failed", "blocked", "cancelled", "rejected", "closed"];

/** Finished One and Studio tasks in the range, newest first. A cost is only ever what the task's runs reported. */
export function dryingLine(system: SystemFilter, range: Range, limit = 60): DryingRow[] {
  const sw = systemWhere(system);
  const rows = all<{ id: string; chat_id: string | null; title: string; route: string; status: string; ended: string }>(
    `SELECT id, chat_id, title, route, status, COALESCE(ended_at, updated_at) AS ended FROM tasks
      WHERE origin != 'probe' AND ${sw.sql} AND status IN (${DRY_STATUSES.map(() => "?").join(",")}) AND COALESCE(ended_at, updated_at) >= ?
      ORDER BY ended DESC, rowid DESC LIMIT ?`,
    [...sw.params, ...DRY_STATUSES, sinceFor(range), limit],
  );
  if (!rows.length) return [];
  const costs = taskCosts(rows.map((r) => r.id));
  return rows.map((r) => ({ taskId: r.id, chatId: r.chat_id, title: r.title, route: r.route, status: r.status, endedAt: r.ended, cost: costs.get(r.id) ?? null }));
}

/**
 * What each task's runs reported costing: `reportedCost` summed over its result and planning events. A task
 * whose runs reported nothing (Codex, or no run yet) has no entry, so it is never counted as $0.
 */
function taskCosts(ids: string[]): Map<string, number> {
  const costs = new Map<string, number>();
  // In chunks, so a long range never meets SQLite's limit on bound parameters.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const events = all<{ task_id: string; type: string; data_json: string | null }>(
      `SELECT task_id, type, data_json FROM events WHERE type IN ('executor_result','planning_complete','planning_failed') AND task_id IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    );
    for (const e of events) {
      const c = reportedCost(e.type, e.data_json);
      if (c !== null) costs.set(e.task_id, (costs.get(e.task_id) ?? 0) + c);
    }
  }
  return costs;
}

// ---- J1 top band: the circles the operator asked for on 2026-09-24 ----------------------------

export interface DashboardCircles {
  tasks: { total: number; completed: number; failed: number; abandoned: number; inLine: number; open: number };
  agents: { total: number; running: number; avgCostUsd: number | null; agentTasks: number; costed: number };
}

const OPEN_STATUSES = [...ACTIVE_STATUSES, ...WAITING_STATUSES];

/**
 * The Dashboard's top band. Tasks: One and Studio tasks started in the range (probes left out), by how they
 * ended; the line counts tasks in line now out of the open ones now, whatever the range. Agents: the
 * registered sub-agents now, and the average cost their tasks in the range reported. Read-only.
 */
export function dashboardCircles(system: SystemFilter, range: Range): DashboardCircles {
  const sw = systemWhere(system);
  const { total, byStatus } = taskMetrics(system, range);
  const sum = (...k: string[]) => k.reduce((a, s) => a + (byStatus[s] ?? 0), 0);
  const open = all<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM tasks WHERE origin != 'probe' AND ${sw.sql} AND status IN (${OPEN_STATUSES.map(() => "?").join(",")}) GROUP BY status`,
    [...sw.params, ...OPEN_STATUSES],
  );
  const workspaces: WorkspaceId[] = system === "all" ? ["One", "Studio"] : [system];
  const agents = workspaces.flatMap((ws) => listAgentsView(ws));
  const agentTaskIds = all<{ id: string }>(`SELECT id FROM tasks WHERE origin = 'agent' AND ${sw.sql} AND created_at >= ?`, [...sw.params, sinceFor(range)]).map((r) => r.id);
  const costs = [...taskCosts(agentTaskIds).values()];
  return {
    tasks: {
      total,
      completed: sum("completed", "unverified"),
      failed: sum("failed", "blocked"),
      abandoned: sum("cancelled", "rejected"),
      inLine: open.find((r) => r.status === "in_line")?.n ?? 0,
      open: open.reduce((a, r) => a + r.n, 0),
    },
    agents: {
      total: agents.length,
      running: agents.filter((a) => a.status === "Working").length,
      avgCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
      agentTasks: agentTaskIds.length,
      costed: costs.length,
    },
  };
}
