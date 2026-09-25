"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiSend, useApi } from "@/lib/client/api";
import { statusTone, timeAgo, when } from "@/lib/client/format";
import { PageHeader } from "@/components/shell";
import { AgentChatWindow, type ChatWindowState } from "@/components/agent-chat";
import { DeleteAgentDialog } from "@/components/agent-delete";
import { Button, ButtonLink, EmptyState, ErrorNote, Mark, Menu, Panel, Readout, Status, Tabs, cx } from "@/components/ui";

interface AgentView {
  key: string;
  name: string;
  workspace: "One" | "Studio";
  harness: "claude" | "codex";
  file: string;
  description: string;
  model: string | null;
  connections: string[];
  status: "Working" | "Ready" | "Waiting" | "Blocked";
  lastActive: string | null;
  registeredAt: string | null;
  activeConversations: number;
  /** "sop": minimal definition + SOP.md/LOGS.md folder; "legacy": instructions inside the definition. */
  format: "sop" | "legacy";
  sopFile: string | null;
  logsFile: string | null;
  sopError: string | null;
  /** In the Orchestrator-level folders, so HQ may write it (fixture folders are read-only). */
  writable: boolean;
}
type Pin = { modelLabel: string; effort: string };
type RuntimeInfo = Record<string, { executor?: Pin; planner?: Pin }>;
const pinText = (p: Pin | undefined, fallback: string) => (p ? `${p.modelLabel} (${p.effort})` : fallback);
interface Conversation {
  id: string;
  title: string;
  status: string;
  updated_at: string;
  last_message: string | null;
}
type EditState = { hash: string } & ({ editable: true } | { editable: false; reason: string });
interface AgentDetail {
  edit: EditState;
  deletable: boolean;
}

const CONV_TONE: Record<string, string> = { Active: "Working", Complete: "completed", Waiting: "Waiting", Paused: "Paused", Failed: "failed" };
const label = "text-[11px] font-bold uppercase tracking-[0.14em] text-silver";

function AgentPrint({ a, selected, onSelect, onChat, onSettings }: { a: AgentView; selected: boolean; onSelect: () => void; onChat: () => void; onSettings: () => void }) {
  return (
    <li data-testid={`agent-row-${a.key}`} className={cx("flex flex-wrap items-stretch gap-x-2 border-b border-rim last:border-0", selected && "bg-tray")}>
      <button type="button" onClick={onSelect} aria-pressed={selected} className="min-w-0 flex-1 px-4 py-3 text-left transition-colors duration-200 ease-out-expo hover:bg-tray">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-paper" title={a.name}>
            {a.name}
          </span>
          <Mark tone={statusTone(a.status)}>{a.status}</Mark>
        </span>
        <span className="mt-1 block truncate text-[12.5px] text-silver-hi" title={a.description}>
          {a.description || "No purpose in the definition."}
        </span>
        <span className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-0.5 text-[12px] text-silver sm:grid-cols-3">
          <span className="truncate" title={a.connections.join(", ")}>
            {a.connections.length ? a.connections.join(", ") : "no connections listed"}
          </span>
          <span>registered {a.registeredAt ? when(a.registeredAt) : "—"}</span>
          <span>last active {a.lastActive ? timeAgo(a.lastActive) : "never"}</span>
        </span>
      </button>
      <span className="flex items-center gap-2 px-4 py-3">
        <Button size="sm" onClick={onChat} aria-label={`Chat with ${a.name}`}>
          Chat
        </Button>
        <Button size="sm" variant="ghost" onClick={onSettings} aria-label={`Settings for ${a.name}`}>
          Settings
        </Button>
      </span>
    </li>
  );
}

function AgentsInner() {
  const params = useSearchParams();
  const router = useRouter();
  const ws = (params.get("ws") === "Studio" ? "Studio" : "One") as "One" | "Studio";
  const { data, error, reload } = useApi<{ agents: AgentView[] }>(`/api/agents?workspace=${ws}`, ["agents_updated", "task_updated"]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | AgentView["status"]>("all");
  const [selected, setSelected] = useState<string | null>(params.get("agent"));
  const [tab, setTab] = useState<"conversations" | "chat" | "settings">("conversations");
  const [chat, setChat] = useState<{ state: ChatWindowState; conversationId: string | null } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [migrateError, setMigrateError] = useState<Error | null>(null);
  const [migrating, setMigrating] = useState(false);
  const { data: rt } = useApi<RuntimeInfo>("/api/runtime");
  const agents = data?.agents ?? [];
  // Old-format agents HQ may rewrite (fixture folders are read-only and never offered).
  const legacy = agents.filter((a) => a.format === "legacy" && a.writable);
  const migrate = async () => {
    setMigrating(true);
    setMigrateError(null);
    try {
      const r = await apiSend<{ results: Array<{ name: string; status: string; detail: string }> }>("POST", "/api/agents/migrate", {});
      const failed = r.results.filter((x) => x.status === "failed");
      if (failed.length) setMigrateError(new Error(failed.map((x) => `${x.name}: ${x.detail}`).join("; ")));
      void reload();
    } catch (e) {
      setMigrateError(e as Error);
    } finally {
      setMigrating(false);
    }
  };
  const rows = useMemo(() => agents.filter((a) => (status === "all" || a.status === status) && (!q.trim() || `${a.name} ${a.description}`.toLowerCase().includes(q.trim().toLowerCase()))), [agents, q, status]);
  const agent = agents.find((a) => a.key === selected) ?? null;
  const agentUrl = agent ? `/api/agents/${ws}/${encodeURIComponent(agent.key)}` : null;
  const { data: convs } = useApi<{ conversations: Conversation[] }>(agentUrl ? `${agentUrl}/conversations` : null, ["agents_updated", "task_updated"]);
  const { data: detail } = useApi<AgentDetail>(agentUrl && tab === "settings" ? agentUrl : null, ["agents_updated"]);

  // Reset only when the scope, the linked agent or the linked conversation actually changes;
  // useSearchParams() may return a new object on any render, and keying on it wiped the open chat.
  const agentParam = params.get("agent");
  const convParam = params.get("conversation");
  useEffect(() => {
    setSelected(agentParam);
    setChat(agentParam && convParam ? { state: "docked", conversationId: convParam } : null);
    if (agentParam && convParam) setTab("chat");
  }, [ws, agentParam, convParam]);

  const counts = { total: agents.length, working: agents.filter((a) => a.status === "Working").length, waiting: agents.filter((a) => a.status === "Waiting").length };
  const select = (key: string, t: "conversations" | "chat" | "settings" = "conversations") => {
    if (key !== selected) setChat(null);
    setSelected(key);
    setTab(t);
  };
  const openChat = (conversationId: string | null) => {
    setChat({ state: "docked", conversationId });
    setTab("chat");
  };

  return (
    <>
      <PageHeader
        code="J2"
        title="Agents"
        actions={
          <>
            <Menu<"One" | "Studio">
              label="Executor"
              value={ws}
              onChange={(v) => router.push(`/agents?ws=${v}`)}
              align="right"
              options={[
                { value: "One", label: "One", description: pinText(rt?.One?.executor, "One executor") },
                { value: "Studio", label: "Studio", description: pinText(rt?.["Studio"]?.executor, "Studio executor") },
              ]}
            />
            <ButtonLink variant="primary" size="md" href={`/agents/new?workspace=${ws}`}>
              New agent
            </ButtonLink>
          </>
        }
      >
        {data && (
          <Readout
            items={[
              { value: counts.total, label: `sub-agent${counts.total === 1 ? "" : "s"} in ${ws}` },
              { value: counts.working, label: "working" },
              { value: counts.waiting, label: "waiting" },
            ]}
          />
        )}
      </PageHeader>
      <ErrorNote error={error} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="min-w-0">
          {legacy.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-[6px] border border-safe bg-room px-4 py-2.5 text-[13px]" data-testid="migrate-notice">
              <Mark tone="you">Needs you</Mark>
              <span className="text-silver-hi">
                {legacy.length} agent{legacy.length > 1 ? "s use" : " uses"} the old format (instructions inside the definition).
              </span>
              <Button size="sm" variant="primary" onClick={() => void migrate()} disabled={migrating}>
                {migrating ? "Migrating…" : "Migrate to SOP.md + LOGS.md"}
              </Button>
              <ErrorNote error={migrateError} />
            </div>
          )}
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <label className="block w-full sm:max-w-xs">
              <span className="sr-only">Search agents</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} type="search" placeholder="Search agents..." className="h-9 w-full rounded-[4px] border border-rim bg-room px-3 text-[13px] text-paper placeholder:text-silver" />
            </label>
            <Menu<"all" | AgentView["status"]>
              label="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: "all", label: "All statuses" },
                { value: "Working", label: "Working" },
                { value: "Waiting", label: "Waiting" },
                { value: "Ready", label: "Ready" },
                { value: "Blocked", label: "Blocked" },
              ]}
            />
          </div>
          {agents.length === 0 && data ? (
            <EmptyState
              title={`No sub-agents configured for ${ws}.`}
              body={
                <>
                  {ws} agents live at the Orchestrator level in {ws === "One" ? "JOS/.claude/agents/" : "JOS/.codex/agents/"}: a definition plus a folder with its SOP.md and LOGS.md. New agent asks which connections it should have and how it should use them, then writes all three.
                </>
              }
              action={<ButtonLink href={`/agents/new?workspace=${ws}`}>New agent</ButtonLink>}
            />
          ) : (
            <ul className="rounded-[6px] border border-rim bg-room" data-testid="agents-table" aria-label={`${ws} sub-agents`}>
              {rows.map((a) => (
                <AgentPrint
                  key={a.key}
                  a={a}
                  selected={a.key === selected}
                  onSelect={() => select(a.key)}
                  onChat={() => {
                    select(a.key, "chat");
                    setChat({ state: "docked", conversationId: null });
                  }}
                  onSettings={() => select(a.key, "settings")}
                />
              ))}
              {rows.length === 0 && <li className="px-4 py-4 text-[12.5px] text-silver">No agent matches this filter.</li>}
            </ul>
          )}
        </div>
        <Panel title={agent ? `${agent.name} conversations` : "Conversations"} id="agent-panel">
          {!agent ? (
            <p className="text-[13px] text-silver">{agents.length ? "Choose an agent in the roster." : `Conversations appear here once ${ws} has a sub-agent.`}</p>
          ) : (
            <div className="space-y-3">
              <Tabs label="Agent panel" value={tab} onChange={setTab} tabs={[{ value: "conversations", label: "Conversations" }, { value: "chat", label: "Chat" }, { value: "settings", label: "Settings" }]} />
              {tab === "conversations" && (
                <>
                  <Button variant="primary" onClick={() => openChat(null)} data-testid="chat-with-agent">
                    Chat with agent
                  </Button>
                  {(convs?.conversations ?? []).length === 0 ? (
                    <p className="text-[12.5px] text-silver">No conversations yet.</p>
                  ) : (
                    <ul className="divide-y divide-rim rounded-[4px] border border-rim" data-testid="conversation-list">
                      {convs!.conversations.map((c) => (
                        <li key={c.id}>
                          <button type="button" onClick={() => openChat(c.id)} className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left transition-colors duration-200 ease-out-expo hover:bg-tray">
                            <span className="min-w-0">
                              <span className="block truncate text-[13px] text-paper" title={c.title}>
                                {c.title}
                              </span>
                              {c.last_message && <span className="block truncate text-[12px] text-silver">{c.last_message}</span>}
                            </span>
                            <span className="flex shrink-0 flex-col items-end gap-0.5">
                              <Status tone={statusTone(CONV_TONE[c.status] ?? c.status)}>{c.status}</Status>
                              <span className="text-[12px] text-silver">{timeAgo(c.updated_at)}</span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {tab === "chat" && !chat && (
                <Button variant="primary" onClick={() => openChat(null)}>
                  Chat with agent
                </Button>
              )}
              {tab === "chat" && chat?.state === "docked" && (
                <AgentChatWindow workspace={ws} agent={agent.key} agentName={agent.name} conversationId={chat.conversationId} onConversation={(id) => setChat((c) => (c ? { ...c, conversationId: id } : c))} state="docked" onState={(s) => setChat((c) => (c ? { ...c, state: s } : c))} onClose={() => setChat(null)} />
              )}
              {tab === "chat" && chat && chat.state !== "docked" && <p className="text-[12.5px] text-silver">The chat is {chat.state === "popped" ? "popped out" : "minimized"}.</p>}
              {tab === "settings" && (
                <dl className="grid grid-cols-[108px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12.5px]">
                  <dt className={label}>Purpose</dt>
                  <dd className="text-silver-hi">{agent.description || "—"}</dd>
                  <dt className={label}>Connections</dt>
                  <dd className="text-silver-hi">{agent.connections.length ? agent.connections.join(", ") : "not listed in the definition"}</dd>
                  <dt className={label}>Workspace</dt>
                  <dd className="text-silver-hi">JOS/{agent.workspace}/</dd>
                  <dt className={label}>Runtime</dt>
                  <dd className="text-silver-hi">
                    Plans on {pinText(rt?.[agent.workspace]?.planner, "the planner")} · executes on {pinText(rt?.[agent.workspace]?.executor, "the executor")} · {agent.harness === "claude" ? "Claude definition" : "Codex definition"}
                  </dd>
                  <dt className={label}>Model field</dt>
                  <dd className="text-silver-hi">{agent.model ?? "—"}</dd>
                  <dt className={label}>Registered</dt>
                  <dd className="text-silver-hi">{agent.registeredAt ? when(agent.registeredAt) : "—"}</dd>
                  <dt className={label}>Definition</dt>
                  <dd className="break-all text-silver-hi">{agent.file}</dd>
                  <dt className={label}>SOP</dt>
                  <dd className="break-all text-silver-hi">
                    {agent.sopFile ?? "none: old format"}
                    {agent.sopError && <span className="block text-fog">{agent.sopError}</span>}
                  </dd>
                  <dt className={label}>Log</dt>
                  <dd className="break-all text-silver-hi">{agent.logsFile ?? "—"}</dd>
                  <dt className={label}>Guardrails</dt>
                  <dd className="text-silver-hi">Set by the Orchestrator in the SOP; HQ enforces identity, the agent's connections, the gateway phase rules and approvals at run time. Edit re-asks your two questions and rewrites the SOP; LOGS.md is HQ's and is never edited.</dd>
                </dl>
              )}
              {tab === "settings" && (
                <div className="space-y-2 border-t border-rim pt-3">
                  <div className="flex flex-wrap gap-2">
                    {detail?.edit.editable ? (
                      <ButtonLink href={`/agents/${ws}/${encodeURIComponent(agent.key)}/edit`} data-testid="agent-edit">
                        Edit agent
                      </ButtonLink>
                    ) : (
                      <Button size="sm" disabled data-testid="agent-edit">
                        Edit agent
                      </Button>
                    )}
                    <Button size="sm" variant="danger" onClick={() => setDeleting(true)} disabled={!detail?.deletable} data-testid="agent-delete">
                      Delete agent
                    </Button>
                  </div>
                  {detail && !detail.edit.editable && (
                    <p className="text-[12px] text-silver-hi" data-testid="agent-edit-reason">
                      {detail.edit.reason}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </Panel>
      </div>
      {agent && chat && chat.state !== "docked" && (
        <AgentChatWindow workspace={ws} agent={agent.key} agentName={agent.name} conversationId={chat.conversationId} onConversation={(id) => setChat((c) => (c ? { ...c, conversationId: id } : c))} state={chat.state} onState={(s) => setChat((c) => (c ? { ...c, state: s } : c))} onClose={() => setChat(null)} />
      )}
      {agent && deleting && (
        <DeleteAgentDialog
          agent={{ workspace: ws, key: agent.key }}
          conversations={convs?.conversations.length ?? 0}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            setChat(null);
            setSelected(null);
            if (agentParam) router.replace(`/agents?ws=${ws}`);
            void reload();
          }}
        />
      )}
    </>
  );
}

export default function AgentsPage() {
  return (
    <Suspense fallback={null}>
      <AgentsInner />
    </Suspense>
  );
}
