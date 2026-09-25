import { all, get, json, parseJson, run, tx } from "./db";
import { removeChatUploads } from "./attachments";
import { emit, signal } from "./events";
import { newId } from "./util/ids";
import { nowIso } from "./util/time";
import { redactDeep, redactSecrets } from "./util/redact";
import type { TaskMode } from "./executors/types";
import type { WorkspaceId } from "./env";
import type { RouteSelection } from "./routing";

export type TaskStatus =
  | "queued"
  | "routing"
  | "needs_clarification"
  | "discovering"
  | "in_line"
  | "planning"
  | "dispatching"
  | "executing"
  | "awaiting_approval"
  | "verifying"
  | "completed"
  | "unverified"
  | "planned"
  | "failed"
  | "blocked"
  | "cancelled"
  | "rejected"
  | "interrupted"
  | "needs_reconciliation"
  | "closed";

export const ACTIVE_STATUSES: TaskStatus[] = ["queued", "routing", "discovering", "in_line", "planning", "dispatching", "executing", "verifying"];
export const WAITING_STATUSES: TaskStatus[] = ["needs_clarification", "awaiting_approval"];
export const TERMINAL_STATUSES: TaskStatus[] = ["completed", "unverified", "planned", "failed", "blocked", "cancelled", "rejected", "interrupted", "needs_reconciliation", "closed"];

export type Stage = "understand" | "route" | "log" | "discover" | "queue" | "plan" | "validate" | "prompt" | "launch" | "execute" | "approve" | "verify" | "close" | "respond";

export interface PendingQuestion {
  kind: "route" | "mailbox" | "executor" | "planner";
  question: string;
  options: Array<{ value: string; label: string }>;
}

export interface TaskContext {
  clarifications: Array<{ kind: string; question: string; answer: string }>;
  pendingQuestion?: PendingQuestion | null;
  attachmentIds?: string[];
  agent?: { workspace: WorkspaceId; name: string } | null;
  flow?: { workspace: WorkspaceId; key: string } | null;
  orchestratorBrief?: string | null;
  cancelRequested?: boolean;
  previewExecutionId?: string | null;
  executeExecutionId?: string | null;
  approvalId?: string | null;
  previewResult?: unknown;
  planProblems?: string[];
  /** The planning session's execution (PLAN phase), so a cancel can reach it. */
  planExecutionId?: string | null;
  /** Plan steps HQ could not match to a knowledge lookup the planner actually made. */
  planUnverifiedSteps?: number[];
  /** An agent task's allowed connections, resolved to live keys at discovery (spec 3.4). */
  agentScope?: { keys: string[]; missing: string[] } | null;
  /** The agent's LOGS.md entry for this task (agent tasks only); closed with the central entry. */
  agentLog?: { file: string; closed: boolean } | null;
  /** What the log check found before planning (Tasks/Planner-Memory-Spec-2026-09-24.md, Part 2). */
  memory?: {
    decision: "reuse" | "plan";
    match: { taskId: string | null; file: string; date: string | null; title: string } | null;
    hasPlan: boolean;
    reuseText: string | null;
    lessons: string | null;
  } | null;
  identity?: { projectRoot: string | null; email: string | null } | null;
  mailbox?: string | null;
  routeNotes?: string[];
  /** "Execute this plan": reuse a Plan-mode task's validated plan instead of re-planning. */
  reusePlanFrom?: string | null;
  agentConversationId?: string | null;
  workflowRunId?: string | null;
  /** Sent in a New Workflow chat: the deliverable is a saved One Flow, checked by HQ (flowbuild.ts). */
  buildFlow?: boolean;
  /** Flow keys in the workspace when the PREVIEW run was dispatched, for that check. */
  flowsBefore?: string[] | null;
  /** Earlier tasks in the same chat, captured when this task was submitted (chat continuity). */
  conversation?: ConversationContext | null;
  /** Set when the task first had to wait in its workspace's line (queue.ts). */
  line?: { joinedAt: string; behindTaskId: string | null; behindTitle: string | null } | null;
}

export interface ConversationContext {
  /** Route of the most recent earlier task that reached One or Studio. */
  route: WorkspaceId | null;
  lastTaskId: string;
  lastTitle: string;
  /** Rendered history of the earlier tasks, oldest first, bounded in size. */
  text: string;
}

export interface TaskRow {
  id: string;
  chat_id: string | null;
  origin: string;
  title: string;
  request: string;
  mode: TaskMode;
  route_selection: RouteSelection;
  route: WorkspaceId | "none" | null;
  route_reason: string | null;
  route_evidence_json: string | null;
  status: TaskStatus;
  stage: Stage;
  log_file: string | null;
  log_opened_at: string | null;
  log_closed_at: string | null;
  log_status: string | null;
  plan_json: string | null;
  planner_model: string | null;
  context_json: string | null;
  result_json: string | null;
  verification: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
  /** When the task left its workspace's line; from then until it ends, it holds the workspace. */
  admitted_at: string | null;
}

export function getTask(id: string): TaskRow | undefined {
  return get<TaskRow>("SELECT * FROM tasks WHERE id = ?", [id]);
}

export function taskContext(t: TaskRow): TaskContext {
  return parseJson<TaskContext>(t.context_json, { clarifications: [] });
}

export function titleFrom(request: string): string {
  const clean = request.replace(/\s+/g, " ").trim();
  const words = clean.split(" ").slice(0, 8).join(" ");
  return (words.length > 60 ? words.slice(0, 57) + "…" : words) || "Untitled task";
}

export function createTaskRow(input: {
  chatId: string | null;
  origin: "chat" | "cli" | "workflow" | "agent" | "probe";
  request: string;
  mode: TaskMode;
  routeSelection: RouteSelection;
  context: TaskContext;
  title?: string;
}): TaskRow {
  const id = newId("jos");
  const now = nowIso();
  run(
    `INSERT INTO tasks(id, chat_id, origin, title, request, mode, route_selection, status, stage, context_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'understand', ?, ?, ?)`,
    [id, input.chatId, input.origin, redactSecrets(input.title ?? titleFrom(input.request)), redactSecrets(input.request), input.mode, input.routeSelection, json(input.context), now, now],
  );
  return getTask(id)!;
}

export function updateTask(id: string, patch: Partial<Omit<TaskRow, "id">> & { context?: TaskContext }) {
  const { context, ...cols } = patch as Record<string, unknown> & { context?: TaskContext };
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  // Task rows are display and audit data (approved payloads live in the approvals table), so every
  // text value is redacted on the way in.
  for (const [k, v] of Object.entries(cols)) {
    sets.push(`${k} = ?`);
    vals.push(v === undefined ? null : typeof v === "object" && v !== null ? JSON.stringify(redactDeep(v)) : typeof v === "string" ? redactSecrets(v) : (v as number | null));
  }
  if (context) {
    sets.push("context_json = ?");
    vals.push(json(redactDeep(context)));
  }
  sets.push("updated_at = ?");
  vals.push(nowIso());
  vals.push(id);
  run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, vals);
  signal("task_updated", { taskId: id });
}

export function setStage(id: string, stage: Stage, status?: TaskStatus) {
  updateTask(id, status ? { stage, status } : { stage });
}

export function patchContext(id: string, fn: (c: TaskContext) => TaskContext) {
  const t = getTask(id);
  if (!t) return;
  updateTask(id, { context: fn(taskContext(t)) });
}

// ---- chats ---------------------------------------------------------------------------------------

export interface ChatRow {
  id: string;
  title: string;
  /** "workflow": opened by + New Workflow, so every task in it builds a One Flow. */
  purpose: string | null;
  created_at: string;
  updated_at: string;
}

export function createChat(title = "Untitled", purpose: "workflow" | null = null): ChatRow {
  const id = newId("chat");
  const now = nowIso();
  run("INSERT INTO chats(id, title, purpose, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [id, title, purpose, now, now]);
  signal("chats_updated", { chatId: id });
  return get<ChatRow>("SELECT * FROM chats WHERE id = ?", [id])!;
}

export function listChats(): Array<ChatRow & { last_status: string | null; last_route: string | null; preview: string | null }> {
  return all(
    `SELECT c.*, (SELECT status FROM tasks t WHERE t.chat_id = c.id ORDER BY t.created_at DESC LIMIT 1) AS last_status,
            (SELECT route FROM tasks t WHERE t.chat_id = c.id ORDER BY t.created_at DESC LIMIT 1) AS last_route,
            (SELECT content FROM chat_messages m WHERE m.chat_id = c.id AND m.role = 'user' ORDER BY m.created_at DESC LIMIT 1) AS preview
     FROM chats c ORDER BY c.updated_at DESC`,
  );
}

export function renameChat(id: string, title: string) {
  run("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?", [redactSecrets(title).slice(0, 120) || "Untitled", nowIso(), id]);
  signal("chats_updated", { chatId: id });
}

/** A task in one of these can still write to its chat or conversation, or still needs the operator. */
const BUSY_STATUSES: TaskStatus[] = [...ACTIVE_STATUSES, ...WAITING_STATUSES, "interrupted", "needs_reconciliation"];

export interface BusyTask {
  id: string;
  title: string;
  status: TaskStatus;
}

/** Tasks matching `where` that are busy, or whose executor process may still be alive though the task ended. */
export function busyTasks(where: string, params: string[]): BusyTask[] {
  return all<BusyTask>(
    `SELECT id, title, status FROM tasks t WHERE (${where})
       AND (status IN (${BUSY_STATUSES.map(() => "?").join(", ")})
            OR EXISTS (SELECT 1 FROM executions e WHERE e.task_id = t.id AND e.status IN ('starting', 'running', 'needs_reconciliation')))
     ORDER BY created_at, rowid`,
    [...params, ...BUSY_STATUSES],
  );
}

export type DeleteChatResult =
  | { deleted: true }
  | { deleted: false; reason: "not_found" }
  | { deleted: false; reason: "busy"; tasks: BusyTask[] };

/**
 * Deletes the conversation: the chat, its messages, its attachments and their files. Its tasks and
 * their telemetry stay, detached (chat_id NULL). The memory logs are the record and are never touched.
 */
export function deleteChat(id: string): DeleteChatResult {
  const result = tx((): DeleteChatResult => {
    if (!get("SELECT id FROM chats WHERE id = ?", [id])) return { deleted: false, reason: "not_found" };
    const busy = busyTasks("chat_id = ?", [id]);
    if (busy.length) return { deleted: false, reason: "busy", tasks: busy };
    // Files first: if they cannot be removed, the transaction rolls back and the chat stays whole.
    removeChatUploads(id);
    run("UPDATE tasks SET chat_id = NULL WHERE chat_id = ?", [id]);
    run("DELETE FROM chat_messages WHERE chat_id = ?", [id]);
    run("DELETE FROM attachments WHERE chat_id = ?", [id]);
    run("DELETE FROM chats WHERE id = ?", [id]);
    return { deleted: true };
  });
  if (result.deleted) signal("chats_updated", { chatId: id });
  return result;
}

export interface ChatMessageRow {
  id: string;
  chat_id: string;
  role: "user" | "assistant" | "system";
  kind: string;
  content: string;
  task_id: string | null;
  data_json: string | null;
  created_at: string;
}

export function addMessage(chatId: string | null, role: ChatMessageRow["role"], kind: string, content: string, taskId: string | null, data?: unknown): string | null {
  if (!chatId) return null;
  if (!get("SELECT 1 FROM chats WHERE id = ?", [chatId])) return null; // deleted while its task was ending
  const id = newId("msg");
  run("INSERT INTO chat_messages(id, chat_id, role, kind, content, task_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    id,
    chatId,
    role,
    kind,
    redactSecrets(content),
    taskId,
    json(data ?? null),
    nowIso(),
  ]);
  run("UPDATE chats SET updated_at = ? WHERE id = ?", [nowIso(), chatId]);
  signal("chat_message", { chatId, messageId: id, taskId });
  return id;
}

export function chatMessages(chatId: string): ChatMessageRow[] {
  return all<ChatMessageRow>("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC", [chatId]);
}

export function lifecycleEvent(taskId: string, type: string, summary: string, level: "info" | "success" | "warning" | "error" = "info", data?: unknown, system: "orchestrator" | WorkspaceId = "orchestrator") {
  emit({ taskId, system, type, level, visibility: "chat", summary, data });
}
