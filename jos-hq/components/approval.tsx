"use client";

import { useState } from "react";
import { apiSend } from "@/lib/client/api";
import { Button, ErrorNote, Mark, Modal, Tag, cx } from "./ui";

export interface ApprovalActionView {
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
  dryRun: { ok: boolean; method: string | null; url: string | null; detail: string | null } | null;
  executorDryRunMatched: boolean;
  problems: string[];
}
export interface ApprovalView {
  id: string;
  taskId: string;
  status: "pending" | "approved" | "rejected" | "superseded";
  summary: string;
  actions: ApprovalActionView[];
  states: Array<{ index: number; state: string; outcome: { summary?: string; responseIds?: string[] } | null }>;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

function Field({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 border-b border-rim py-1.5 text-[12.5px] last:border-0">
      <dt className="text-silver">{k}</dt>
      <dd className="min-w-0 break-words text-silver-hi">{children}</dd>
    </div>
  );
}

/** The exact payload an approved action runs with: a flow's inputs, or an action's path vars, query and body. */
export function payloadOf(a: ApprovalActionView) {
  if (a.kind === "one_flow") return { flow: a.flowKey, inputs: a.flowInputs ?? {} };
  const p: Record<string, unknown> = {};
  if (a.pathVars) p.pathVars = a.pathVars;
  if (a.queryParams) p.queryParams = a.queryParams;
  if (a.data !== null && a.data !== undefined) p.body = a.data;
  return p;
}

const STATE_TONE: Record<string, "fixed" | "run" | "you" | "fog" | "plan"> = { succeeded: "fixed", ready: "run", executing: "you", ambiguous: "you", failed: "fog", skipped: "plan" };

export function ApprovalModal({ approval, taskTitle, executor, onClose, onResolved }: { approval: ApprovalView; taskTitle: string; executor: string; onClose: () => void; onResolved: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [error, setError] = useState<Error | null>(null);
  const blocked = approval.actions.some((a) => a.problems.length > 0);
  const pending = approval.status === "pending";
  const act = async (what: "approve" | "reject") => {
    setBusy(what);
    setError(null);
    try {
      await apiSend("POST", `/api/approvals/${approval.id}/${what}`, { note: note.trim() || null });
      onResolved();
      onClose();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={pending ? "Approve this action?" : `Approval ${approval.status}`}
      testId="approval-modal"
      footer={
        pending ? (
          <>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Approval note" className="mr-auto h-9 w-64 min-w-0 rounded-[4px] border border-rim bg-ground px-3 text-[12.5px] text-paper placeholder:text-silver" />
            <Button variant="danger" onClick={() => void act("reject")} disabled={!!busy} data-testid="approval-reject">
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </Button>
            <Button variant="primary" onClick={() => void act("approve")} disabled={!!busy || blocked} data-testid="approval-approve" title={blocked ? "Resolve the validation problems first; reject instead" : undefined}>
              {busy === "approve" ? "Exposing…" : "Approve · expose"}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      <p className="mb-3 max-w-[76ch] text-[12.5px] text-silver-hi">
        Nothing outward-facing has happened yet. If you approve, the {executor} executor runs {approval.actions.length === 1 ? "this action" : `these ${approval.actions.length} actions`} exactly as shown, once each, after re-checking its One identity. Auto mode approves validated actions on its own, so anything waiting here was sent in another mode or has problems to resolve.
      </p>
      <dl className="mb-4 rounded-[4px] border border-rim px-3">
        <Field k="Task">{taskTitle}</Field>
        <Field k="Executor">{executor}</Field>
      </dl>
      <ol className="divide-y divide-rim rounded-[4px] border border-rim-strong">
        {approval.actions.map((a) => {
          const st = approval.states.find((s) => s.index === a.index);
          return (
            <li key={a.index} className={cx("p-3.5", a.problems.length > 0 && "shadow-[inset_0_0_0_1px_var(--color-fog)]")}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[13.5px] font-semibold text-paper">
                  {approval.actions.length > 1 ? `${a.index}. ` : ""}
                  {a.title}
                </h3>
                {st && st.state !== "pending" && <Mark tone={STATE_TONE[st.state] ?? "plan"}>{st.state}</Mark>}
              </div>
              <dl>
                <Field k="Connection">
                  {a.connectionName ?? "—"} <Tag className="ml-1">{a.platform}</Tag>
                </Field>
                <Field k="Action">
                  {a.kind === "one_flow" ? (
                    <>One Flow {a.flowKey}</>
                  ) : (
                    <>
                      {a.method ?? "?"} <span className="text-silver">{a.actionId}</span>
                    </>
                  )}
                </Field>
                <Field k="Target">{a.target ?? "—"}</Field>
                <Field k="Side effect">{a.sideEffect || "—"}</Field>
                <Field k="HQ dry-run">
                  {a.dryRun?.ok ? (
                    <span className="text-paper">
                      resolved {a.dryRun.method} {a.dryRun.url}
                    </span>
                  ) : (
                    <span className="text-fog">{a.dryRun?.detail ?? "not run"}</span>
                  )}
                </Field>
                <Field k="Executor dry-run">{a.executorDryRunMatched ? <span className="text-paper">matched this exact payload</span> : <span className="text-silver-hi">no identical dry-run recorded by the gateway</span>}</Field>
                <Field k="Expected calls">{a.expectedCalls}</Field>
                <Field k="Expected cost">{a.estimatedCost || "not material"}</Field>
                <Field k="Idempotency risk">{a.idempotent ? "Idempotent" : "Not idempotent: runs exactly once and is never retried after an ambiguous result"}</Field>
              </dl>
              <div className="mt-2">
                <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-silver">Resolved payload</div>
                <pre className="code-block max-h-72 overflow-auto rounded-[4px] border border-rim bg-ground p-3 text-silver-hi" data-testid="approval-payload">
                  {JSON.stringify(payloadOf(a), null, 2)}
                </pre>
              </div>
              {a.problems.length > 0 && (
                <ul className="mt-2 space-y-1 text-[12.5px] text-fog">
                  {a.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              {st?.outcome?.summary && <p className="mt-2 text-[12.5px] text-silver-hi">Outcome: {st.outcome.summary}</p>}
            </li>
          );
        })}
      </ol>
      <div className="mt-3">
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}
