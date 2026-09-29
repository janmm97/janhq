"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiSend, useApi } from "@/lib/client/api";
import { markText, statusTone } from "@/lib/client/format";
import { Composer, type SendPayload } from "./composer";
import { Markdown } from "./markdown";
import { SubmitIssue } from "./issue";
import { PlanCard, type TaskView } from "./task";
import { Mark, cx } from "./ui";

export type ChatWindowState = "docked" | "minimized" | "popped";

interface AgentMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  task_id: string | null;
  task_status: string | null;
  created_at: string;
}

function IconButton({ label, onClick, children, testId }: { label: string; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} data-testid={testId} className="grid size-7 place-items-center rounded-[4px] text-silver transition-colors duration-200 ease-out-expo hover:bg-tray hover:text-paper">
      {children}
    </button>
  );
}

/** A Plan-mode task's plan, with Execute this plan (spec 3.7); `started` once the conversation shows it ran. */
function AgentPlan({ taskId, onStarted, started }: { taskId: string; onStarted: () => void; started: boolean }) {
  const { data } = useApi<{ task: Omit<TaskView, "approvals" | "executions" | "context"> & { context: { planProblems?: string[] } } }>(`/api/tasks/${taskId}`, ["task_updated"]);
  if (!data?.task.plan) return null;
  const task = { ...data.task, context: {}, approvals: [], executions: [] } as TaskView;
  return (
    <div className="mt-2">
      <PlanCard task={task} data={{ plan: data.task.plan, model: data.task.planner_model ?? undefined, problems: data.task.context.planProblems ?? [] }} onStarted={onStarted} started={started} />
    </div>
  );
}

export function AgentChatWindow({
  workspace,
  agent,
  agentName,
  conversationId,
  onConversation,
  state,
  onState,
  onClose,
}: {
  workspace: "One" | "Studio";
  agent: string;
  agentName: string;
  conversationId: string | null;
  onConversation: (id: string) => void;
  state: ChatWindowState;
  onState: (s: ChatWindowState) => void;
  onClose: () => void;
}) {
  const base = `/api/agents/${workspace}/${encodeURIComponent(agent)}/conversations`;
  const { data, reload } = useApi<{ messages: AgentMessage[] }>(conversationId ? `${base}/${conversationId}` : null, ["agents_updated", "task_updated"]);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const msgs = data?.messages ?? [];

  // Block body: scrollIntoView() returns a Promise in current Chrome, and an effect must not return one.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [msgs.length, state]);

  const send = async (p: SendPayload) => {
    let id = conversationId;
    if (!id) {
      const r = await apiSend<{ conversation: { id: string } }>("POST", base, { title: p.content.slice(0, 60) });
      id = r.conversation.id;
      onConversation(id);
    }
    await apiSend("POST", `${base}/${id}/messages`, { content: p.content, mode: p.mode });
    await reload();
  };

  const header = (
    <div
      className={cx("flex items-center gap-2 border-b border-rim px-3 py-2", state === "popped" && "cursor-move select-none")}
      onPointerDown={(e) => {
        if (state !== "popped" || (e.target as HTMLElement).closest("button")) return;
        const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
        drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        setPos({ x: Math.max(8, Math.min(window.innerWidth - 200, e.clientX - drag.current.dx)), y: Math.max(8, Math.min(window.innerHeight - 60, e.clientY - drag.current.dy)) });
      }}
      onPointerUp={() => (drag.current = null)}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-paper" title={`Chat with ${agentName}`}>
          Chat with {agentName}
        </div>
        <div className="text-[12px] text-silver">{workspace} sub-agent · each message runs as a J/OS task</div>
      </div>
      {state !== "minimized" && (
        <IconButton label="Minimize chat" onClick={() => onState("minimized")} testId="agent-chat-minimize">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M2.5 8.5h7" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </IconButton>
      )}
      {state === "docked" && (
        <IconButton label="Pop out chat" onClick={() => onState("popped")} testId="agent-chat-popout">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M7 2h3v3M10 2 6 6M5 3H2v7h7V7" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </IconButton>
      )}
      {state === "popped" && (
        <IconButton label="Dock chat back into the panel" onClick={() => onState("docked")} testId="agent-chat-dock">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <rect x="2" y="2" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M2 6h8" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </IconButton>
      )}
      <IconButton label="Close chat" onClick={onClose} testId="agent-chat-close">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </IconButton>
    </div>
  );

  if (state === "minimized") {
    return (
      <div className="fixed bottom-4 right-4 z-[70] flex w-[320px] max-w-[calc(100vw-32px)] items-center gap-2 rounded-[6px] border border-rim-strong bg-room px-3 py-2 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.85)]" data-testid="agent-chat-minimized" role="region" aria-label={`Chat with ${agentName}, minimized`}>
        <span className="min-w-0 flex-1 truncate text-[13px] text-paper" title={`Chat with ${agentName}`}>
          Chat with {agentName}
        </span>
        <button type="button" onClick={() => onState("docked")} data-testid="agent-chat-restore" className="rounded-[4px] px-2 py-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-paper hover:bg-tray">
          Restore
        </button>
        <IconButton label="Close chat" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </IconButton>
      </div>
    );
  }

  const body = (
    <>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" data-testid="agent-chat-history">
        {msgs.length === 0 && <p className="text-[12.5px] text-silver">No messages yet. The agent receives your message plus explicit context; the thread here is display history, not hidden memory.</p>}
        {msgs.map((m, i) =>
          m.role === "user" ? (
            <div key={m.id} className="flex flex-col items-end gap-1">
              <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-[6px] border border-rim bg-tray px-3 py-2 text-[13.5px] text-paper" data-testid="agent-user-message">
                {m.content}
              </div>
              {m.task_id && m.task_status && (
                <Link href={`/tasks/${m.task_id}`} title="Open the task">
                  <Mark tone={statusTone(m.task_status)}>{markText(m.task_status)}</Mark>
                </Link>
              )}
            </div>
          ) : (
            <div key={m.id} className="max-w-[95%]">
              <Markdown text={m.content} />
              {m.task_id && <SubmitIssue taskId={m.task_id} status={m.task_status} className="mt-2" />}
              {m.task_id && m.task_status === "planned" && (
                <AgentPlan taskId={m.task_id} onStarted={() => void reload()} started={msgs.slice(i + 1).some((x) => x.role === "user" && x.content.startsWith("Execute the plan ("))} />
              )}
            </div>
          ),
        )}
        <div ref={end} />
      </div>
      <div className="border-t border-rim p-2">
        <Composer onSend={send} compact showRoute={false} placeholder={`Message ${agentName}...`} testIdPrefix="agent-composer" />
      </div>
    </>
  );

  if (state === "popped") {
    return (
      <div
        role="dialog"
        aria-label={`Chat with ${agentName}`}
        data-testid="agent-chat-popped"
        className="fixed z-[70] flex h-[560px] max-h-[calc(100vh-32px)] w-[440px] max-w-[calc(100vw-32px)] flex-col rounded-[6px] border border-rim-strong bg-room shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)]"
        style={pos ? { left: pos.x, top: pos.y } : { right: 16, bottom: 16 }}
      >
        {header}
        {body}
      </div>
    );
  }

  return (
    <div className="flex h-[520px] flex-col rounded-[4px] border border-rim-strong bg-ground" data-testid="agent-chat-docked" role="region" aria-label={`Chat with ${agentName}`}>
      {header}
      {body}
    </div>
  );
}
