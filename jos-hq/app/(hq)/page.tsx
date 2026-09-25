"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { apiGet, useApi } from "@/lib/client/api";
import { MODE_TEXT, duration, markText, span, statusTone, usd, when } from "@/lib/client/format";
import { stationsFor, markFor } from "@/lib/client/stations";
import { PageHeader } from "@/components/shell";
import { ApprovalModal, type ApprovalView } from "@/components/approval";
import { Button, ButtonLink, CircleStat, EmptyState, ErrorNote, Mark, Menu, Panel, Status, Tabs, Tag, TestStrip, Timer, cx, useNow, type CircleTone } from "@/components/ui";

type Sys = "all" | "One" | "Studio";
type Range = "today" | "7d" | "30d";

interface BayHolderView {
  kind: "task" | "execution" | "reserved";
  taskId: string | null;
  chatId: string | null;
  title: string;
  status: string;
  mode: string | null;
  stage: string | null;
  since: string | null;
  limitMs: number | null;
  waitingOn: string | null;
  approvalId: string | null;
  executions: Array<{ phase: string; status: string }>;
  approvals: Array<{ status: string }>;
}
interface BayView {
  workspace: "One" | "Studio";
  executor: { runtimeLabel: string; modelLabel: string; model: string; effort: string };
  planner: { modelLabel: string; model: string; effort: string };
  state: "Idle" | "Working" | "Waiting" | "Blocked";
  blocker: string | null;
  holder: BayHolderView | null;
  line: Array<{ taskId: string; chatId: string | null; title: string; mode: string; sentAt: string }>;
}
interface DryingRowView {
  taskId: string;
  chatId: string | null;
  title: string;
  route: string;
  status: string;
  endedAt: string;
  cost: number | null;
}
interface CirclesView {
  tasks: { total: number; completed: number; failed: number; abandoned: number; inLine: number; open: number };
  agents: { total: number; running: number; avgCostUsd: number | null; agentTasks: number; costed: number };
}
interface Dash {
  bench: Record<"One" | "Studio", BayView>;
  drying: DryingRowView[];
  circles: CirclesView;
  topConnections: Array<{ rank: number; platform: string; tool: string; workspaces: string[]; calls: number; lastUsed: string }>;
  activeSubAgents: Array<{ agent: string; workspace: string; task: string; taskId: string | null; status: string; since: string; source: string }>;
}

const RANGE_TEXT: Record<Range, string> = { today: "today", "7d": "in 7 days", "30d": "in 30 days" };
const NEEDS_YOU = ["awaiting_approval", "needs_clarification", "needs_reconciliation", "interrupted"];

const hrefOf = (x: { taskId: string | null; chatId: string | null }) => (x.chatId ? `/chat/${x.chatId}` : x.taskId ? `/tasks/${x.taskId}` : null);

/** "plans + executes on Claude Code Opus 5.5 · medium", or "plans on GPT 6 Astra · executes on GPT 6 Sol". */
function pinsLine(b: BayView): string {
  if (b.planner.model === b.executor.model && b.planner.effort === b.executor.effort) return `plans + executes on ${b.executor.modelLabel} · ${b.executor.effort}`;
  return `plans on ${b.planner.modelLabel} · executes on ${b.executor.modelLabel}`;
}

function HolderPrint({ h, onReview }: { h: BayHolderView; onReview: (approvalId: string) => void }) {
  const href = hrefOf(h);
  const reconcile = h.status === "needs_reconciliation" || h.status === "interrupted";
  const mark = markFor(h);
  return (
    <div data-testid="bay-holder">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold text-paper" title={h.title}>
            {h.title}
          </p>
          <p className="mt-1 text-[12px] text-silver">
            {[h.mode ? MODE_TEXT[h.mode] ?? h.mode : null, h.since ? `started ${when(h.since)}` : null, h.kind === "reserved" ? "held by HQ" : null].filter(Boolean).join(" · ")}
          </p>
          <div className="mt-2.5">
            <Mark tone={mark.tone}>{mark.text}</Mark>
          </div>
        </div>
        {h.since && <Timer since={h.since} size="sm" limitLabel={h.limitMs ? span(new Date(0).toISOString(), new Date(h.limitMs).toISOString()) : undefined} />}
      </div>
      {h.taskId && <TestStrip stations={stationsFor(h)} compact className="mt-4" />}
      {h.waitingOn && (
        <p className="mt-3 text-[12.5px] text-silver-hi">
          Waits on <span className="text-paper">{h.waitingOn}</span>
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {h.status === "awaiting_approval" && h.approvalId && (
          <Button variant="primary" size="sm" onClick={() => onReview(h.approvalId!)} data-testid="bay-approve">
            Approve · expose
          </Button>
        )}
        {h.status === "needs_clarification" && href && (
          <ButtonLink variant="primary" href={href}>
            Answer
          </ButtonLink>
        )}
        {reconcile && h.taskId && (
          <ButtonLink variant="primary" href={`/tasks/${h.taskId}`}>
            Reconcile
          </ButtonLink>
        )}
        {href && <ButtonLink href={href}>Open</ButtonLink>}
      </div>
    </div>
  );
}

function BayBox({ bay, onReview }: { bay: BayView; onReview: (approvalId: string, ws: "One" | "Studio") => void }) {
  const h = bay.holder;
  const lit = !!h && NEEDS_YOU.includes(h.status);
  return (
    <section
      aria-labelledby={`bay-${bay.workspace}-title`}
      data-testid={`bay-${bay.workspace}`}
      className={cx("flex min-w-0 flex-col rounded-[6px] border bg-room shadow-[0_16px_30px_-22px_rgba(0,0,0,0.95)]", lit ? "border-safe" : bay.blocker ? "border-fog/60" : "border-rim")}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rim px-4 py-3">
        <h2 id={`bay-${bay.workspace}-title`} className="text-[15px] font-bold text-paper">
          {bay.workspace}
        </h2>
        <p className="min-w-0 truncate text-[12px] text-silver" title={pinsLine(bay)}>
          {pinsLine(bay)}
        </p>
      </header>
      {bay.blocker && (
        <p role="status" className="border-b border-rim px-4 py-2 text-[12.5px] text-fog">
          Blocked · {bay.blocker}
        </p>
      )}
      <div className="p-4">
        {h ? (
          <HolderPrint h={h} onReview={(id) => onReview(id, bay.workspace)} />
        ) : (
          <EmptyState compact title="Bay free." body={bay.line.length ? "The first task in line starts by itself." : "Nothing holds this workspace. A task routed here starts at once."} />
        )}
      </div>
      <div className="mt-auto border-t border-rim px-4 py-3">
        <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-silver">Line{bay.line.length ? ` · ${bay.line.length}` : ""}</h3>
        {bay.line.length === 0 ? (
          <p className="text-[12.5px] text-silver">Line empty.</p>
        ) : (
          <ol className="space-y-1.5">
            {bay.line.map((l, i) => (
              <li key={l.taskId}>
                {/* Below sm a negative's title takes up to two lines, with its mode and time beneath; from sm up, one row. */}
                <Link href={hrefOf(l) ?? "/"} title={l.title} className="flex items-start gap-3 rounded-[4px] border border-dashed border-rim-strong px-3 py-2 text-[12.5px] transition-colors duration-200 ease-out-expo hover:border-silver sm:items-center">
                  <span className="w-5 shrink-0 text-silver">{i + 1}</span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
                    <span className="line-clamp-2 min-w-0 text-silver-hi sm:block sm:flex-1 sm:truncate">{l.title}</span>
                    <span className="shrink-0 text-silver">
                      {MODE_TEXT[l.mode] ?? l.mode} · {when(l.sentAt)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

type CircleStatProps = Parameters<typeof CircleStat>[0];

/**
 * The top band: the range's tasks by how they ended, the line against open work now, and the sub-agents.
 * Until the dashboard has answered, its frame and labels stand with "—" in every circle.
 */
function Circles({ c, system, range, failed }: { c: CirclesView | null; system: Sys; range: Range; failed: boolean }) {
  const pending: Omit<CircleStatProps, "label" | "tone"> = { value: 0, of: null, centre: "—" };
  const circle = (label: string, tone: CircleTone, stat: Omit<CircleStatProps, "label" | "tone"> | undefined) => <CircleStat key={label} label={label} tone={tone} {...(stat ?? pending)} />;
  const t = c?.tasks;
  const a = c?.agents;
  const head = "mb-4 text-[11px] font-bold uppercase tracking-[0.16em] text-silver-hi";
  return (
    <section aria-label="At a glance" data-testid="circles" className="mb-6 grid gap-x-8 gap-y-4 rounded-[6px] border border-rim bg-room p-4 shadow-[0_16px_30px_-22px_rgba(0,0,0,0.95)] xl:grid-cols-[minmax(0,4fr)_minmax(0,3fr)]">
      <div className="min-w-0">
        <h2 className={head}>Tasks · {RANGE_TEXT[range]}</h2>
        <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-4">
          {circle("Completed", "fixed", t && { value: t.completed, of: t.total })}
          {circle("In line", "silver-hi", t && { value: t.inLine, of: t.open })}
          {circle("Failed", "fog", t && { value: t.failed, of: t.total })}
          {circle("Abandoned", "silver", t && { value: t.abandoned, of: t.total })}
        </div>
      </div>
      <div className="min-w-0 border-t border-rim pt-4 xl:border-l xl:border-t-0 xl:pl-8 xl:pt-0">
        <h2 className={head}>Agents</h2>
        <div className="grid grid-cols-3 gap-x-3 gap-y-5">
          {circle("Agents created", "paper", a && { value: a.total, of: a.total })}
          {circle("Running", "paper", a && { value: a.running, of: a.total })}
          {circle("Avg cost", "silver-hi", a && { value: a.costed, of: a.agentTasks, centre: a.avgCostUsd === null ? "$0.00" : usd(a.avgCostUsd) })}
        </div>
      </div>
    </section>
  );
}

/** Until the dashboard has answered, a panel says so; its empty state is only for data that arrived empty. */
function Pending({ failed }: { failed: boolean }) {
  return <p className="text-[12.5px] text-silver">{failed ? "Not loaded; the error is above." : "Loading…"}</p>;
}

/** The fold's depth in px: up to 28 while rows sit below the scroll box's bottom edge, 0 once it reaches the end. */
function useFold<T extends HTMLElement>(content: unknown) {
  const ref = useRef<T>(null);
  const [fold, setFold] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setFold(Math.round(Math.min(28, Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop))));
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [content]);
  return [ref, { "--fold": `${fold}px` } as CSSProperties] as const;
}

/** The finished rows. The list scrolls in its panel; its bottom edge fades into the room rather than slicing a row. */
function DryingRows({ rows }: { rows: DryingRowView[] }) {
  const [ref, foldStyle] = useFold<HTMLOListElement>(rows);
  return (
    <ol ref={ref} data-testid="drying-line" aria-label="Finished tasks" className="fold max-h-[480px] overflow-y-auto" style={foldStyle}>
      {rows.map((r) => {
        const meta = [when(r.endedAt), r.taskId.slice(-6), r.route, r.cost === null ? null : usd(r.cost)].filter((v): v is string => !!v);
        return (
          <li key={r.taskId} className="border-b border-rim last:border-0">
            <Link
              href={hrefOf(r) ?? "/"}
              title={r.title}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 transition-colors duration-200 ease-out-expo hover:bg-tray sm:grid-cols-[56px_64px_40px_minmax(0,1fr)_64px_auto]"
            >
              <span className="tabular hidden text-[12.5px] text-silver sm:inline">{when(r.endedAt)}</span>
              <span className="hidden text-[12px] text-silver sm:inline">{r.taskId.slice(-6)}</span>
              <span className="hidden text-[12.5px] text-silver-hi sm:inline">{r.route}</span>
              <span className="min-w-0">
                <span className="line-clamp-2 text-[13px] text-paper sm:block sm:truncate">{r.title}</span>
                {/* Below sm the time, id, workspace and cost sit on a line of their own under the title; it wraps, never cuts. */}
                <span className="tabular mt-0.5 flex flex-wrap gap-x-[1ch] text-[12px] text-silver sm:hidden">
                  {meta.map((v, i) => (
                    <span key={i} className="whitespace-nowrap">
                      {v}
                      {i < meta.length - 1 ? " ·" : ""}
                    </span>
                  ))}
                </span>
              </span>
              <span className="tabular hidden text-right text-[12.5px] text-silver sm:inline">{r.cost === null ? "" : usd(r.cost)}</span>
              <Mark tone={statusTone(r.status)}>{markText(r.status)}</Mark>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

function DryingLine({ rows, failed }: { rows: DryingRowView[] | null; failed: boolean }) {
  if (!rows) {
    return (
      <div className="p-4">
        <Pending failed={failed} />
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div className="p-4">
        <EmptyState compact title="No finished tasks in this range." body="Finished tasks dry here, newest first." />
      </div>
    );
  }
  return (
    <>
      <DryingRows rows={rows} />
      {rows.some((r) => r.cost !== null) && (
        <p className="border-t border-rim px-4 py-2 text-[12px] text-silver">
          <span className="block max-w-[76ch]">Costs are what each run reported: Claude Code at list price, planning included. Codex reports none.</span>
        </p>
      )}
    </>
  );
}

export default function DashboardPage() {
  const [system, setSystem] = useState<Sys>("all");
  const [range, setRange] = useState<Range>("7d");
  const [top, setTop] = useState<"overall" | "One" | "Studio">("overall");
  const [subs, setSubs] = useState<"all" | "One" | "Studio">("all");
  const [review, setReview] = useState<{ approval: ApprovalView; title: string; executor: string } | null>(null);
  const [reviewError, setReviewError] = useState<Error | null>(null);
  const now = useNow(1000);
  const { data, error, reload } = useApi<Dash>(`/api/dashboard?system=${system}&range=${range}&top=${top}&subs=${subs}`, ["task_updated", "event", "health_updated", "agents_updated", "approval_required", "approval_resolved"]);
  const maxCalls = Math.max(1, ...(data?.topConnections ?? []).map((c) => c.calls));

  // Approve · expose opens the exact payload; nothing is approved from the bench without seeing it.
  const openReview = useCallback(async (approvalId: string, ws: "One" | "Studio") => {
    setReviewError(null);
    try {
      const r = await apiGet<{ approval: ApprovalView; task: { title: string } | null }>(`/api/approvals/${approvalId}`);
      setReview({ approval: r.approval, title: r.task?.title ?? "", executor: ws });
    } catch (e) {
      setReviewError(e as Error);
    }
  }, []);

  return (
    <>
      <PageHeader
        code="J1"
        title="Dashboard"
        actions={
          <>
            <Menu<Sys>
              label="System"
              value={system}
              onChange={setSystem}
              align="right"
              options={[
                { value: "all", label: "All systems", description: "One and Studio together" },
                { value: "One", label: "One" },
                { value: "Studio", label: "Studio" },
              ]}
            />
            <Menu<Range>
              label="Time range"
              value={range}
              onChange={setRange}
              align="right"
              options={[
                { value: "today", label: "Today" },
                { value: "7d", label: "Last 7 days" },
                { value: "30d", label: "Last 30 days" },
              ]}
            />
          </>
        }
      />
      <div className="mb-4 space-y-2 empty:hidden">
        <ErrorNote error={error} />
        <ErrorNote error={reviewError} />
      </div>
      <Circles c={data?.circles ?? null} system={system} range={range} failed={!!error} />
      <section aria-label="Bench" className="grid gap-4 lg:grid-cols-2">
        {data ? (
          (["One", "Studio"] as const).map((ws) => <BayBox key={ws} bay={data.bench[ws]} onReview={(id, w) => void openReview(id, w)} />)
        ) : (
          <p className="text-[13px] text-silver">{error ? "The bench is not loaded; the error is above." : "Loading the bench…"}</p>
        )}
      </section>
      <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Drying line" id="drying" bodyClassName="p-0">
          <DryingLine rows={data ? data.drying : null} failed={!!error} />
        </Panel>
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Most used connections" id="top" actions={<Tabs label="Connection scope" value={top} onChange={setTop} tabs={[{ value: "overall", label: "All" }, { value: "One", label: "One" }, { value: "Studio", label: "Studio" }]} />}>
            {!data ? (
              <Pending failed={!!error} />
            ) : data.topConnections.length === 0 ? (
              <EmptyState compact title="No connection use observed yet." body="Counts come only from real calls HQ saw through the One gateway." />
            ) : (
              <ol className="space-y-3">
                {data.topConnections.map((c) => (
                  <li key={c.platform} className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-3">
                    <span className="tabular text-[12px] text-silver">{c.rank}</span>
                    <div className="min-w-0">
                      <span className="block truncate text-[13px] text-silver-hi">{c.tool}</span>
                      <div className="mt-1.5 h-[2px] bg-rim">
                        <div className="h-[2px] bg-paper" style={{ width: `${Math.max(4, (c.calls / maxCalls) * 100)}%` }} />
                      </div>
                    </div>
                    <span className="tabular text-[13px] text-paper">{c.calls}</span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
          <Panel title="Sub-agents at work" id="subagents" className="flex-1" bodyClassName="p-0" actions={<Tabs label="Sub-agent scope" value={subs} onChange={setSubs} tabs={[{ value: "all", label: "All" }, { value: "One", label: "One" }, { value: "Studio", label: "Studio" }]} />}>
            {!data ? (
              <div className="p-4">
                <Pending failed={!!error} />
              </div>
            ) : data.activeSubAgents.length === 0 ? (
              <div className="p-4">
                <EmptyState compact title="No sub-agent at work." body="Only real runs appear: HQ sub-agent conversations and sub-agents an executor starts." />
              </div>
            ) : (
              <ul>
                {data.activeSubAgents.map((s, i) => (
                  <li key={`${s.agent}-${i}`} className="border-b border-rim px-4 py-2.5 last:border-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2">
                        {s.workspace && <Tag>{s.workspace}</Tag>}
                        <span className="truncate text-[13px] text-silver-hi">{s.agent}</span>
                      </span>
                      <Status tone={statusTone(s.status)}>{s.status}</Status>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-3 text-[12.5px] text-silver">
                      {s.taskId ? (
                        <Link href={`/tasks/${s.taskId}`} title={s.task} className="min-w-0 truncate hover:text-paper hover:underline">
                          {s.task}
                        </Link>
                      ) : (
                        <span className="min-w-0 truncate" title={s.task}>
                          {s.task}
                        </span>
                      )}
                      <span className="tabular shrink-0">{duration(s.since, now)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
      {review && <ApprovalModal approval={review.approval} taskTitle={review.title} executor={review.executor} onClose={() => setReview(null)} onResolved={() => void reload()} />}
    </>
  );
}
