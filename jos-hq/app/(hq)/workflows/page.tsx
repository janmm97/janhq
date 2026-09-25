"use client";

import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiSend, useApi } from "@/lib/client/api";
import { markText, stamp, statusTone } from "@/lib/client/format";
import { PageHeader } from "@/components/shell";
import { Button, EmptyState, ErrorNote, Mark, Menu, Modal, Tabs, Tag } from "@/components/ui";

interface FlowView {
  id: string;
  key: string;
  name: string;
  owner: "One" | "Studio";
  description: string | null;
  status: string;
  lastRun: string | null;
  requiresBash: boolean;
  inputs: Record<string, { type?: string; required?: boolean; description?: string; connection?: unknown; autoResolvable?: boolean; default?: unknown }> | null;
}

type Mode = "auto" | "manual" | "edit" | "plan";
const MODE_OPTIONS = [
  { value: "auto" as Mode, label: "Auto", description: "Validate and dry-run automatically; the run itself still waits for your approval." },
  { value: "manual" as Mode, label: "Manual", description: "Strictest: every step beyond reading waits for you." },
  { value: "edit" as Mode, label: "Edit automatically", description: "Local edits proceed; outward effects wait for approval." },
  { value: "plan" as Mode, label: "Plan", description: "Plan the run and stop before executing anything." },
];
const label = "text-[11px] font-bold uppercase tracking-[0.14em] text-silver";

function RunDialog({ flow, onClose }: { flow: FlowView; onClose: () => void }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("auto");
  const needed = Object.entries(flow.inputs ?? {}).filter(([, v]) => v && v.required !== false && !v.connection && v.default === undefined && !v.autoResolvable);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiSend<{ chatId: string }>("POST", `/api/workflows/${encodeURIComponent(flow.id)}/run`, { mode, inputs: values });
      router.push(`/chat/${r.chatId}`);
    } catch (e) {
      setError(e as Error);
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Run ${flow.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={run} disabled={busy || needed.some(([k]) => !values[k]?.trim())}>
            {busy ? "Starting…" : "Start run"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-[13px]">
        <p className="max-w-[76ch] text-silver-hi">
          The {flow.owner} executor runs this flow from JOS/{flow.owner}/. HQ checks its identity, validates the flow, dry-runs it, and shows you the exact run for approval before anything executes.
        </p>
        {flow.requiresBash && <p className="rounded-[4px] border border-rim-strong p-2 text-paper">This flow contains bash steps; the executor must justify --allow-bash in its proposal.</p>}
        <div>
          <div className={`mb-1.5 ${label}`}>Mode</div>
          <Menu<Mode> label="Mode" value={mode} onChange={setMode} options={MODE_OPTIONS} />
        </div>
        {needed.length > 0 && (
          <fieldset className="space-y-2">
            <legend className={`mb-1 ${label}`}>Inputs the flow cannot resolve itself</legend>
            {needed.map(([k, v]) => (
              <label key={k} className="block">
                <span className="text-[12.5px] text-silver-hi">
                  {k}
                  {v.description ? <span className="text-silver"> · {v.description}</span> : null}
                </span>
                <input value={values[k] ?? ""} onChange={(e) => setValues((s) => ({ ...s, [k]: e.target.value }))} className="mt-1 h-9 w-full rounded-[4px] border border-rim bg-ground px-3 text-paper" />
              </label>
            ))}
          </fieldset>
        )}
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}

function WorkflowsInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [owner, setOwner] = useState<"all" | "One" | "Studio">("all");
  const [run, setRun] = useState<FlowView | null>(null);
  const [fresh, setFresh] = useState(0);
  const { data, error, loading } = useApi<{ flows: FlowView[]; errors: string[] }>(`/api/workflows${fresh ? `?fresh=1&n=${fresh}` : ""}`);
  const flows = useMemo(
    () => (data?.flows ?? []).filter((f) => (owner === "all" || f.owner === owner) && (!q.trim() || `${f.name} ${f.key} ${f.description ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()))),
    [data, owner, q],
  );
  const newWorkflow = async () => {
    const r = await apiSend<{ chat: { id: string } }>("POST", "/api/chats", { title: "New workflow", purpose: "workflow" });
    const route = owner === "all" ? "auto" : owner;
    router.push(`/chat/${r.chat.id}?route=${route}&draft=${encodeURIComponent("Build a One Flow that ")}`);
  };
  return (
    <>
      <PageHeader
        code="J4"
        title="Workflows"
        description="One Flows discovered live in each executor workspace."
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => setFresh((n) => n + 1)}>
              {loading ? "Discovering…" : "Refresh"}
            </Button>
            <Button size="sm" onClick={newWorkflow}>
              New workflow
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="block w-full min-w-0 sm:max-w-sm">
          <span className="sr-only">Search workflows</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} type="search" placeholder="Search workflows..." className="h-9 w-full rounded-[4px] border border-rim bg-room px-3 text-[13px] text-paper placeholder:text-silver" />
        </label>
        <Tabs label="Owner" value={owner} onChange={setOwner} size="md" tabs={[{ value: "all", label: "All" }, { value: "One", label: "One" }, { value: "Studio", label: "Studio" }]} />
      </div>
      <ErrorNote error={error} />
      {data?.errors.map((e) => (
        <p key={e} role="alert" className="mb-2 break-words text-[12.5px] text-fog">
          {e}
        </p>
      ))}
      {!data ? (
        <p className="text-[13px] text-silver">{error ? "Not loaded; the error is above." : "Discovering One Flows in JOS/One and JOS/Studio…"}</p>
      ) : flows.length === 0 ? (
        data.flows.length === 0 ? (
          <EmptyState title="No workflows yet." body="one --agent flow list returns no flows in JOS/One or JOS/Studio. New workflow asks an executor to build one as a One Flow." action={<Button size="sm" onClick={newWorkflow}>New workflow</Button>} />
        ) : (
          <EmptyState title="No workflow matches this filter." />
        )
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-label="Workflows">
          {flows.map((f) => (
            <li key={f.id} className="flex min-w-0 flex-col rounded-[6px] border border-rim bg-room p-4 shadow-[0_16px_30px_-22px_rgba(0,0,0,0.95)]">
              <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 truncate text-[14px] font-semibold text-paper" title={f.name}>
                  {f.name}
                </h3>
                <Tag>{f.owner}</Tag>
              </div>
              <p className="mt-1 truncate text-[12px] text-silver" title={f.key}>
                {f.key}
              </p>
              {f.description && (
                <p className="mt-2 line-clamp-3 text-[12.5px] text-silver-hi" title={f.description}>
                  {f.description}
                </p>
              )}
              <div className="mt-auto flex items-end justify-between gap-2 pt-4">
                <div className="min-w-0 space-y-1 text-[12px] text-silver">
                  <Mark tone={statusTone(f.status)}>{f.status === "Never run" ? "Never run" : markText(f.status)}</Mark>
                  <div>{f.lastRun ? `last run ${stamp(f.lastRun)}` : "no run yet"}</div>
                </div>
                <Button variant="primary" size="sm" onClick={() => setRun(f)}>
                  Run
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {run && <RunDialog flow={run} onClose={() => setRun(null)} />}
    </>
  );
}

export default function WorkflowsPage() {
  return (
    <Suspense fallback={null}>
      <WorkflowsInner />
    </Suspense>
  );
}
