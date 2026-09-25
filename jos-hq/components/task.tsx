"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiSend } from "@/lib/client/api";
import type { HqEventView } from "@/lib/client/stream";
import { MODE_TEXT, STATUS_TEXT, clock, markText, span, statusTone, when, type Tone } from "@/lib/client/format";
import { stationsFor, markFor } from "@/lib/client/stations";
import { Button, ErrorNote, Mark, Menu, Modal, Status, Tabs, TestStrip, Timer, cx } from "./ui";
import { Markdown } from "./markdown";
import { ApprovalModal, payloadOf, type ApprovalView } from "./approval";
import { MODE_OPTIONS, type ModeChoice } from "./composer";

export interface ExecutionView {
  id: string;
  phase: string;
  workspace: string;
  cwd: string;
  runtime: string;
  model: string;
  effort: string;
  pid: number | null;
  status: string;
  verified: number;
  verified_model: string | null;
  verified_effort: string | null;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  error: string | null;
}
export interface LineView {
  workspace: string;
  position: number;
  ordinal: string;
  ahead: { taskId: string | null; title: string; status: string } | null;
  heldBy: Array<{ kind: string; taskId: string | null; title: string; status: string }>;
}
/** Why a line is stuck, if it is: a task that needs reconciling, or an orphaned executor still running. */
export function lineHeldNote(line: LineView): string {
  const stuck = line.heldBy.find((h) => h.status === "needs_reconciliation");
  if (!stuck) return "";
  return stuck.kind === "execution" ? ` · held by an orphaned executor from “${stuck.title}”` : " · held by a task that needs reconciling";
}
export interface TaskView {
  id: string;
  chat_id: string | null;
  origin: string;
  title: string;
  request: string;
  mode: string;
  route_selection: string;
  route: string | null;
  route_reason: string | null;
  status: string;
  stage: string;
  log_file: string | null;
  log_status: string | null;
  planner_model: string | null;
  verification: string;
  error: string | null;
  created_at: string;
  ended_at: string | null;
  plan: Record<string, unknown> | null;
  result: { answer?: string } | null;
  context: { pendingQuestion?: { kind: string; question: string; options: Array<{ value: string; label: string }> } | null };
  approvals: ApprovalView[];
  executions: ExecutionView[];
  line?: LineView | null;
}

export const ACTIVE = ["queued", "routing", "discovering", "in_line", "planning", "dispatching", "executing", "verifying"];
export const WAITING = ["needs_clarification", "awaiting_approval"];

const STAGE_TEXT: Record<string, string> = {
  understand: "Understand",
  route: "Route",
  log: "Open log",
  discover: "Discover environment",
  queue: "Wait in line",
  plan: "Plan",
  validate: "Validate plan",
  prompt: "Prepare executor prompt",
  launch: "Launch executor",
  execute: "Execute",
  approve: "Awaiting approval",
  verify: "Verify",
  close: "Close log",
  respond: "Respond",
};
/** Statuses whose stage only repeats them ("Awaiting approval · Awaiting approval", "Executing · Execute"). */
const STAGE_SAID_BY_STATUS = ["awaiting_approval", "executing", "verifying"];

/** Live events for one task (all visibilities), replayed from the start. */
export function useTaskEvents(taskId: string | null) {
  const [events, setEvents] = useState<HqEventView[]>([]);
  useEffect(() => {
    if (!taskId) return;
    setEvents([]);
    const es = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events`);
    es.addEventListener("hq", (e) => {
      try {
        const ev = JSON.parse((e as MessageEvent).data) as HqEventView;
        setEvents((list) => (list.some((x) => x.id === ev.id) ? list : [...list.slice(-2500), ev]));
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }, [taskId]);
  return events;
}

const label = "text-[11px] font-bold uppercase tracking-[0.14em] text-silver";

/** The session row (spec 2.3): Route, Mode, Planner, Executor, Log and Elapsed, with the test strip beneath. */
export function SessionRow({ task, className }: { task: TaskView; className?: string }) {
  const exec = [...task.executions].reverse().find((e) => e.phase !== "plan") ?? null;
  const plan = task.executions.find((e) => e.phase === "plan") ?? null;
  const live = ACTIVE.includes(task.status) || WAITING.includes(task.status);
  const cells: Array<[string, string]> = [
    ["Route", task.route === "none" ? "Orchestrator only" : task.route ?? "not routed yet"],
    ["Mode", MODE_TEXT[task.mode] ?? task.mode],
    ["Planner", plan ? `${plan.verified_model ?? plan.model} · ${plan.verified_effort ?? plan.effort}` : task.planner_model ?? "—"],
    ["Executor", exec ? `${exec.runtime} · ${exec.verified_model ?? exec.model} · ${exec.verified_effort ?? exec.effort}` : "—"],
    ["Log", task.log_file ? `${task.log_file} · ${task.log_status ?? "open"}` : "—"],
  ];
  return (
    <section aria-label="Session" data-testid="session-row" className={cx("px-3 py-3 sm:px-5", className)}>
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          {/* Route and Mode are short; they size to their content so Planner, Executor and Log get the room. */}
          <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-5 gap-y-1.5 sm:grid-cols-[auto_auto_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)]">
            {cells.map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className={label}>{k}</dt>
                <dd className="truncate text-[12.5px] text-paper" title={v}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
          {live ? (
            <Timer since={task.created_at} size="sm" />
          ) : (
            <div className="shrink-0 text-right">
              <div className={label}>Took</div>
              <div className="mt-0.5 text-[20px] font-extralight leading-none text-paper">{task.ended_at ? span(task.created_at, task.ended_at) : "—"}</div>
            </div>
          )}
        </div>
        <TestStrip stations={stationsFor(task)} compact />
      </div>
    </section>
  );
}

export function TaskProgress({ task, events, onDetails, onChanged }: { task: TaskView; events: HqEventView[]; onDetails: () => void; onChanged: () => void }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [stopping, setStopping] = useState(false);
  const latest = [...events].reverse().find((e) => ["executor_output", "connection_used", "one_cli", "gateway_blocked", "subagent_started", "launch_verified", "planning_started", "runtime_discovery_started", "identity_verified"].includes(e.type) && e.summary);
  const exec = task.executions.find((e) => e.status === "running" || e.status === "starting");
  const stop = async (force: boolean) => {
    setStopping(true);
    setError(null);
    try {
      await apiSend("POST", `/api/tasks/${task.id}/cancel`, { force });
      setConfirm(null);
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === "CANCEL_NEEDS_CONFIRMATION") setConfirm(e.message);
      else setError(e as Error);
    } finally {
      setStopping(false);
    }
  };
  const mark = markFor(task);
  const statusText = STATUS_TEXT[task.status] ?? task.status;
  const stageText = STAGE_TEXT[task.stage] ?? task.stage;
  // The stage only earns its place when it says more than the status beside it.
  const showStage = !STAGE_SAID_BY_STATUS.includes(task.status) && stageText !== statusText;
  return (
    <div className={cx("rounded-[6px] border bg-room px-4 py-3", WAITING.includes(task.status) ? "border-safe" : "border-rim")} data-testid="task-progress">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
          <Mark tone={mark.tone}>{mark.text}</Mark>
          <span className="text-paper">{statusText}</span>
          {showStage && <span className="text-silver">{stageText}</span>}
          {exec && (
            <span className="text-silver">
              {exec.runtime} · {exec.model} · {exec.effort} · pid {exec.pid}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onDetails}>
            Run details
          </Button>
          <Button size="sm" variant="danger" onClick={() => void stop(false)} disabled={stopping} data-testid="task-stop">
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        </div>
      </div>
      {task.status === "in_line" && task.line ? (
        <p className="mt-2 truncate text-[12.5px] text-silver-hi" data-testid="task-line" title={`${task.line.ordinal} in line for ${task.line.workspace}${task.line.ahead ? ` · behind “${task.line.ahead.title}”` : ""}${lineHeldNote(task.line)}`}>
          {task.line.ordinal} in line for {task.line.workspace}
          {task.line.ahead ? ` · behind “${task.line.ahead.title}”` : ""}
          {lineHeldNote(task.line)}
          {task.line.heldBy
            .filter((h) => h.kind === "execution" && h.status === "needs_reconciliation" && h.taskId)
            .slice(0, 1)
            .map((h) => (
              <Link key={h.taskId} href={`/tasks/${h.taskId}`} className="ml-1 text-paper underline">
                open it to terminate
              </Link>
            ))}
        </p>
      ) : (
        latest && (
          <p className="mt-2 truncate text-[12.5px] text-silver" title={latest.summary ?? undefined}>
            {latest.summary}
          </p>
        )
      )}
      <ErrorNote error={error} />
      {confirm && (
        <Modal
          open
          onClose={() => setConfirm(null)}
          title="Stop while an approved action is running?"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Let it finish
              </Button>
              <Button variant="danger" onClick={() => void stop(true)}>
                Stop now
              </Button>
            </>
          }
        >
          <p className="text-[13px] text-silver-hi">{confirm}</p>
          <p className="mt-2 text-[13px] text-silver">If you stop now, HQ marks the run “needs reconciliation” and never retries the action. You will need to check in the platform whether it happened.</p>
        </Modal>
      )}
    </div>
  );
}

const DETAIL_TABS = [
  { value: "all", label: "All" },
  { value: "planner", label: "Planner" },
  { value: "executor", label: "Executor" },
  { value: "connections", label: "Connections" },
  { value: "verification", label: "Verification" },
  { value: "errors", label: "Errors" },
] as const;
type DetailTab = (typeof DETAIL_TABS)[number]["value"];

function matches(tab: DetailTab, e: HqEventView) {
  if (tab === "all") return true;
  if (tab === "planner") return /^planning|plan_|route_decision|understand|runtime_discovery/.test(e.type);
  if (tab === "executor") return /^executor|subagent|launch_|model_substitution/.test(e.type);
  if (tab === "connections") return /connection_used|one_cli|gateway_blocked|approved_action/.test(e.type);
  if (tab === "verification") return /verification|identity|launch_verif/.test(e.type);
  return e.level === "error" || e.level === "warning";
}

export function RunDetails({ task, events, onClose }: { task: TaskView; events: HqEventView[]; onClose: () => void }) {
  const [tab, setTab] = useState<DetailTab>("all");
  const [open, setOpen] = useState<number | null>(null);
  const list = useMemo(() => events.filter((e) => matches(tab, e)), [events, tab]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [list.length]);
  return (
    <aside className="fixed inset-y-0 right-0 z-[80] flex w-full max-w-[620px] flex-col border-l border-rim-strong bg-room shadow-[-30px_0_60px_-30px_rgba(0,0,0,0.9)]" aria-label="Run details" data-testid="run-details">
      <header className="border-b border-rim px-5 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-bold text-paper">Run details</h2>
            <p className="truncate text-[12px] text-silver" title={task.title}>
              {task.title} · {task.id}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close run details" className="rounded-[4px] p-1 text-silver hover:bg-tray hover:text-paper">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
        {task.executions.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <caption className="sr-only">Executor launches</caption>
              <thead className="text-silver">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-semibold">Phase</th>
                  <th scope="col" className="py-1 pr-3 font-semibold">Runtime</th>
                  <th scope="col" className="py-1 pr-3 font-semibold">Model · effort</th>
                  <th scope="col" className="py-1 pr-3 font-semibold">pid</th>
                  <th scope="col" className="py-1 pr-3 font-semibold">Launch</th>
                  <th scope="col" className="py-1 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {task.executions.map((x) => (
                  <tr key={x.id} className="border-t border-rim align-top text-silver-hi">
                    <td className="py-1 pr-3">{x.phase}</td>
                    <td className="py-1 pr-3">{x.runtime}</td>
                    <td className="py-1 pr-3">
                      {x.verified_model ?? x.model} · {x.verified_effort ?? x.effort}
                    </td>
                    <td className="tabular py-1 pr-3">{x.pid ?? "—"}</td>
                    <td className="py-1 pr-3">{x.verified ? <span className="text-paper">verified</span> : <span className="text-silver">unverified</span>}</td>
                    <td className="py-1">
                      <Status tone={statusTone(x.status === "exited" ? "completed" : x.status)}>{x.status}</Status>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 truncate text-[12px] text-silver" title={task.executions[0]?.cwd}>
              cwd {task.executions[0]?.cwd}
            </p>
          </div>
        )}
        <div className="mt-3">
          <Tabs label="Filter events" value={tab} onChange={setTab} tabs={DETAIL_TABS.map((t) => ({ value: t.value, label: t.label }))} />
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-3">
        {list.length === 0 && <p className="text-[12.5px] text-silver">No events in this view yet.</p>}
        <ol className="space-y-1">
          {list.map((e) => (
            <li key={e.id} className="rounded-[4px] px-2 py-1 hover:bg-tray">
              <button type="button" className="grid w-full grid-cols-[64px_48px_1fr] gap-2 text-left" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                <span className="tabular text-[12px] text-silver">{clock(e.createdAt)}</span>
                <span className="truncate text-[12px] text-silver-hi">{e.system === "orchestrator" ? "orch" : e.system}</span>
                <span className={cx("min-w-0 text-[12.5px]", e.level === "error" ? "text-fog" : e.level === "success" ? "text-paper" : "text-silver-hi")}>
                  <span className="mr-1.5 text-[12px] text-silver">{e.type}</span>
                  <span className="break-words">{e.summary}</span>
                </span>
              </button>
              {open === e.id && e.data !== null && e.data !== undefined && <pre className="code-block mt-1 max-h-80 overflow-auto rounded-[4px] border border-rim bg-ground p-2 text-silver-hi">{typeof e.data === "string" ? e.data : JSON.stringify(e.data, null, 2)}</pre>}
            </li>
          ))}
        </ol>
        <div ref={end} />
      </div>
    </aside>
  );
}

// ---- message cards -----------------------------------------------------------------------------

/** HQ's route line: where the task went and why. */
export function RouteCard({ data }: { data: { workspace?: string; reason?: string; warnings?: string[] } | null }) {
  return (
    <div className="border-l border-rim-strong pl-3" data-testid="route-card">
      <p className="text-[12.5px] text-silver">
        <span className={label}>Route</span> <span className="font-bold text-paper">{data?.workspace === "none" ? "Orchestrator only" : data?.workspace}</span>
        <span aria-hidden> · </span>
        <span className="text-silver-hi" data-testid="route-reason">
          {data?.reason}
        </span>
      </p>
      {(data?.warnings ?? []).length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[12px] text-silver-hi">
          {data!.warnings!.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ClarifyCard({ task, message, data, active, onAnswered }: { task: TaskView | undefined; message: string; data: { kind?: string; reason?: string; options?: Array<{ value: string; label: string }> } | null; active: boolean; onAnswered: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const answer = async (v: string) => {
    if (!task) return;
    setBusy(v);
    setError(null);
    try {
      await apiSend("POST", `/api/tasks/${task.id}/clarify`, { answer: v });
      onAnswered();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={cx("rounded-[6px] border bg-room px-4 py-3", active ? "border-safe" : "border-rim")} data-testid="clarify-card">
      <div className="flex flex-wrap items-center gap-2">
        <Mark tone={active ? "you" : "plan"}>{active ? "Needs you" : "Asked"}</Mark>
        <span className="text-[12.5px] text-silver-hi">{data?.kind === "route" ? "Which business is this for?" : data?.kind === "mailbox" ? "Which mailbox?" : "The executor needs your input"}</span>
      </div>
      {data?.reason && <p className="mt-2 text-[12.5px] text-silver">{data.reason}</p>}
      <p className="mt-2 max-w-[76ch] text-[14px] text-paper">{message}</p>
      {active && (data?.options ?? []).length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {data!.options!.map((o) => (
            <Button key={o.value} size="sm" onClick={() => void answer(o.value)} disabled={!!busy}>
              {busy === o.value ? "Sending…" : o.label}
            </Button>
          ))}
        </div>
      )}
      {active && <p className="mt-2 text-[12px] text-silver">Or type your answer below.</p>}
      <ErrorNote error={error} />
    </div>
  );
}

/**
 * A plan, with Execute this plan while its task is planned. The plan task stays planned after a start, so the
 * card itself says it has run: `started` comes from the conversation (a later "Execute the plan" message).
 */
export function PlanCard({ task, data, onStarted, started = false }: { task: TaskView | undefined; data: { plan?: Record<string, unknown>; model?: string; problems?: string[] } | null; onStarted: (taskId: string) => void; started?: boolean }) {
  // A version-2 plan from a planning session; `normalized_objective` and `strategy` are read only from plans made before 2026-09-24.
  const plan = (data?.plan ?? {}) as {
    objective?: string;
    normalized_objective?: string;
    success_condition?: string;
    steps?: Array<{ n: number; kind: string; description: string; platform: string; action_id: string; side_effect: boolean }>;
    strategy?: string[];
    connections?: Array<{ platform: string; connection_name: string }>;
    flow_design?: { needed: boolean; key: string; outline: string[] };
    verification?: string[];
    risks?: string[];
    intent_questions?: string[];
  };
  const [mode, setMode] = useState<ModeChoice>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);
  const flags = (data?.problems ?? []).length;
  const run = async () => {
    if (!task) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiSend<{ taskId: string }>("POST", `/api/tasks/${task.id}/execute-plan`, { mode });
      setStartedId(r.taskId);
      onStarted(r.taskId);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };
  const section = (title: string, items?: string[]) =>
    items && items.length > 0 ? (
      <div className="mt-3">
        <div className={label}>{title}</div>
        <ol className="mt-1 max-w-[76ch] list-decimal space-y-0.5 pl-5 text-[13px] text-silver-hi">
          {items.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      </div>
    ) : null;
  return (
    <div className="rounded-[6px] border border-rim bg-room px-4 py-3" data-testid="plan-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.16em] text-silver-hi">Plan</h3>
        <span className="text-[12px] text-silver">
          by {data?.model ?? "the planner"}
          {flags ? ` · ${flags} flag${flags === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      <p className="mt-1.5 max-w-[76ch] text-[14px] text-paper">{plan.objective ?? plan.normalized_objective}</p>
      {plan.success_condition && (
        <p className="mt-2 max-w-[76ch] text-[13px] text-silver-hi">
          <span className="text-silver">Done when: </span>
          {plan.success_condition}
        </p>
      )}
      {plan.steps && plan.steps.length > 0 ? (
        <div className="mt-3">
          <div className={label}>Steps</div>
          <ol className="mt-1 max-w-[76ch] space-y-1.5">
            {plan.steps.map((s) => (
              <li key={s.n} className="grid grid-cols-[22px_minmax(0,1fr)] gap-2 text-[13px]">
                <span className="text-silver">{s.n}</span>
                <span className="min-w-0">
                  <span className="text-silver-hi">{s.description}</span>
                  {(s.action_id || s.side_effect) && (
                    <span className="block text-[12px] text-silver">
                      {s.action_id ? `${s.platform} · ${s.action_id}` : ""}
                      {s.action_id && s.side_effect ? " · " : ""}
                      {s.side_effect ? <span className="text-paper">needs approval</span> : null}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        section("Steps", plan.strategy)
      )}
      {section("Connections", (plan.connections ?? []).map((c) => `${c.connection_name} (${c.platform})`))}
      {plan.flow_design?.needed ? section(`One Flow ${plan.flow_design.key}`, plan.flow_design.outline) : null}
      {section("Verification", plan.verification)}
      {section("Risks", plan.risks)}
      {section("Open intent questions", plan.intent_questions)}
      {flags > 0 && section("Flagged by HQ's check", data!.problems)}
      {task?.status === "planned" && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-rim pt-3">
          {startedId ? (
            <p className="text-[12.5px] text-silver-hi">
              Started ·{" "}
              <Link href={`/tasks/${startedId}`} className="text-paper underline">
                open the task
              </Link>
            </p>
          ) : started ? (
            <p className="text-[12.5px] text-silver-hi">Already started from this plan.</p>
          ) : (
            <>
              <Menu<ModeChoice> label="Execution mode" value={mode} onChange={setMode} options={MODE_OPTIONS.filter((m) => m.value !== "plan")} />
              <Button variant="primary" size="sm" onClick={() => void run()} disabled={busy} data-testid="execute-plan">
                {busy ? "Starting…" : "Execute this plan"}
              </Button>
              <span className="text-[12px] text-silver">
                {mode === "auto" ? "Runs as a new task with its own log entry. In Auto, HQ approves its validated side effects without asking." : "Runs as a new task with its own log entry; side effects wait for your approval."}
              </span>
            </>
          )}
        </div>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

/** The Expose station: the exact actions, then the line past which what happens happens. */
export function ApprovalCard({ task, approval, onOpen, onResolved }: { task: TaskView | undefined; approval: ApprovalView | undefined; onOpen: () => void; onResolved?: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [error, setError] = useState<Error | null>(null);
  const [flash, setFlash] = useState(false);
  // Once HQ has accepted a decision, the card stays decided until the reload shows it resolved: runs once.
  const [decided, setDecided] = useState(false);
  if (!approval) return null;
  const pending = approval.status === "pending";
  const auto = approval.status === "approved" && !!approval.resolutionNote?.startsWith("Auto mode");
  const blocked = approval.actions.some((a) => a.problems.length > 0);
  const act = async (what: "approve" | "reject") => {
    setBusy(what);
    setError(null);
    try {
      await apiSend("POST", `/api/approvals/${approval.id}/${what}`, { note: note.trim() || null });
      setDecided(true);
      if (what === "approve") setFlash(true);
      onResolved?.();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-label="Expose" data-testid="approval-card" data-approval-id={approval.id} onAnimationEnd={() => setFlash(false)} className={cx("scroll-mt-4 rounded-[6px] border bg-room", pending ? "border-safe" : "border-rim", flash && "expose-flash")}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-rim px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Mark tone={pending ? "you" : approval.status === "approved" ? "fixed" : "pulled"}>{pending ? "Expose" : auto ? "Auto-approved" : approval.status}</Mark>
          <span className="text-[12.5px] text-silver-hi">
            {approval.actions.length === 1 ? "1 action" : `${approval.actions.length} actions`}
            {pending ? (task ? " · nothing has been sent, published, deleted or charged" : "") : approval.resolvedAt ? ` · ${when(approval.resolvedAt)}` : ""}
          </span>
        </div>
        <Button size="sm" variant="ghost" onClick={onOpen} data-testid="approval-open">
          Review payload
        </Button>
      </header>
      <ol className="divide-y divide-rim">
        {approval.actions.map((a) => (
          <li key={a.index} className="px-4 py-3">
            <p className="text-[13.5px] font-semibold text-paper">
              {approval.actions.length > 1 ? `${a.index}. ` : ""}
              {a.title}
            </p>
            <dl className="mt-2 grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
              <dt className="text-silver">{a.kind === "one_flow" ? "Flow" : "Action"}</dt>
              <dd className="min-w-0 break-words text-silver-hi">{a.kind === "one_flow" ? a.flowKey : `${a.method ?? "?"} ${a.actionId ?? ""}`}</dd>
              <dt className="text-silver">Connection</dt>
              <dd className="min-w-0 break-words text-silver-hi">
                {a.connectionName ?? "—"} · {a.platform}
              </dd>
              <dt className="text-silver">Target</dt>
              <dd className="min-w-0 break-words text-silver-hi">{a.target ?? "—"}</dd>
              <dt className="text-silver">Inputs</dt>
              <dd className="min-w-0">
                <pre className="code-block max-h-40 overflow-auto rounded-[4px] border border-rim bg-ground p-2 text-silver-hi">{JSON.stringify(payloadOf(a), null, 2)}</pre>
              </dd>
              <dt className="text-silver">HQ dry-run</dt>
              <dd className="min-w-0 break-words">{a.dryRun?.ok ? <span className="text-paper">{`${a.dryRun.method} ${a.dryRun.url}`}</span> : <span className="text-fog">{a.dryRun?.detail ?? "not run"}</span>}</dd>
              <dt className="text-silver">Side effect</dt>
              <dd className="min-w-0 break-words text-paper">{a.sideEffect || "—"}</dd>
              <dt className="text-silver">Runs</dt>
              <dd className="text-silver-hi">{a.idempotent ? "once; safe to repeat" : "once; never retried after an ambiguous result"}</dd>
            </dl>
            {a.problems.length > 0 && (
              <ul className="mt-2 space-y-1 text-[12.5px] text-fog">
                {a.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      {pending && (
        <footer className="px-4 pb-4">
          <p className="border-t border-dashed border-safe pt-2 text-[11px] font-bold uppercase tracking-[0.14em] text-safe">Past this point it happens · runs once</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Approval note" className="h-8 min-w-[160px] flex-1 rounded-[4px] border border-rim bg-ground px-3 text-[12.5px] text-paper placeholder:text-silver" />
            <Button size="sm" variant="danger" onClick={() => void act("reject")} disabled={!!busy || decided} data-testid="expose-reject">
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </Button>
            <Button size="sm" variant="primary" onClick={() => void act("approve")} disabled={!!busy || decided || blocked} title={blocked ? "Resolve the validation problems first; reject instead" : undefined} data-testid="expose-approve">
              {busy === "approve" ? "Exposing…" : "Approve · expose"}
            </Button>
          </div>
          <ErrorNote error={error} />
        </footer>
      )}
    </section>
  );
}

const VERIFICATION_TEXT: Record<string, { label: string; tone: Tone }> = {
  verified: { label: "Verified complete", tone: "fixed" },
  execution_complete: { label: "Execution complete · not verified", tone: "unfixed" },
  failed: { label: "Not verified", tone: "fog" },
  none: { label: "", tone: "plan" },
};

export function ResultCard({ content, data, createdAt }: { content: string; data: { status?: string; verification?: string; outcome?: string; artifacts?: string | null; route?: string | null; logFile?: string | null; logStatus?: string | null } | null; createdAt?: string }) {
  // A result develops in once, when it has just arrived; one already on the page when it loads is dry.
  const [fresh] = useState(() => !!createdAt && Date.now() - Date.parse(createdAt) < 15_000);
  const [more, setMore] = useState(false);
  const status = data?.status ?? "";
  const v = VERIFICATION_TEXT[data?.verification ?? "none"];
  const long = STATUS_TEXT[status];
  return (
    <div className={cx("space-y-2", fresh && "develop")} data-testid="result-card">
      <div className="flex flex-wrap items-center gap-2">
        <Mark tone={statusTone(status)}>{markText(status)}</Mark>
        {long && long !== markText(status) && <span className="text-[12.5px] text-paper">{long}</span>}
        {v?.label && !["completed", "unverified"].includes(status) ? <Mark tone={v.tone}>{v.label}</Mark> : null}
      </div>
      <Markdown text={content} />
      <button type="button" className="text-[12px] text-silver hover:text-paper" onClick={() => setMore((m) => !m)} aria-expanded={more}>
        {more ? "Hide" : "Show"} outcome, artifacts and log
      </button>
      {more && (
        <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-[4px] border border-rim bg-room px-3 py-2 text-[12.5px]">
          <dt className="text-silver">Outcome</dt>
          <dd className="break-words text-silver-hi">{data?.outcome ?? "—"}</dd>
          <dt className="text-silver">Artifacts</dt>
          <dd className="break-words text-silver-hi">{data?.artifacts || "none"}</dd>
          <dt className="text-silver">J/OS log</dt>
          <dd className="text-silver-hi">
            {data?.logFile ?? "—"} {data?.logStatus ? `(closed as ${data.logStatus})` : ""}
          </dd>
        </dl>
      )}
    </div>
  );
}

/**
 * An executor HQ lost track of (a restart) that may still be running. It holds its workspace's line,
 * so it is offered for termination for as long as it exists, whether or not its task is reconciled.
 */
export function OrphanNotice({ task, onDone }: { task: TaskView; onDone: () => void }) {
  const [error, setError] = useState<Error | null>(null);
  const orphan = task.executions.find((e) => e.status === "needs_reconciliation");
  if (!orphan) return null;
  const kill = async () => {
    setError(null);
    try {
      await apiSend("POST", `/api/executions/${orphan.id}/terminate-orphan`);
      onDone();
    } catch (e) {
      setError(e as Error);
    }
  };
  return (
    <div className="mt-2 text-[12.5px] text-silver-hi" data-testid="orphan-notice">
      <div className="flex flex-wrap items-center gap-2">
        The executor process (pid {orphan.pid}) may still be running unsupervised{task.route && task.route !== "none" ? `, holding ${task.route}'s line` : ""}.
        <Button size="sm" variant="danger" onClick={() => void kill()}>
          Terminate it
        </Button>
      </div>
      <ErrorNote error={error} />
    </div>
  );
}

export function ReconcileCard({ task, onDone }: { task: TaskView; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"partial" | "abandoned" | "blocked" | "done">("partial");
  const [error, setError] = useState<Error | null>(null);
  const submit = async () => {
    setError(null);
    try {
      await apiSend("POST", `/api/tasks/${task.id}/reconcile`, { logStatus: status, note });
      onDone();
    } catch (e) {
      setError(e as Error);
    }
  };
  return (
    <div className="rounded-[6px] border border-safe bg-room px-4 py-3" data-testid="reconcile-card">
      <div className="flex flex-wrap items-center gap-2">
        <Mark tone="you">Needs you</Mark>
        <span className="text-[12.5px] text-paper">{STATUS_TEXT[task.status]}</span>
      </div>
      <p className="mt-1.5 max-w-[76ch] text-[13px] text-silver-hi">{task.error ?? "HQ could not observe how this run ended. Nothing is marked complete by assumption."}</p>
      <OrphanNotice task={task} onDone={onDone} />
      <div className="mt-3 flex flex-wrap items-start gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Close the log entry as" className="h-9 rounded-[4px] border border-rim-strong bg-tray px-2 text-[13px] text-paper">
          <option value="partial">partial</option>
          <option value="abandoned">abandoned</option>
          <option value="blocked">blocked</option>
          <option value="done">done</option>
        </select>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="What actually happened (checked in the platform)?" className="min-w-0 flex-1 basis-[240px] rounded-[4px] border border-rim bg-ground px-3 py-2 text-[13px] text-paper placeholder:text-silver" />
        <Button size="sm" variant="primary" onClick={() => void submit()} disabled={!note.trim()}>
          Record and close
        </Button>
      </div>
      <ErrorNote error={error} />
    </div>
  );
}

export function TaskLink({ id }: { id: string }) {
  return (
    <Link href={`/tasks/${id}`} className="text-[12px] text-silver hover:text-paper">
      {id}
    </Link>
  );
}

export function ApprovalHost({ task, approval, onClose, onResolved }: { task: TaskView; approval: ApprovalView; onClose: () => void; onResolved: () => void }) {
  const exec = task.executions[0];
  const executor = task.route ? `${task.route}${exec ? ` (${exec.runtime}, ${exec.model}, ${exec.effort})` : ""}` : "executor";
  return <ApprovalModal approval={approval} taskTitle={task.title} executor={executor} onClose={onClose} onResolved={onResolved} />;
}
