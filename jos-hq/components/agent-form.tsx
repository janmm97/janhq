"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, apiSend } from "@/lib/client/api";
import { flip, hasNever, limitsToText, newLimitRow, textToLimits, type LimitRow, type Limits } from "@/lib/client/limits";
import { PageHeader } from "./shell";
import { BusyTasks } from "./agent-delete";
import { Button, ButtonLink, EmptyState, ErrorNote, Mark, Tabs, cx } from "./ui";

type Ws = "One" | "Studio";
interface Conn {
  platform: string;
  name: string;
  state: string;
}
interface Suggestion {
  name: { input: string; suggested: string; key: string; valid: boolean; free: boolean };
  connections: Conn[];
  picks: Array<{ platform: string; name: string; reason: "named" | "only"; why: string }>;
  ask: Array<{ platform: string; label: string; question: string; options: Conn[] }>;
  missing: string[];
  discoveryError: string | null;
  planner: Pin;
}
interface Draft {
  file: string;
  content: string;
  name: string;
  sopFile: string;
  sop: string;
  logsFile: string;
}
export interface AgentAnswersView {
  connections: Array<{ platform: string; name: string }>;
  purpose: string;
  mayDo: string;
  mustNever: string;
}
type Pin = { modelLabel: string; effort: string };

const keyOf = (c: { platform: string; name: string }) => `${c.platform}\u0000${c.name}`;
const label = "text-[11px] font-bold uppercase tracking-[0.14em] text-silver";
const sectionTitle = "text-[14px] font-bold text-paper";
const field = "mt-1.5 w-full rounded-[4px] border border-rim bg-ground px-3 text-[13.5px] text-paper placeholder:text-silver disabled:text-silver";

/** The value once it has stayed the same for `ms`. Strings only, so an unchanged value never re-arms it. */
function useSettled(value: string, ms = 400): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** An agent's SOP.md and LOGS.md: in the folder named after it, beside its definition, in the path's own separator. */
function agentFolderFiles(file: string, name: string): { sop: string; logs: string } {
  const sep = file.includes("\\") ? "\\" : "/";
  const folder = `${file.slice(0, Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/")))}${sep}${name}`;
  return { sop: `${folder}${sep}SOP.md`, logs: `${folder}${sep}LOGS.md` };
}

function splitSop(sop: string): { head: string; yours: string; jos: string } {
  const a = sop.indexOf("## Purpose");
  const b = sop.indexOf("## Guardrails (set by the J/OS Orchestrator)");
  if (a < 0 || b < a) return { head: "", yours: sop, jos: "" };
  return { head: sop.slice(0, a).trim(), yours: sop.slice(a, b).trim(), jos: sop.slice(b).trim() };
}

function ConnectionBox({ c, checked, onChange, note, stale = false }: { c: Conn; checked: boolean; onChange: (on: boolean) => void; note?: string; stale?: boolean }) {
  return (
    <li className="min-w-0">
      <label className={cx("flex cursor-pointer items-start gap-2.5 rounded-[4px] border px-3 py-2 transition-colors duration-200 ease-out-expo", checked ? "border-paper bg-tray" : "border-rim hover:border-rim-strong")}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--color-paper)]" />
        <span className="min-w-0">
          <span className="block truncate text-[13px] text-paper" title={c.name}>
            {c.name}
          </span>
          <span className="block text-[12px] text-silver">
            {c.platform}
            {c.state && c.state !== "operational" ? ` · ${c.state}` : ""}
            {stale ? " · not connected now" : ""}
          </span>
          {note && <span className="block text-[12px] text-silver-hi">{note}</span>}
        </span>
      </label>
    </li>
  );
}

function LimitRowView({ row, onFlip }: { row: LimitRow; onFlip: (verb: string) => void }) {
  return (
    <li className="border-b border-rim py-3 last:border-0">
      <p className="truncate text-[12.5px] text-paper" title={`${row.platform} · ${row.name}`}>
        {row.platform} · “{row.name}”
      </p>
      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={`Limits for ${row.name}`}>
        {row.verbs.map((v) => (
          <button
            key={v.verb}
            type="button"
            onClick={() => onFlip(v.verb)}
            aria-pressed={v.verdict === "may"}
            aria-label={`${v.verb}: ${v.verdict === "may" ? "may" : v.verdict === "never" ? "never" : "not set"}`}
            data-verdict={v.verdict ?? "unset"}
            data-testid="limit-toggle"
            className={cx(
              "inline-flex h-8 items-center gap-2 rounded-[4px] border px-2.5 text-[12.5px] transition-colors duration-200 ease-out-expo focus-visible:transition-none",
              v.verdict === "may" ? "border-paper bg-paper text-ground" : v.verdict === "never" ? "border-rim-strong text-silver-hi" : "border-dashed border-rim-strong text-silver",
            )}
          >
            <span>{v.verb}</span>
            <span className="text-[11px] font-bold uppercase tracking-[0.1em]">{v.verdict ?? "not set"}</span>
          </button>
        ))}
      </div>
    </li>
  );
}

function SopParts({ draft }: { draft: Draft }) {
  const parts = splitSop(draft.sop);
  return (
    <>
      <pre className="code-block text-silver-hi">{parts.yours}</pre>
      <details className="group mt-4 border-t border-rim pt-3">
        <summary className="flex cursor-pointer list-none items-start gap-2 text-[12.5px] text-silver-hi [&::-webkit-details-marker]:hidden">
          <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" className="mt-1 shrink-0 text-rim-strong transition-transform duration-200 ease-out-expo group-open:rotate-90">
            <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="min-w-0">Set by J/OS · guardrails, how you work, what you return, verification</span>
        </summary>
        <pre className="code-block mt-2 text-silver">{[parts.head, parts.jos].filter(Boolean).join("\n\n")}</pre>
      </details>
      <dl className="mt-4 space-y-1 border-t border-rim pt-3 text-[12px]">
        {[
          ["Definition", draft.file],
          ["SOP", draft.sopFile],
          ["Log", draft.logsFile],
        ].map(([k, v]) => (
          <div key={k} className="grid grid-cols-[80px_minmax(0,1fr)] gap-2">
            <dt className="text-silver">{k}</dt>
            <dd className="break-all text-silver-hi">{v}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function TestPrint({ ws, agentKey, purpose, pin }: { ws: Ws; agentKey: string; purpose: string; pin: Pin | undefined }) {
  const [request, setRequest] = useState(purpose);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const base = `/api/agents/${ws}/${encodeURIComponent(agentKey)}`;
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const { conversation } = await apiSend<{ conversation: { id: string } }>("POST", `${base}/conversations`, { title: "Test print" });
      await apiSend("POST", `${base}/conversations/${conversation.id}/messages`, { content: request.trim(), mode: "plan" });
      setSent(conversation.id);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="test-print-title" className="border-t border-rim pt-4" data-testid="test-print">
      <h3 id="test-print-title" className="text-[13px] font-semibold text-paper">
        Test print · Plan mode
      </h3>
      <p className="mt-1 max-w-[76ch] text-[12.5px] text-silver-hi">
        Costs one read-only planning session on {pin ? `${pin.modelLabel} (${pin.effort})` : `${ws}'s planner`}. Nothing executes; the plan comes back in the agent's chat with Execute this plan.
      </p>
      <label className="mt-3 block">
        <span className={label}>Request</span>
        <textarea value={request} onChange={(e) => setRequest(e.target.value)} rows={3} disabled={!!sent} className={cx(field, "py-2 leading-[1.55]")} />
      </label>
      {sent ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Mark tone="line">Sent</Mark>
          <span className="text-[12.5px] text-silver-hi">Planning in a new conversation.</span>
          <ButtonLink href={`/agents?ws=${ws}&agent=${encodeURIComponent(agentKey)}&conversation=${sent}`} data-testid="test-print-open">
            Open the conversation
          </ButtonLink>
        </div>
      ) : (
        <Button className="mt-3" variant="primary" size="sm" onClick={() => void send()} disabled={busy || !request.trim()} data-testid="test-print-send">
          {busy ? "Sending…" : "Test print · Plan mode"}
        </Button>
      )}
      <ErrorNote error={error} />
    </section>
  );
}

/**
 * New agent and Edit agent (spec Part 3): Purpose, Connections, Limits, Write, with the SOP beside them.
 * The two §6b questions are the operator's; HQ writes everything else, and never over an existing file.
 */
export function AgentStations({ workspace, edit }: { workspace: Ws; edit?: { key: string; answers: AgentAnswersView; hash: string } }) {
  const editKey = edit?.key ?? null;
  const [ws, setWs] = useState<Ws>(workspace);
  const [purpose, setPurpose] = useState(edit?.answers.purpose ?? "");
  const [name, setName] = useState("");
  const [limits, setLimits] = useState<Limits>(() => (edit ? textToLimits(edit.answers, edit.answers.connections) : { rows: [], mayFree: "", neverFree: "" }));
  const [suggest, setSuggest] = useState<Suggestion | null>(null);
  const [suggestError, setSuggestError] = useState<Error | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState<Error | null>(null);
  const [writeError, setWriteError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [written, setWritten] = useState<{ key: string; files: string[] } | null>(null);
  // Suggestions pre-tick only what the operator has not touched, and only for a new agent.
  const touched = useRef(new Set<string>());
  const autoPicked = useRef(new Set<string>());

  const text = limitsToText(limits);
  const answers: AgentAnswersView = { connections: limits.rows.map(({ platform, name: n }) => ({ platform, name: n })), purpose, mayDo: text.mayDo, mustNever: text.mustNever };
  const effectiveName = editKey ?? (name.trim() || suggest?.name.suggested || "");

  const suggestBody = useSettled(JSON.stringify({ workspace: ws, purpose, name: editKey ?? name }));
  useEffect(() => {
    // Right after a workspace switch the settled body still names the old workspace: ask nothing, and
    // drop any answer still in flight for it (the cleanup below).
    const req = JSON.parse(suggestBody) as { workspace: Ws };
    if (req.workspace !== ws) return;
    let live = true;
    apiSend<Suggestion>("POST", "/api/agents/suggest", req)
      .then((s) => {
        if (!live) return;
        setSuggest(s);
        setSuggestError(null);
      })
      .catch((e) => live && setSuggestError(e as Error));
    return () => {
      live = false;
    };
  }, [suggestBody, ws]);

  useEffect(() => {
    if (editKey || !suggest) return;
    const want = new Set(suggest.picks.map(keyOf));
    setLimits((l) => {
      let rows = l.rows.filter((r) => !(autoPicked.current.has(keyOf(r)) && !want.has(keyOf(r)) && !touched.current.has(keyOf(r))));
      for (const p of suggest.picks) if (!touched.current.has(keyOf(p)) && !rows.some((r) => keyOf(r) === keyOf(p))) rows = [...rows, newLimitRow(p)];
      return { ...l, rows };
    });
    autoPicked.current = want;
  }, [suggest, editKey]);

  const draftBody = useSettled(JSON.stringify(editKey ? answers : { ...answers, workspace: ws, name: effectiveName }));
  useEffect(() => {
    let live = true;
    const url = editKey ? `/api/agents/${ws}/${encodeURIComponent(editKey)}/draft` : "/api/agents/draft";
    apiSend<Draft>("POST", url, JSON.parse(draftBody))
      .then((d) => {
        if (!live) return;
        setDraft(d);
        setDraftError(null);
      })
      .catch((e) => live && setDraftError(e as Error));
    return () => {
      live = false;
    };
  }, [draftBody, editKey, ws]);

  const toggle = (c: { platform: string; name: string }, on: boolean) => {
    touched.current.add(keyOf(c));
    setLimits((l) => ({ ...l, rows: on ? [...l.rows.filter((r) => keyOf(r) !== keyOf(c)), newLimitRow(c)] : l.rows.filter((r) => keyOf(r) !== keyOf(c)) }));
  };
  const changeWs = (v: Ws) => {
    setWs(v);
    // The old workspace's suggestions go too, so none of its connections can be ticked into this one.
    setSuggest(null);
    touched.current.clear();
    autoPicked.current.clear();
    setLimits((l) => ({ ...l, rows: [] }));
  };

  const reasons = [
    !purpose.trim() && "Say what it is for.",
    limits.rows.length === 0 && "Choose at least one connection.",
    !text.mayDo && "Say at least one thing it may do: a toggle or the free text.",
    !hasNever(limits) && "Say at least one thing it must never do: a toggle or the free text.",
    !editKey && suggest && !suggest.name.free && `${suggest.name.key} is taken; choose another name.`,
  ].filter((r): r is string => !!r);

  const write = async () => {
    setBusy(true);
    setWriteError(null);
    try {
      if (editKey) {
        const r = await apiSend<{ name: string; file: string }>("PATCH", `/api/agents/${ws}/${encodeURIComponent(editKey)}`, { ...answers, baseHash: edit!.hash, confirm: true });
        setWritten({ key: r.name, files: [agentFolderFiles(r.file, r.name).sop, r.file] });
      } else {
        const r = await apiSend<{ name: string; file: string }>("POST", "/api/agents", { ...answers, workspace: ws, name: effectiveName, confirm: true });
        const f = agentFolderFiles(r.file, r.name);
        setWritten({ key: r.name, files: [r.file, f.sop, f.logs] });
      }
    } catch (e) {
      setWriteError(e as Error);
    } finally {
      setBusy(false);
    }
  };
  const busyTasks = writeError instanceof ApiError ? ((writeError.details as { tasks?: Array<{ id: string; title: string; status: string }> } | null)?.tasks ?? []) : [];

  const live = suggest?.connections ?? [];
  const chosen = new Set(limits.rows.map(keyOf));
  const pickKeys = new Set((suggest?.picks ?? []).map(keyOf));
  const askKeys = new Set((suggest?.ask ?? []).flatMap((a) => a.options.map(keyOf)));
  const rest = live.filter((c) => !pickKeys.has(keyOf(c)) && !askKeys.has(keyOf(c)));
  // A chosen connection is only "not connected now" once discovery has actually answered; while it hasn't
  // (or failed), the same connection is merely unconfirmed, not stale.
  const discovered = !!suggest && !suggest.discoveryError;
  const stale = discovered ? limits.rows.filter((r) => !live.some((c) => keyOf(c) === keyOf(r))) : [];
  const unconfirmed = discovered ? [] : limits.rows.filter((r) => !live.some((c) => keyOf(c) === keyOf(r)));
  const steps = [
    { id: "purpose", label: "Purpose", done: !!purpose.trim() },
    { id: "connections", label: "Connections", done: limits.rows.length > 0 },
    { id: "limits", label: "Limits", done: !!text.mayDo && hasNever(limits) },
    { id: "write", label: "Write", done: !!written },
  ];
  const current = steps.findIndex((s) => !s.done);
  const keyLine = editKey
    ? `→ ${editKey} · fixed; its conversations are tied to it`
    : suggest
      ? `→ ${suggest.name.key} · ${!suggest.name.valid ? "not a valid name" : suggest.name.free ? "free" : "taken"}`
      : "→ …";

  return (
    <div data-testid="agent-form">
      <PageHeader
        code="J2"
        title={editKey ? `Edit ${editKey}` : "New agent"}
        description={editKey ? "Re-answer the two questions. HQ rewrites SOP.md with its current guardrails." : "Two questions are yours: which connections, and how it uses them. HQ decides everything else and writes it into SOP.md."}
        actions={
          <ButtonLink variant="ghost" href={`/agents?ws=${ws}${editKey ? `&agent=${encodeURIComponent(editKey)}` : ""}`}>
            Back to agents
          </ButtonLink>
        }
      />
      {/* Two by two below sm, so "2 Connections" reads whole; the hairlines come from the gap. */}
      <ol aria-label="Stations" className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-[3px] border border-rim-strong bg-rim sm:grid-cols-4">
        {steps.map((s, i) => (
          <li
            key={s.id}
            aria-current={i === current ? "step" : undefined}
            className={cx("min-w-0", s.done ? "bg-strip-2 text-ground" : i === current ? "bg-tray text-paper shadow-[inset_0_0_0_2px_var(--color-safe)]" : "bg-strip-6 text-silver")}
          >
            <a href={`#${s.id}`} className="block truncate px-3 py-2 text-[11px] font-extrabold uppercase tracking-[0.08em]">
              {i + 1} {s.label}
            </a>
          </li>
        ))}
      </ol>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
        <div className="min-w-0 space-y-8">
          <fieldset disabled={!!written} className="min-w-0 space-y-8">
            <section id="purpose" aria-labelledby="purpose-title" className="space-y-4">
              <h2 id="purpose-title" className={sectionTitle}>
                <span className="text-silver">1</span> Purpose
              </h2>
              {!editKey && (
                <div>
                  <span className={label}>Workspace</span>
                  <div className="mt-1.5">
                    <Tabs<Ws> label="Workspace" size="md" value={ws} onChange={changeWs} tabs={[{ value: "One", label: "One" }, { value: "Studio", label: "Studio" }]} />
                  </div>
                </div>
              )}
              <label className="block">
                <span className={label}>What is it for?</span>
                <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={3} placeholder="e.g. Triage the support inbox and draft replies for review" className={cx(field, "py-2 leading-[1.55]")} />
              </label>
              <label className="block">
                <span className={label}>Name</span>
                <input value={editKey ?? name} onChange={(e) => setName(e.target.value)} disabled={!!editKey} placeholder={suggest?.name.suggested || "e.g. support triage"} className={cx(field, "h-9")} />
              </label>
              <p className="text-[12.5px] text-silver-hi" data-testid="agent-key">
                {keyLine}
              </p>
            </section>

            <section id="connections" aria-labelledby="connections-title" className="space-y-4">
              <h2 id="connections-title" className={sectionTitle}>
                <span className="text-silver">2</span> Connections
              </h2>
              <p className="max-w-[76ch] text-[12.5px] text-silver-hi">Which connections should this agent have? Choose the specific ones; HQ refuses every other connection at run time.</p>
              <ErrorNote error={suggestError} />
              {!suggest && !suggestError && <p className="text-[12.5px] text-silver">Listing {ws} connections…</p>}
              {suggest?.discoveryError && <EmptyState compact title={`Could not list ${ws} connections`} body={suggest.discoveryError} />}
              {discovered && live.length === 0 && (
                <EmptyState
                  compact
                  title={`No live ${ws} connections`}
                  body={
                    <>
                      Discovery found none in this workspace. Connect one with <code className="rounded-[3px] bg-tray px-1 py-px text-paper">one add &lt;platform&gt;</code> from JOS/{ws}, then reload this page.
                    </>
                  }
                />
              )}
              {suggest && (suggest.picks.length > 0 || suggest.ask.length > 0) && (
                <div role="group" aria-labelledby="from-purpose-title">
                  <h3 id="from-purpose-title" className={label}>
                    From your purpose
                  </h3>
                  {suggest.picks.length > 0 && (
                    <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {suggest.picks.map((p) => (
                        <ConnectionBox key={keyOf(p)} c={live.find((x) => keyOf(x) === keyOf(p)) ?? { ...p, state: "" }} checked={chosen.has(keyOf(p))} onChange={(on) => toggle(p, on)} note={p.why} />
                      ))}
                    </ul>
                  )}
                  {suggest.ask.map((a) => (
                    <div key={a.platform} className="mt-3" role="group" aria-label={a.question}>
                      <p className="text-[12.5px] text-paper">{a.question}</p>
                      <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {a.options.map((c) => (
                          <ConnectionBox key={keyOf(c)} c={c} checked={chosen.has(keyOf(c))} onChange={(on) => toggle(c, on)} />
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
              {rest.length > 0 && (
                <div>
                  <h3 className={label}>Also in {ws}</h3>
                  <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {rest.map((c) => (
                      <ConnectionBox key={keyOf(c)} c={c} checked={chosen.has(keyOf(c))} onChange={(on) => toggle(c, on)} />
                    ))}
                  </ul>
                </div>
              )}
              {stale.length > 0 && (
                <div>
                  <h3 className={label}>Chosen, not connected now</h3>
                  <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {stale.map((r) => (
                      <ConnectionBox key={keyOf(r)} c={{ platform: r.platform, name: r.name, state: "" }} checked onChange={(on) => toggle(r, on)} stale />
                    ))}
                  </ul>
                  <p className="mt-2 text-[12px] text-silver">It stays chosen; HQ blocks the agent's tasks at run time until it is connected again.</p>
                </div>
              )}
              {unconfirmed.length > 0 && (
                <div>
                  <h3 className={label}>Chosen</h3>
                  <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {unconfirmed.map((r) => (
                      <ConnectionBox
                        key={keyOf(r)}
                        c={{ platform: r.platform, name: r.name, state: "" }}
                        checked
                        onChange={(on) => toggle(r, on)}
                        note={suggest ? `could not check: ${suggest.discoveryError}` : "checking…"}
                      />
                    ))}
                  </ul>
                </div>
              )}
              {suggest && suggest.missing.length > 0 && (
                <p className="text-[12.5px] text-silver-hi">
                  The purpose implies {suggest.missing.join(", ")}, which {ws} has not connected.
                </p>
              )}
            </section>

            <section id="limits" aria-labelledby="limits-title" className="space-y-4">
              <h2 id="limits-title" className={sectionTitle}>
                <span className="text-silver">3</span> Limits
              </h2>
              <p className="max-w-[76ch] text-[12.5px] text-silver-hi">How should it use them? Each verb is may or never; select one to flip it.</p>
              {limits.rows.length === 0 ? (
                <p className="text-[12.5px] text-silver">Choose a connection to set its limits.</p>
              ) : (
                <ul className="rounded-[4px] border border-rim px-3">
                  {limits.rows.map((r) => (
                    <LimitRowView
                      key={keyOf(r)}
                      row={r}
                      onFlip={(verb) => {
                        touched.current.add(keyOf(r));
                        setLimits((l) => ({ ...l, rows: l.rows.map((x) => (keyOf(x) === keyOf(r) ? flip(x, verb) : x)) }));
                      }}
                    />
                  ))}
                </ul>
              )}
              <label className="block">
                <span className={label}>Anything else it may do</span>
                <textarea value={limits.mayFree} onChange={(e) => setLimits((l) => ({ ...l, mayFree: e.target.value }))} rows={2} className={cx(field, "py-2 leading-[1.55]")} />
              </label>
              <label className="block">
                <span className={label}>Anything else it must never do</span>
                <textarea value={limits.neverFree} onChange={(e) => setLimits((l) => ({ ...l, neverFree: e.target.value }))} rows={2} className={cx(field, "py-2 leading-[1.55]")} />
              </label>
              <p className="max-w-[76ch] text-[12px] text-silver">Limits are instructions in SOP.md that the agent follows. HQ enforces the connection list in code, and every write still goes through approval.</p>
            </section>
          </fieldset>

          <section id="write" aria-labelledby="write-title" className="space-y-3">
            <h2 id="write-title" className={sectionTitle}>
              <span className="text-silver">4</span> Write
            </h2>
            {written ? (
              <div data-testid="write-result" className="space-y-4">
                <div>
                  <Mark tone="fixed">{editKey ? "Saved" : "Written"}</Mark>
                  <ul className="mt-2 space-y-0.5 text-[12.5px] text-silver-hi">
                    {written.files.map((f) => (
                      <li key={f} className="break-all">
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
                <ButtonLink href={`/agents?ws=${ws}&agent=${encodeURIComponent(written.key)}`}>Open agent</ButtonLink>
                <TestPrint ws={ws} agentKey={written.key} purpose={purpose} pin={suggest?.planner} />
              </div>
            ) : (
              <>
                {reasons.length > 0 && (
                  <ul className="space-y-1 text-[12.5px] text-silver-hi" data-testid="write-reason">
                    {reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                )}
                <Button variant="primary" onClick={() => void write()} disabled={busy || reasons.length > 0} data-testid="write-agent">
                  {editKey ? (busy ? "Saving…" : "Save changes") : busy ? "Writing…" : "Write agent"}
                </Button>
                <p className="max-w-[76ch] text-[12px] text-silver">{editKey ? "HQ rewrites SOP.md with its current guardrails and keeps the previous version in jos-hq/data/agent-history/. LOGS.md is never touched." : "HQ writes the definition, SOP.md and an empty LOGS.md, and never over an existing file."}</p>
                <ErrorNote error={writeError} />
                <BusyTasks tasks={busyTasks} />
              </>
            )}
          </section>
        </div>

        <aside data-testid="sop-preview" aria-label="SOP.md preview" className="h-fit min-w-0 rounded-[6px] border border-rim bg-room lg:sticky lg:top-20">
          <header className="flex items-baseline justify-between gap-3 border-b border-rim px-4 py-3">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.16em] text-silver-hi">SOP.md</h2>
            <span className="min-w-0 text-balance text-right text-[12px] text-silver">exactly as HQ will write it · yours first</span>
          </header>
          {/* Its own scroll only where the column is sticky; stacked below lg, the page scrolls it. */}
          <div className="p-4 lg:max-h-[70vh] lg:overflow-y-auto">
            <ErrorNote error={draftError} />
            {draft ? <SopParts draft={draft} /> : <p className="text-[12.5px] text-silver">Drafting…</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}
