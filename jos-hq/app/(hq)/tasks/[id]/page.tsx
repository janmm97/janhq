"use client";

import { use, useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiSend, useApi } from "@/lib/client/api";
import { markFor } from "@/lib/client/stations";
import { PageHeader } from "@/components/shell";
import { Button, ErrorNote, Mark, Panel } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { SubmitIssue } from "@/components/issue";
import { ACTIVE, ApprovalCard, ApprovalHost, ClarifyCard, OrphanNotice, ReconcileCard, RunDetails, SessionRow, TaskProgress, WAITING, useTaskEvents, type ExecutionView, type TaskView } from "@/components/task";
import type { ApprovalView } from "@/components/approval";

/** A chat-less task has no composer, so its question is answered here, below the card that asks it. */
function AnswerBox({ taskId, onAnswered }: { taskId: string; onAnswered: () => void }) {
  const id = useId();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiSend("POST", `/api/tasks/${taskId}/clarify`, { answer: answer.trim() });
      setAnswer("");
      onAnswered();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-[11px] font-bold uppercase tracking-[0.14em] text-silver">
        Your answer
      </label>
      <textarea
        id={id}
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        rows={3}
        className="block w-full max-w-[76ch] rounded-[4px] border border-rim bg-ground px-3 py-2 text-[13.5px] leading-[1.55] text-paper placeholder:text-silver"
      />
      <Button variant="primary" size="sm" onClick={() => void send()} disabled={busy || !answer.trim()}>
        {busy ? "Sending…" : "Send answer"}
      </Button>
      <ErrorNote error={error} />
    </div>
  );
}

export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data, error, reload } = useApi<{ task: Omit<TaskView, "approvals" | "executions">; executions: ExecutionView[]; approvals: ApprovalView[] }>(`/api/tasks/${id}`, ["task_updated", "approval_required", "approval_resolved"]);
  const task = useMemo<TaskView | null>(() => (data ? { ...(data.task as TaskView), approvals: data.approvals, executions: data.executions } : null), [data]);
  const events = useTaskEvents(id);
  const [details, setDetails] = useState(false);
  const [approvalId, setApprovalId] = useState<string | null>(null);

  useEffect(() => {
    if (task?.chat_id) router.replace(`/chat/${task.chat_id}?task=${id}`);
  }, [task?.chat_id, id, router]);

  if (!task) return <ErrorNote error={error} />;
  const approval = task.approvals.find((a) => a.id === approvalId);
  const pending = task.approvals.filter((a) => a.status === "pending");
  // The same mark as the progress card and the strip (a PREVIEW run reads "Preview" everywhere).
  const mark = markFor(task);
  const question = task.status === "needs_clarification" ? task.context?.pendingQuestion : null;
  return (
    <>
      <PageHeader code="Task" title={task.title} description={`${task.origin} task · ${task.route ?? "not routed yet"}${task.route_reason ? ` · ${task.route_reason}` : ""}`} actions={<Mark tone={mark.tone}>{mark.text}</Mark>} />
      <SessionRow task={task} className="mb-4 rounded-[6px] border border-rim bg-room" />
      <div className="space-y-4">
        {(ACTIVE.includes(task.status) || WAITING.includes(task.status)) && <TaskProgress task={task} events={events} onDetails={() => setDetails(true)} onChanged={reload} />}
        {question && (
          <>
            <ClarifyCard task={task} message={question.question} data={{ kind: question.kind, options: question.options }} active onAnswered={reload} />
            <AnswerBox taskId={task.id} onAnswered={reload} />
          </>
        )}
        {pending.map((a) => (
          <ApprovalCard key={a.id} task={task} approval={a} onOpen={() => setApprovalId(a.id)} onResolved={() => void reload()} />
        ))}
        {task.status === "needs_reconciliation" || task.status === "interrupted" ? (
          <ReconcileCard task={task} onDone={reload} />
        ) : (
          // Reconciled already, but its executor may still be running and holding the line.
          <OrphanNotice task={task} onDone={reload} />
        )}
        <Panel title="Request">
          <p className="max-w-[76ch] whitespace-pre-wrap text-[13.5px] text-silver-hi">{task.request}</p>
        </Panel>
        {task.result?.answer && (
          <Panel title="Answer">
            <Markdown text={task.result.answer} />
          </Panel>
        )}
        {task.error && <ErrorNote error={new Error(task.error)} />}
        <SubmitIssue taskId={task.id} status={task.status} />
        <Button size="sm" variant="ghost" onClick={() => setDetails(true)}>
          Open run details
        </Button>
      </div>
      {details && <RunDetails task={task} events={events} onClose={() => setDetails(false)} />}
      {approval && <ApprovalHost task={task} approval={approval} onClose={() => setApprovalId(null)} onResolved={reload} />}
    </>
  );
}
