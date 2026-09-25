"use client";

import Link from "next/link";
import { Suspense, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiSend, useApi } from "@/lib/client/api";
import { STATUS_TEXT, statusTone, timeAgo } from "@/lib/client/format";
import { Composer, type RouteChoice, type SendPayload } from "@/components/composer";
import { Markdown } from "@/components/markdown";
import { ErrorNote, StatusDot, Tag, cx, useOutsideClose } from "@/components/ui";
import { DeleteChatDialog, TrashIcon } from "@/components/chat-delete";
import { AttentionChip } from "@/components/shell";
import { SubmitIssue } from "@/components/issue";
import { ACTIVE, ApprovalCard, ApprovalHost, ClarifyCard, OrphanNotice, PlanCard, ReconcileCard, ResultCard, RouteCard, RunDetails, SessionRow, TaskProgress, WAITING, lineHeldNote, useTaskEvents, type TaskView } from "@/components/task";

interface MessageView {
  id: string;
  chat_id: string;
  role: "user" | "assistant" | "system";
  kind: string;
  content: string;
  task_id: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
}
interface AttachmentView {
  id: string;
  task_id: string | null;
  original_name: string;
  size: number;
}
interface ChatData {
  chat: { id: string; title: string; purpose: string | null };
  messages: MessageView[];
  tasks: TaskView[];
  attachments?: AttachmentView[];
}

const iconButton = "grid size-9 place-items-center rounded-[4px] text-silver transition-colors duration-200 ease-out-expo hover:bg-tray hover:text-paper";

function fmtBytes(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function HistoryMenu({ current }: { current: string }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  const { data } = useApi<{ chats: Array<{ id: string; title: string; updated_at: string; last_status: string | null }> }>(open ? "/api/chats" : null);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open} aria-label="Chat history" title="Chat history" className={iconButton}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-80 max-w-[calc(100vw-24px)] rounded-[6px] border border-rim-strong bg-room p-1.5 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.85)]">
          <div className="px-2 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-silver">Chats</div>
          <ul className="max-h-[50vh] overflow-y-auto">
            {(data?.chats ?? []).map((c) => (
              <li key={c.id}>
                <Link href={`/chat/${c.id}`} onClick={() => setOpen(false)} title={c.title} className={cx("flex items-center gap-2 rounded-[4px] px-2 py-1.5 text-[13px]", c.id === current ? "bg-tray text-paper" : "text-silver-hi hover:bg-tray")}>
                  {c.last_status && <StatusDot tone={statusTone(c.last_status)} />}
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  <span className="shrink-0 text-[12px] text-silver">{timeAgo(c.updated_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Title({ chatId, title }: { chatId: string; title: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  useEffect(() => {
    setValue(title);
  }, [title]);
  const save = async () => {
    setEditing(false);
    if (value.trim() && value.trim() !== title) await apiSend("PATCH", `/api/chats/${chatId}`, { title: value.trim() });
  };
  return editing ? (
    <input
      autoFocus
      value={value}
      aria-label="Conversation title"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === "Enter") void save();
        if (e.key === "Escape") {
          setValue(title);
          setEditing(false);
        }
      }}
      className="h-8 w-full max-w-[320px] rounded-[4px] border border-rim bg-room px-2 text-[14px] text-paper"
    />
  ) : (
    <button type="button" onClick={() => setEditing(true)} title={`Rename conversation: ${title}`} data-testid="chat-title" className="max-w-[320px] truncate rounded-[4px] px-1.5 py-1 text-left text-[14px] font-semibold text-paper hover:bg-tray">
      {title}
    </button>
  );
}

function UserBubble({ m, attachments }: { m: MessageView; attachments: AttachmentView[] }) {
  const route = m.data?.route as string | undefined;
  const mode = m.data?.mode as string | undefined;
  const ids = (m.data?.attachmentIds as string[] | undefined) ?? [];
  const files = ids.map((id) => attachments.find((a) => a.id === id)).filter((a): a is AttachmentView => !!a);
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[6px] border border-rim bg-tray px-4 py-2.5 text-[14px] leading-[1.55] text-paper" data-testid="user-message">
        {m.content}
      </div>
      {files.length > 0 && (
        <ul className="flex max-w-[85%] flex-wrap justify-end gap-1.5" aria-label="Attached files">
          {files.map((f) => (
            <li key={f.id} data-testid="message-attachment" title="Stored locally in HQ; executors read it in place" className="inline-flex items-center gap-1.5 rounded-[4px] border border-rim bg-room px-2.5 py-1 text-[12.5px]">
              <span className="max-w-[220px] truncate text-silver-hi">{f.original_name}</span>
              <span className="text-silver">{fmtBytes(f.size)}</span>
            </li>
          ))}
        </ul>
      )}
      {((route && route !== "auto") || (mode && mode !== "auto")) && (
        <div className="flex gap-1.5 text-[12px] text-silver">
          {route && route !== "auto" && <span>route {route}</span>}
          {mode && mode !== "auto" && <span>mode {mode}</span>}
        </div>
      )}
    </div>
  );
}

function ChatView({ chatId }: { chatId: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const { data, error, reload } = useApi<ChatData>(`/api/chats/${chatId}`, ["chat_message", "task_updated", "chats_updated", "approval_required", "approval_resolved"]);
  const [detailsFor, setDetailsFor] = useState<string | null>(search.get("task"));
  const [approvalOpen, setApprovalOpen] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const closeDelete = useCallback(() => setDeleting(false), []);
  const bottom = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLElement>(null);

  const tasks = useMemo(() => data?.tasks ?? [], [data]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const live = tasks.filter((t) => ACTIVE.includes(t.status) || WAITING.includes(t.status));
  const liveTask = live[live.length - 1] ?? null;
  const sessionTask = liveTask ?? tasks[tasks.length - 1] ?? null;
  const liveEvents = useTaskEvents(liveTask?.id ?? null);
  const detailsEvents = useTaskEvents(detailsFor && detailsFor !== liveTask?.id ? detailsFor : null);
  const waitingAnswer = tasks.find((t) => t.status === "needs_clarification");

  // A new message scrolls into view. A pending Expose card arrives from its top, so its title, action,
  // connection and target read before Approve · expose; every other message scrolls to the bottom.
  // The approval dialog opens only on request.
  const msgCount = data?.messages.length ?? 0;
  const newest = data?.messages[msgCount - 1];
  const newestApprovalId = newest?.kind === "approval" ? ((newest.data as { approvalId?: string } | null)?.approvalId ?? null) : null;
  const exposeId = newestApprovalId && newest?.task_id && taskById.get(newest.task_id)?.approvals.some((a) => a.id === newestApprovalId && a.status === "pending") ? newestApprovalId : null;
  useEffect(() => {
    // Reduced motion jumps instead of gliding.
    const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    const card = exposeId ? main.current?.querySelector(`[data-approval-id="${CSS.escape(exposeId)}"]`) : null;
    if (card) card.scrollIntoView({ block: "start", behavior });
    else bottom.current?.scrollIntoView({ block: "end", behavior });
  }, [msgCount, liveTask?.status, exposeId]);

  const send = useCallback(
    async (p: SendPayload) => {
      await apiSend("POST", `/api/chats/${chatId}/messages`, p);
      await reload();
    },
    [chatId, reload],
  );

  const approvalTask = approvalOpen ? tasks.find((t) => t.approvals.some((a) => a.id === approvalOpen)) : undefined;
  const approval = approvalTask?.approvals.find((a) => a.id === approvalOpen);
  const reconcile = tasks.filter((t) => t.status === "needs_reconciliation" || t.status === "interrupted");
  // An orphaned executor can outlive its task's reconciliation and still hold the line. A ReconcileCard
  // already offers it for the tasks above, so this covers only the others.
  const orphans = tasks.filter((t) => !reconcile.includes(t) && t.executions.some((e) => e.status === "needs_reconciliation"));
  const empty = !!data && data.messages.length === 0;
  const lastClarifyIdByTask = new Map<string, string>();
  for (const m of data?.messages ?? []) if (m.kind === "clarify" && m.task_id) lastClarifyIdByTask.set(m.task_id, m.id);
  const initialRoute = (search.get("route") as RouteChoice | null) ?? "auto";

  return (
    <div className="flex h-screen flex-col bg-ground">
      {/* Below sm the brand steps aside so the title and the One Flow tag keep the row. */}
      <header className="grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-rim px-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          {data ? <Title chatId={chatId} title={data.chat.title} /> : <span className="text-[14px] text-silver">Untitled</span>}
          {data?.chat.purpose === "workflow" && (
            <Tag className="shrink-0">
              <span className="sm:hidden">One Flow</span>
              <span className="hidden sm:inline">Builds a One Flow</span>
            </Tag>
          )}
        </div>
        <div className="hidden select-none items-baseline gap-1.5 sm:flex">
          <span className="text-[16px] font-extrabold tracking-[-0.02em] text-paper">J/OS</span>
          <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-silver">HQ</span>
        </div>
        <div className="flex items-center justify-end gap-1">
          <AttentionChip compact />
          <HistoryMenu current={chatId} />
          <button type="button" onClick={() => setDeleting(true)} disabled={!data} aria-label="Delete chat" title="Delete chat" data-testid="chat-delete" className="grid size-9 place-items-center rounded-[4px] text-silver transition-colors duration-200 ease-out-expo hover:bg-fog/10 hover:text-fog disabled:text-gray">
            <TrashIcon />
          </button>
          <button type="button" onClick={() => router.push("/")} aria-label="Close chat and return to the command center" title="Back to command center" data-testid="chat-close" className={iconButton}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
      </header>
      <DeleteChatDialog chat={deleting && data ? data.chat : null} onClose={closeDelete} onDeleted={() => router.push("/")} />
      {sessionTask && <SessionRow task={sessionTask} className="shrink-0 border-b border-rim" />}

      <main ref={main} className="enlarger min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        {/* The composer sits below this scroll area, not over it, so the last card needs only a short margin. */}
        <div className="mx-auto flex min-h-full max-w-3xl flex-col px-4 pb-8 pt-8">
          <ErrorNote error={error} />
          {empty ? (
            <div className="flex flex-1 flex-col items-center justify-center pb-24 text-center" data-testid="chat-empty">
              <h1 className="text-[26px] font-bold tracking-[-0.02em] text-paper">Give J/OS a Tasks</h1>
              <p className="mt-2 text-[13px] text-silver">Enter creates a new line. Send with Ctrl + Enter or the Send button.</p>
            </div>
          ) : (
            <ol className="space-y-5">
              {(data?.messages ?? []).map((m, i, all) => {
                const t = m.task_id ? taskById.get(m.task_id) : undefined;
                let body: React.ReactNode;
                if (m.role === "user") body = <UserBubble m={m} attachments={data?.attachments ?? []} />;
                else if (m.kind === "route") body = <RouteCard data={m.data as never} />;
                else if (m.kind === "clarify")
                  body = <ClarifyCard task={t} message={m.content} data={m.data as never} active={!!t && t.status === "needs_clarification" && lastClarifyIdByTask.get(t.id) === m.id} onAnswered={reload} />;
                else if (m.kind === "plan")
                  body = <PlanCard task={t} data={m.data as never} onStarted={() => void reload()} started={!!t && all.slice(i + 1).some((x) => x.data?.executePlanOf === t.id)} />;
                else if (m.kind === "approval") {
                  const ap = t?.approvals.find((a) => a.id === (m.data as { approvalId?: string } | null)?.approvalId);
                  body = <ApprovalCard task={t} approval={ap} onOpen={() => ap && setApprovalOpen(ap.id)} onResolved={() => void reload()} />;
                } else if (m.kind === "result") body = <ResultCard content={m.content} data={m.data as never} createdAt={m.created_at} />;
                else if (m.kind === "approval_resolved" || m.kind === "line" || m.kind === "memory")
                  body = (
                    <p className="text-center text-[12px] text-silver" data-testid={m.kind === "line" ? "line-message" : m.kind === "memory" ? "memory-message" : undefined}>
                      {m.content}
                    </p>
                  );
                else body = <Markdown text={m.content} />;
                const showDetails = m.task_id && (m.kind === "result" || m.kind === "route");
                return (
                  <li key={m.id}>
                    {body}
                    {m.kind === "result" && m.task_id && <SubmitIssue taskId={m.task_id} status={t?.status} className="mt-2" />}
                    {showDetails && (
                      <button type="button" onClick={() => setDetailsFor(m.task_id)} className="mt-1.5 text-[12px] text-silver hover:text-paper">
                        Run details
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {live.map((t) => (
            <div key={t.id} className="mt-5">
              <TaskProgress task={t} events={t.id === liveTask?.id ? liveEvents : []} onDetails={() => setDetailsFor(t.id)} onChanged={reload} />
            </div>
          ))}
          {reconcile.map((t) => (
            <div key={t.id} className="mt-5">
              <ReconcileCard task={t} onDone={reload} />
            </div>
          ))}
          {orphans.map((t) => (
            <div key={t.id} className="mt-3">
              <OrphanNotice task={t} onDone={reload} />
            </div>
          ))}
          <div ref={bottom} />
        </div>
      </main>

      <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-5">
        <Composer key={chatId} chatId={chatId} onSend={send} initialText={search.get("draft") ?? ""} initialRoute={initialRoute} answering={waitingAnswer?.context?.pendingQuestion?.question ?? null} />
        {liveTask && (
          <p className="mt-2 text-center text-[12px] text-silver">
            {STATUS_TEXT[liveTask.status]} · {liveTask.line ? `${liveTask.line.ordinal} for ` : null}
            {liveTask.route && liveTask.route !== "none" ? <Tag className="align-middle">{liveTask.route}</Tag> : "routing"}
            {liveTask.line ? lineHeldNote(liveTask.line) : null}
          </p>
        )}
      </div>

      {detailsFor && taskById.get(detailsFor) && <RunDetails task={taskById.get(detailsFor)!} events={detailsFor === liveTask?.id ? liveEvents : detailsEvents} onClose={() => setDetailsFor(null)} />}
      {approval && approvalTask && <ApprovalHost task={approvalTask} approval={approval} onClose={() => setApprovalOpen(null)} onResolved={reload} />}
    </div>
  );
}

export default function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={null}>
      <ChatView chatId={id} />
    </Suspense>
  );
}
