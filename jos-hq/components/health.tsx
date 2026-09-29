"use client";

import { useEffect, useRef, useState } from "react";
import { apiSend, useApi } from "@/lib/client/api";
import { stamp, statusTone } from "@/lib/client/format";
import { Button, ErrorNote, Mark, Status, cx } from "./ui";

export interface HealthCheckView {
  id: string;
  group: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  blocking: boolean;
}
export interface ExecutorStatusView {
  workspace: "One" | "Studio";
  runtimeLabel: string;
  modelLabel: string;
  model: string;
  effort: string;
  runtime: { ok: boolean; binary: string | null; version: string | null; source: string | null; error?: string; candidates: Array<{ binary: string; version: string | null; source: string; eligible: boolean; reason: string }> };
  identity: { ok: boolean; actual: { email: string | null; projectRoot: string | null; org: string | null }; problems: string[] };
  modelVerification: { state: string; at: string | null; source: string | null; detail: string };
  /** The planning session's pin: same harness and binary, its own model and verification. */
  planner: { modelLabel: string; model: string; effort: string; modelVerification: { state: string; at: string | null; source: string | null; detail: string } };
  dispatchable: boolean;
  blockers: string[];
}
type VerifyResult = { workspace: string; role: string; ok: boolean; detail: string };
export interface HealthReportView {
  status: "Healthy" | "Attention" | "Blocked";
  generatedAt: string;
  checks: HealthCheckView[];
  executors: Record<"One" | "Studio", ExecutorStatusView>;
}

const CHECK_TEXT = { pass: "OK", warn: "Attention", fail: "Failed" } as const;
const label = "text-[11px] font-bold uppercase tracking-[0.14em] text-silver";
const verifiedTone = (state: string) => statusTone(state === "verified" ? "verified" : state === "failed" ? "fail" : "warn");

export function ExecutorRuntimeCard({ e }: { e: ExecutorStatusView }) {
  const [showCandidates, setShowCandidates] = useState(false);
  return (
    <div className={cx("rounded-[6px] border bg-ground p-3.5", e.dispatchable ? "border-rim" : "border-fog/60")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-[14px] font-bold text-paper">{e.workspace}</span>
          <span className="truncate text-[13px] text-silver-hi">
            {e.modelLabel} <span className="text-silver">({e.effort})</span>
          </span>
        </div>
        <Mark tone={e.dispatchable ? "fixed" : "fog"}>{e.dispatchable ? "Dispatchable" : "Dispatch blocked"}</Mark>
      </div>
      <dl className="mt-3 grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
        <dt className={label}>Runtime</dt>
        <dd className="min-w-0 break-words">
          {e.runtime.ok ? (
            <span className="text-silver-hi">
              {e.runtimeLabel} {e.runtime.version} <span className="text-silver">· {e.runtime.source}</span>
            </span>
          ) : (
            <span className="text-fog">{e.runtime.error}</span>
          )}
        </dd>
        <dt className={label}>Executor</dt>
        <dd className="min-w-0">
          <span className="text-silver-hi">
            {e.model} · effort {e.effort}
          </span>{" "}
          <Status tone={verifiedTone(e.modelVerification.state)}>{e.modelVerification.state}</Status>
          <span className="ml-2 text-silver">{e.modelVerification.at ? stamp(e.modelVerification.at) : ""}</span>
          <p className="mt-0.5 text-silver">{e.modelVerification.detail}</p>
        </dd>
        <dt className={label}>Planner</dt>
        <dd className="min-w-0">
          <span className="text-silver-hi">
            {e.planner.model} · effort {e.planner.effort}
          </span>{" "}
          <Status tone={verifiedTone(e.planner.modelVerification.state)}>{e.planner.modelVerification.state}</Status>
          <p className="mt-0.5 text-silver">{e.planner.modelVerification.detail}</p>
        </dd>
        <dt className={label}>Identity</dt>
        <dd className={cx("min-w-0 break-words", e.identity.ok ? "text-silver-hi" : "text-fog")}>{e.identity.ok ? `${e.identity.actual.email}${e.identity.actual.org ? ` · ${e.identity.actual.org}` : " · no org"}` : e.identity.problems.join("; ")}</dd>
        <dt className={label}>Workspace</dt>
        <dd className="truncate text-silver-hi" title={e.identity.actual.projectRoot ?? ""}>
          {e.identity.actual.projectRoot ?? "—"}
        </dd>
      </dl>
      {e.blockers.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-rim pt-2 text-[12.5px] text-fog">
          {e.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      {e.runtime.candidates?.length > 1 && (
        <div className="mt-2">
          <button type="button" onClick={() => setShowCandidates((s) => !s)} className="text-[12px] text-silver-hi underline-offset-4 hover:text-paper hover:underline" aria-expanded={showCandidates}>
            {showCandidates ? "Hide" : "Show"} every installed build HQ considered ({e.runtime.candidates.length})
          </button>
          {showCandidates && (
            <ul className="mt-1.5 space-y-1 text-[12px]">
              {e.runtime.candidates.map((c) => (
                <li key={c.binary} className="rounded-[4px] bg-tray px-2 py-1">
                  <span className={c.binary === e.runtime.binary ? "text-paper" : c.eligible ? "text-silver-hi" : "text-silver"}>
                    {c.binary === e.runtime.binary ? "selected · " : ""}
                    {c.source} {c.version ?? "?"}
                  </span>
                  <span className="block text-silver">{c.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function HealthDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, error, reload, setData } = useApi<HealthReportView>(open ? "/api/runtime/health" : null, ["health_updated"]);
  const [busy, setBusy] = useState<null | "refresh" | "verify">(null);
  const [confirmVerify, setConfirmVerify] = useState(false);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyResult[] | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const refresh = async () => {
    setBusy("refresh");
    setActionError(null);
    try {
      setData(await apiSend<HealthReportView>("POST", "/api/runtime/health/refresh"));
    } catch (e) {
      setActionError(e as Error);
    } finally {
      setBusy(null);
    }
  };
  const verify = async () => {
    setConfirmVerify(false);
    setBusy("verify");
    setActionError(null);
    try {
      const r = await apiSend<{ results: VerifyResult[] }>("POST", "/api/runtime/verify-models");
      setVerifyResult(r.results);
      await reload();
    } catch (e) {
      setActionError(e as Error);
    } finally {
      setBusy(null);
    }
  };
  const groups = ["Repository", "Orchestrator", "One", "Studio", "Systems"];
  return (
    <div className="fixed inset-0 z-[90] bg-black/70" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label="Runtime health" tabIndex={-1} data-testid="health-drawer" className="ml-auto flex h-full w-full max-w-[560px] flex-col border-l border-rim-strong bg-room outline-none">
        <header className="flex items-center justify-between gap-3 border-b border-rim px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold text-paper">Runtime health</h2>
            <p className="text-[12.5px] text-silver">{data ? `Checked ${stamp(data.generatedAt)} · live One CLI, executor runtimes and HQ stores` : "Checking…"}</p>
          </div>
          <div className="flex items-center gap-2">
            {data && <Mark tone={statusTone(data.status)}>{data.status}</Mark>}
            <button type="button" onClick={onClose} aria-label="Close runtime health" className="rounded-[4px] p-1 text-silver hover:bg-tray hover:text-paper">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          </div>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={refresh} disabled={!!busy}>
              {busy === "refresh" ? "Checking…" : "Run checks again"}
            </Button>
            <Button size="sm" onClick={() => setConfirmVerify(true)} disabled={!!busy}>
              {busy === "verify" ? "Launching planners and executors…" : "Verify models"}
            </Button>
          </div>
          {confirmVerify && (
            <div className="rounded-[4px] border border-rim-strong p-3 text-[12.5px]">
              <p className="text-silver-hi">
                This launches each workspace's planner and executor once, read-only (identity check only), to prove{" "}
                {data ? `One plans on ${data.executors.One.planner.modelLabel} (${data.executors.One.planner.effort}) and executes on ${data.executors.One.modelLabel} (${data.executors.One.effort}), and Studio plans on ${data.executors["Studio"].planner.modelLabel} (${data.executors["Studio"].planner.effort}) and executes on ${data.executors["Studio"].modelLabel} (${data.executors["Studio"].effort})` : "all four pins"}
                . It uses model quota on both runtimes and is logged in JOSMEMORY.md.
              </p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="primary" onClick={verify}>
                  Launch verification
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmVerify(false)}>
                  Not now
                </Button>
              </div>
            </div>
          )}
          {verifyResult && (
            <ul className="space-y-1 text-[12.5px]">
              {verifyResult.map((r) => (
                <li key={`${r.workspace}-${r.role}`}>
                  <Status tone={r.ok ? "fixed" : "fog"}>
                    {r.workspace} {r.role}: {r.ok ? "verified" : "failed"}
                  </Status>
                  <span className="ml-2 text-silver">{r.detail}</span>
                </li>
              ))}
            </ul>
          )}
          <ErrorNote error={actionError ?? error} />
          {data && (
            <>
              <div className="grid gap-3">
                <ExecutorRuntimeCard e={data.executors.One} />
                <ExecutorRuntimeCard e={data.executors["Studio"]} />
              </div>
              {groups.map((g) => {
                const items = data.checks.filter((c) => c.group === g);
                if (!items.length) return null;
                return (
                  <section key={g}>
                    <h3 className={`mb-1.5 ${label}`}>{g}</h3>
                    <ul className="divide-y divide-rim rounded-[4px] border border-rim">
                      {items.map((c) => (
                        <li key={c.id} className="grid grid-cols-[100px_minmax(0,1fr)] gap-3 px-3 py-2">
                          <Status tone={statusTone(c.status)}>{CHECK_TEXT[c.status]}</Status>
                          <div className="min-w-0">
                            <div className="text-[13px] text-paper">
                              {c.label}
                              {c.blocking && c.status === "fail" && <span className="ml-2 text-[12px] text-fog">blocks dispatch</span>}
                            </div>
                            <div className="break-words text-[12px] text-silver">{c.detail}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
