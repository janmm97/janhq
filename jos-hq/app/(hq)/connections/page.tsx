"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useApi } from "@/lib/client/api";
import { stamp, statusTone, timeAgo } from "@/lib/client/format";
import { PageHeader } from "@/components/shell";
import { Button, EmptyState, ErrorNote, Status, useNow } from "@/components/ui";

interface Row {
  tool: string;
  platform: string;
  agents: string[];
  agentLabel: string;
  status: "Operational" | "Down";
  lastUsed: string | null;
  connections: Array<{ scope: string; name: string; state: string }>;
}

function ConnectionsInner() {
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [fresh, setFresh] = useState(0);
  const now = useNow(30000);
  const { data, error, loading } = useApi<{ rows: Row[]; errors: string[]; discoveredAt: string }>(`/api/connections${fresh ? `?fresh=1&n=${fresh}` : ""}`);
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => !q.trim() || `${r.tool} ${r.agentLabel} ${r.connections.map((c) => c.name).join(" ")}`.toLowerCase().includes(q.trim().toLowerCase())), [data, q]);

  return (
    <>
      <PageHeader
        code="J3"
        title="Connections"
        description="What One, Studio and the Orchestrator can reach right now, from live discovery."
        actions={
          <Button size="sm" onClick={() => setFresh((n) => n + 1)}>
            {loading ? "Discovering…" : "Refresh"}
          </Button>
        }
      />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <label className="relative block w-full min-w-0 sm:max-w-sm">
          <span className="sr-only">Search connections</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} type="search" placeholder="Search connections..." className="h-9 w-full rounded-[4px] border border-rim bg-room px-3 text-[13px] text-paper placeholder:text-silver" />
        </label>
        {data && <p className="text-[12.5px] text-silver">Discovered {stamp(data.discoveredAt)}</p>}
      </div>
      <ErrorNote error={error} />
      {data?.errors.map((e) => (
        <p key={e} role="alert" className="mb-2 break-words text-[12.5px] text-fog">
          {e}
        </p>
      ))}
      {data && data.rows.length === 0 ? (
        <EmptyState
          title="No connections detected."
          body={
            <>
              Live discovery returned no connections for One, Studio or the Orchestrator. Connect one with <code className="rounded-[3px] bg-tray px-1 py-px text-paper">one add &lt;platform&gt;</code> from the workspace folder, then Refresh.
            </>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-[6px] border border-rim bg-room">
          {/* One line per row: below the table's width the box scrolls instead of the cells wrapping. */}
          <table className="w-full min-w-[640px] whitespace-nowrap text-left text-[13px]" data-testid="connections-table">
            <thead className="text-[11px] uppercase tracking-[0.14em] text-silver">
              <tr className="border-b border-rim">
                <th scope="col" className="px-4 py-2.5 font-bold" aria-sort="ascending">
                  Tool Name
                </th>
                <th scope="col" className="px-4 py-2.5 font-bold">
                  Agent
                </th>
                <th scope="col" className="px-4 py-2.5 font-bold">
                  Status
                </th>
                <th scope="col" className="px-4 py-2.5 font-bold">
                  Last Used
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.platform} className="border-b border-rim last:border-0 hover:bg-tray">
                  <td className="px-4 py-2.5">
                    <span className="text-paper">{r.tool}</span>
                    {r.connections.length > 1 && (
                      <span className="ml-2 text-[12px] text-silver" title={r.connections.map((c) => `${c.scope}: ${c.name} (${c.state})`).join("\n")}>
                        {r.connections.length} connections
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-silver-hi">{r.agentLabel}</td>
                  <td className="px-4 py-2.5">
                    <Status tone={statusTone(r.status)}>{r.status}</Status>
                  </td>
                  <td className="px-4 py-2.5 text-silver" title={r.lastUsed ? new Date(r.lastUsed).toLocaleString() : "HQ has not observed a call on this connection"}>
                    {r.lastUsed ? timeAgo(r.lastUsed, now) : "Never observed"}
                  </td>
                </tr>
              ))}
              {!data && (
                <tr>
                  <td colSpan={4} className="px-4 py-4 text-[13px] text-silver">
                    {error ? "Not loaded; the error is above." : "Discovering connections in One, Studio and the Orchestrator…"}
                  </td>
                </tr>
              )}
              {rows.length === 0 && data && data.rows.length > 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-4 text-[13px] text-silver">
                    Nothing matches “{q}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function ConnectionsPage() {
  return (
    <Suspense fallback={null}>
      <ConnectionsInner />
    </Suspense>
  );
}
