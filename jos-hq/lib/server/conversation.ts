// Chat continuity. Each chat message becomes its own HQ task, and before this module a task knew
// nothing about the tasks before it in the same chat — so "Please proceed." reached routing, the
// planner and the executor as the whole request. The history is captured once, when the task is
// submitted, and stored on its context, so what the task was told is fixed and auditable.
import { all } from "./db";
import { approvalsForTask } from "./approvals";
import { planObjective } from "./planning";
import { taskContext, type ConversationContext, type TaskRow } from "./tasks";
import { redactSecrets } from "./util/redact";
import type { WorkspaceId } from "./env";

/** Earlier tasks carried forward; older ones are dropped rather than truncated mid-thought. */
const MAX_TURNS = 4;
const MAX_CHARS = 8000;

export interface ConversationTurn {
  taskId: string;
  title: string;
  request: string;
  route: string | null;
  status: string;
  objective: string | null;
  clarifications: Array<{ question: string; answer: string }>;
  actions: Array<{ title: string; state: string }>;
  answer: string | null;
}

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** The earlier tasks of a chat, oldest first: all of them, or only those sent before `beforeTaskId`. */
export function conversationTurns(chatId: string, beforeTaskId: string | null): ConversationTurn[] {
  const rows = all<TaskRow>(
    `SELECT * FROM tasks WHERE chat_id = ?
       AND (? IS NULL OR rowid < COALESCE((SELECT rowid FROM tasks WHERE id = ?), 9223372036854775807))
     ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    [chatId, beforeTaskId, beforeTaskId, MAX_TURNS],
  ).reverse();
  return rows.map((t) => {
    const ctx = taskContext(t);
    const result = all<{ content: string }>("SELECT content FROM chat_messages WHERE task_id = ? AND kind = 'result' ORDER BY created_at DESC, rowid DESC LIMIT 1", [t.id])[0];
    const approval = approvalsForTask(t.id).filter((a) => a.status !== "superseded").pop();
    return {
      taskId: t.id,
      title: t.title,
      request: t.request,
      route: t.route,
      status: t.status,
      objective: planObjective(t.plan_json),
      clarifications: ctx.clarifications.map((c) => ({ question: c.question, answer: c.answer })),
      actions: (approval?.actions ?? []).map((a) => ({
        title: a.title,
        // An action is only "not run" once its approval was decided; before that it is still pending.
        state: approval?.status === "pending" ? "awaiting approval" : approval?.status === "rejected" ? "rejected" : (approval?.states.find((s) => s.index === a.index)?.state ?? "unknown"),
      })),
      answer: result?.content ?? null,
    };
  });
}

export function renderConversation(turns: ConversationTurn[], maxChars = MAX_CHARS): string {
  const blocks = turns.map((t, i) => {
    const lines = [
      `Earlier task ${i + 1} of ${turns.length} — "${t.title}" (${t.taskId}) · route ${t.route ?? "none"} · ended ${t.status}`,
      `  Operator asked: ${clip(t.request, 1500)}`,
    ];
    if (t.objective) lines.push(`  Objective as planned: ${clip(t.objective, 400)}`);
    for (const c of t.clarifications) lines.push(`  Operator answered "${clip(c.question, 200)}" → ${clip(c.answer, 300)}`);
    for (const a of t.actions) lines.push(`  Proposed action "${clip(a.title, 160)}": ${a.state === "ready" ? "approved, not run" : a.state}`);
    if (t.answer) lines.push(`  How it ended: ${clip(t.answer, 700)}`);
    return lines.join("\n");
  });
  // Keep the most recent turns when the budget is tight: they are what "proceed" refers to.
  let text = blocks.join("\n\n");
  while (text.length > maxChars && blocks.length > 1) {
    blocks.shift();
    text = blocks.join("\n\n");
  }
  return redactSecrets(text.length > maxChars ? text.slice(text.length - maxChars) : text);
}

/** The continuity context for a task in `chatId`: the tasks sent before `beforeTaskId`, or all of them. Null when there are none. */
export function conversationContext(chatId: string | null, beforeTaskId: string | null): ConversationContext | null {
  if (!chatId) return null;
  const turns = conversationTurns(chatId, beforeTaskId);
  if (!turns.length) return null;
  const last = turns[turns.length - 1];
  const routed = [...turns].reverse().find((t) => t.route === "One" || t.route === "Studio");
  return { route: (routed?.route as WorkspaceId | undefined) ?? null, lastTaskId: last.taskId, lastTitle: last.title, text: renderConversation(turns) };
}
