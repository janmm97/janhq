"use client";

import { useState } from "react";
import { apiSend, useApi } from "@/lib/client/api";
import { stamp } from "@/lib/client/format";
import { PageHeader } from "@/components/shell";
import { Button, EmptyState, ErrorNote, Panel, Status } from "@/components/ui";

interface GateRow { key: string; mode: string; live: boolean; held: string | null; version: number; threshold: number | null; target: number; labelled: number; accuracyAtThreshold: number | null; misses: Array<{ task_id: string | null; title: string | null; subject: string | null; predicted: string; score: number; created_at: string }> }
interface View { configured: boolean; pin: string | null; rootConnection: string; breaker: { open: boolean }; stats: { calls: number; failures: number; lastError: string | null }; undescribed: string[]; gates: GateRow[]; questions: Record<string, { version: number; instructions: string; criteria: unknown }>; backfill: { state: string; tasks: number; labelled: number } }

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

export default function TuningPage() {
  const [n, setN] = useState(0);
  const { data, error } = useApi<View>(`/api/judge?n=${n}`);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  /** Runs a write, tracking busy/error state. Resolves true only on success, so a caller that must not
   * proceed on failure (closing the reword editor, say) can check the result instead of assuming it. */
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setN((x) => x + 1);
      return true;
    } catch (e) {
      setErr(e as Error);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader
        code="J5"
        title="Tuning"
        description="How TypeSafe Jev's judgments have done against what really happened, and the thresholds HQ learned from them."
        actions={
          <>
            <Button size="sm" disabled={busy} onClick={() => act(() => apiSend("POST", "/api/judge/probe"))}>Probe</Button>
            <Button size="sm" disabled={busy || data?.backfill.state === "running"} onClick={() => act(() => apiSend("POST", "/api/judge/backfill"))}>{data?.backfill.state === "running" ? "Backfilling…" : "Backfill history"}</Button>
          </>
        }
      />
      <ErrorNote error={error ?? err} />
      {data && !data.configured && <EmptyState title="The judge layer is off." body="Add a judge section to jos-hq.config.json to turn it on." />}
      {data?.configured && (
        <div className="space-y-4">
          <p className="text-[12.5px] text-silver">
            Pinned {data.pin} · root connection {data.rootConnection} · {data.stats.calls} call(s), {data.stats.failures} fallback(s) in 24 h{data.breaker.open ? " · paused after failures" : ""}{data.undescribed.length ? ` · undescribed: ${data.undescribed.join(", ")}` : ""} · backfill {data.backfill.state} ({data.backfill.tasks} tasks, {data.backfill.labelled} labels)
          </p>
          {data.gates.map((g) => (
            <Panel key={g.key} title={g.key} description={`mode ${g.mode} · version ${g.version} · target ${pct(g.target)}${g.held ? ` · ${g.held}` : ""}`} actions={<Status tone={g.live ? "fixed" : "plan"}>{g.live ? `live at ${g.threshold?.toFixed(2)}` : "not acting"}</Status>}>
              <p className="text-[12.5px] text-silver-hi">
                {g.labelled} labelled · accuracy at threshold {pct(g.accuracyAtThreshold)}
              </p>
              {g.misses.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-[12px] text-silver">
                  {g.misses.map((m, i) => (
                    <li key={i}>
                      {stamp(m.created_at)} · {m.title ?? m.task_id} · {m.subject ?? "—"} → predicted {m.predicted} ({m.score.toFixed(2)}), wrong
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          ))}
          <Panel title="Question wording" description="Saving a change starts that question's thresholds over in shadow.">
            <ul className="space-y-3">
              {Object.entries(data.questions).map(([k, q]) => (
                <li key={k}>
                  <p className="text-[12.5px] text-paper">{k} · v{q.version}</p>
                  {editing === k ? (
                    <div className="mt-1 space-y-1">
                      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="w-full rounded-[4px] border border-rim bg-room px-2 py-1 text-[12.5px] text-paper" />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            act(() => apiSend("POST", "/api/judge/questions", { key: k, instructions: text })).then((ok) => {
                              if (ok) setEditing(null);
                            })
                          }
                        >
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[12px] text-silver">
                      {q.instructions}{" "}
                      <button className="underline" onClick={() => { setEditing(k); setText(q.instructions); }}>Reword</button>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      )}
    </>
  );
}
