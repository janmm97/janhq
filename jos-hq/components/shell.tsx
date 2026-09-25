"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { apiGet, apiSend, useApi } from "@/lib/client/api";
import { onStreamStatus } from "@/lib/client/stream";
import { STATUS_TEXT, statusTone } from "@/lib/client/format";
import { Status, StatusDot, cx, useOutsideClose } from "./ui";
import { HealthDrawer, type HealthReportView } from "./health";
import { DeleteChatDialog, TrashIcon } from "./chat-delete";

interface ChatItem {
  id: string;
  title: string;
  updated_at: string;
  last_status: string | null;
  last_route: string | null;
}

export function Brand() {
  return (
    <div className="flex select-none items-baseline gap-2">
      <span className="text-[20px] font-extrabold leading-none tracking-[-0.02em] text-paper">J/OS</span>
      <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-silver">HQ</span>
    </div>
  );
}

function NavItem({ href, code, label, active, children }: { href: string; code: string; label: string; active: boolean; children?: ReactNode }) {
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={cx(
          "flex items-center gap-3 rounded-[4px] border px-2.5 py-2 text-[13px] transition-colors duration-200 ease-out-expo",
          active ? "border-rim bg-tray text-paper" : "border-transparent text-silver-hi hover:bg-tray hover:text-paper",
        )}
      >
        <span className="w-6 text-[11px] font-bold tracking-[0.08em] text-silver">{code}</span>
        {label}
      </Link>
      {children}
    </li>
  );
}

function SidebarInner({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const { data } = useApi<{ chats: ChatItem[] }>("/api/chats", ["chats_updated", "chat_message", "task_updated"]);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ChatItem | null>(null);
  const closeDelete = useCallback(() => setDeleting(null), []);
  const ws = params.get("ws") ?? params.get("workspace");
  const chatId = path.startsWith("/chat/") ? path.split("/")[2] : null;
  const agentsWs = path.startsWith("/agents/Studio") ? "Studio" : path.startsWith("/agents/One") ? "One" : ws ?? "One";

  const newChat = async () => {
    setCreating(true);
    try {
      const r = await apiSend<{ chat: { id: string } }>("POST", "/api/chats", {});
      onNavigate?.();
      router.push(`/chat/${r.chat.id}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <nav aria-label="J/OS" className="flex h-full flex-col">
      <div className="px-5 pb-6 pt-5">
        <Brand />
      </div>
      <ul className="space-y-0.5 px-3" onClick={onNavigate}>
        <NavItem href="/" code="J1" label="Dashboard" active={path === "/"} />
        <NavItem href="/agents" code="J2" label="Agents" active={path.startsWith("/agents")}>
          <ul className="ml-[42px] mt-0.5 space-y-0.5 border-l border-rim pl-2">
            {(["One", "Studio"] as const).map((w) => {
              const on = path.startsWith("/agents") && agentsWs === w;
              return (
                <li key={w}>
                  <Link href={`/agents?ws=${w}`} aria-current={on ? "true" : undefined} className={cx("flex items-center gap-2 rounded-[3px] px-2 py-1 text-[12.5px]", on ? "text-paper" : "text-silver hover:text-paper")}>
                    <span aria-hidden className={cx("inline-block size-[5px] rounded-[1px]", on ? "bg-paper" : "bg-transparent")} />
                    {w}
                  </Link>
                </li>
              );
            })}
          </ul>
        </NavItem>
        <NavItem href="/connections" code="J3" label="Connections" active={path.startsWith("/connections")} />
        <NavItem href="/workflows" code="J4" label="Workflows" active={path.startsWith("/workflows")} />
      </ul>

      <div className="mx-5 my-4 border-t border-rim" />
      <div className="px-5 pb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-silver">Chats</div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-2" aria-label="Chats">
        {(data?.chats ?? []).length === 0 && <li className="px-2.5 py-1.5 text-[12.5px] text-silver">No chats yet.</li>}
        {(data?.chats ?? []).map((c) => (
          <li key={c.id} className="group relative">
            <Link
              href={`/chat/${c.id}`}
              onClick={onNavigate}
              title={c.title}
              aria-current={chatId === c.id ? "page" : undefined}
              className={cx("block rounded-[4px] border py-1.5 pl-2.5 pr-8", chatId === c.id ? "border-rim bg-tray text-paper" : "border-transparent text-silver-hi hover:bg-tray hover:text-paper")}
            >
              <span className="block truncate text-[13px]">{c.title}</span>
              {c.last_status && (
                <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-silver">
                  <StatusDot tone={statusTone(c.last_status)} />
                  <span className="truncate">
                    {c.last_route && c.last_route !== "none" ? `${c.last_route} · ` : ""}
                    {(STATUS_TEXT[c.last_status] ?? c.last_status).toLowerCase()}
                  </span>
                </span>
              )}
            </Link>
            <button
              type="button"
              onClick={() => setDeleting(c)}
              aria-label={`Delete chat ${c.title}`}
              title="Delete chat"
              className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-[4px] text-silver opacity-0 hover:bg-fog/10 hover:text-fog focus-visible:opacity-100 group-hover:opacity-100"
            >
              <TrashIcon />
            </button>
          </li>
        ))}
      </ul>
      <DeleteChatDialog
        chat={deleting}
        onClose={closeDelete}
        onDeleted={(id) => {
          setDeleting(null);
          if (chatId === id) router.push("/");
        }}
      />
      <div className="border-t border-rim p-3">
        <button
          type="button"
          onClick={newChat}
          disabled={creating}
          data-testid="new-chat"
          className="flex h-10 w-full items-center justify-center gap-2 rounded-[4px] border border-rim-strong text-[12px] font-semibold uppercase tracking-[0.08em] text-paper transition-colors duration-200 ease-out-expo hover:border-silver hover:bg-tray disabled:cursor-not-allowed disabled:border-rim disabled:text-gray"
        >
          <svg aria-hidden width="12" height="12" viewBox="0 0 12 12">
            <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          New chat
        </button>
      </div>
    </nav>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Suspense fallback={null}>
      <SidebarInner onNavigate={onNavigate} />
    </Suspense>
  );
}

interface SearchResults {
  chats: Array<{ id: string; title: string; preview: string | null }>;
  agents: Array<{ key: string; name: string; workspace: string; description: string }>;
  connections: Array<{ tool: string; platform: string; scope: string; name: string }>;
  workflows: Array<{ id: string; name: string; owner: string }>;
}

function GlobalSearch() {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<SearchResults | null>(null);
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const ref = useOutsideClose(open, () => setOpen(false));
  useEffect(() => {
    if (!q.trim()) {
      setRes(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setRes(await apiGet<SearchResults>(`/api/search?q=${encodeURIComponent(q)}`));
        setOpen(true);
      } catch {
        setRes(null);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [q]);
  const go = (href: string) => {
    setOpen(false);
    setQ("");
    router.push(href);
  };
  const empty = res && !res.chats.length && !res.agents.length && !res.connections.length && !res.workflows.length;
  return (
    // Below the sm breakpoint the search takes its own row, so the top bar never widens the page.
    <div ref={ref} className="relative order-last w-full min-w-0 sm:order-none sm:max-w-[440px] sm:flex-1">
      <label className="sr-only" htmlFor="jos-search">
        Search J/OS
      </label>
      <svg aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-silver" width="14" height="14" viewBox="0 0 14 14">
        <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M9.5 9.5 13 13" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <input
        id="jos-search"
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => res && setOpen(true)}
        placeholder="Search J/OS..."
        autoComplete="off"
        className="h-9 w-full rounded-[4px] border border-rim bg-room pl-9 pr-3 text-[13px] text-paper placeholder:text-silver focus:border-silver"
      />
      {open && res && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1.5 max-h-[60vh] overflow-y-auto rounded-[6px] border border-rim-strong bg-room p-2 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.85)]">
          {empty && <p className="px-2 py-2 text-[12.5px] text-silver">Nothing matches “{q}”.</p>}
          {res.chats.length > 0 && <SearchGroup title="Chats" items={res.chats.map((c) => ({ key: c.id, label: c.title, sub: c.preview ?? undefined, href: `/chat/${c.id}` }))} go={go} />}
          {res.agents.length > 0 && <SearchGroup title="Agents" items={res.agents.map((a) => ({ key: `${a.workspace}:${a.key}`, label: a.name, sub: `${a.workspace} · ${a.description}`, href: `/agents?ws=${a.workspace}&agent=${encodeURIComponent(a.key)}` }))} go={go} />}
          {res.connections.length > 0 && <SearchGroup title="Connections" items={res.connections.map((c, i) => ({ key: `${c.scope}:${c.name}:${i}`, label: `${c.tool} — ${c.name}`, sub: c.scope, href: `/connections?q=${encodeURIComponent(c.tool)}` }))} go={go} />}
          {res.workflows.length > 0 && <SearchGroup title="Workflows" items={res.workflows.map((w) => ({ key: w.id, label: w.name, sub: w.owner, href: `/workflows?q=${encodeURIComponent(w.name)}` }))} go={go} />}
        </div>
      )}
    </div>
  );
}

function SearchGroup({ title, items, go }: { title: string; items: Array<{ key: string; label: string; sub?: string; href: string }>; go: (h: string) => void }) {
  return (
    <div className="py-1">
      <div className="px-2 pb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-silver">{title}</div>
      {items.map((i) => (
        <button key={i.key} type="button" onClick={() => go(i.href)} title={i.sub ? `${i.label}\n${i.sub}` : i.label} className="block w-full rounded-[4px] px-2 py-1.5 text-left hover:bg-tray">
          <span className="block truncate text-[13px] text-paper">{i.label}</span>
          {i.sub && <span className="block truncate text-[12px] text-silver">{i.sub}</span>}
        </button>
      ))}
    </div>
  );
}

interface AttentionItemView {
  taskId: string;
  title: string;
  route: string | null;
  kind: "approval" | "question" | "reconcile";
  since: string;
  href: string;
}
const WAITS_ON: Record<AttentionItemView["kind"], string> = { approval: "an approval", question: "an answer", reconcile: "a reconciliation" };

/**
 * Needs you · n: on every page whenever anything waits on the operator; opens the oldest.
 * Compact (the chat header) drops the words below sm and keeps the square and "· n", so a 390 px row never overflows.
 */
export function AttentionChip({ compact = false }: { compact?: boolean }) {
  const { data } = useApi<{ items: AttentionItemView[] }>("/api/attention", ["task_updated", "approval_required", "approval_resolved"]);
  const items = data?.items ?? [];
  if (!items.length) return null;
  const first = items[0];
  return (
    <Link
      href={first.href}
      data-testid="needs-you"
      title={items.map((i) => `${i.title} · waits on ${WAITS_ON[i.kind]}`).join("\n")}
      aria-label={`Needs you: ${items.length}. Open ${first.title}, which waits on ${WAITS_ON[first.kind]}`}
      className={cx(
        "inline-flex h-9 shrink-0 items-center gap-2 rounded-[4px] border border-safe bg-safe text-[12px] font-bold uppercase tracking-[0.1em] text-on-safe transition-colors duration-200 ease-out-expo hover:border-safe-lit hover:bg-safe-lit focus-visible:transition-none",
        compact ? "px-2.5 sm:px-3" : "px-3",
      )}
    >
      <span aria-hidden className="inline-block size-[7px] rounded-[1px] bg-on-safe" />
      {compact ? (
        <span>
          <span className="hidden sm:inline">Needs you </span>· {items.length}
        </span>
      ) : (
        <>Needs you · {items.length}</>
      )}
    </Link>
  );
}

function pinsVerified(h: HealthReportView): number {
  return (["One", "Studio"] as const).reduce((n, w) => n + (h.executors[w].modelVerification.state === "verified" ? 1 : 0) + (h.executors[w].planner.modelVerification.state === "verified" ? 1 : 0), 0);
}

export function RuntimeIndicator({ onOpen }: { onOpen: () => void }) {
  const { data, error } = useApi<HealthReportView>("/api/runtime/health", ["health_updated"], { intervalMs: 60000 });
  const [live, setLive] = useState(true);
  useEffect(() => onStreamStatus(setLive), []);
  const status = error ? "Blocked" : data?.status ?? "Checking";
  const pins = data ? pinsVerified(data) : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="runtime-indicator"
      aria-haspopup="dialog"
      className={cx("flex h-9 items-center gap-2 rounded-[4px] border bg-room px-3 text-[12.5px] transition-colors duration-200 ease-out-expo hover:border-silver", status === "Blocked" ? "border-fog/60" : "border-rim")}
    >
      <span className="hidden text-[11px] font-bold uppercase tracking-[0.14em] text-silver sm:inline">Runtime</span>
      <Status tone={status === "Checking" ? "plan" : statusTone(status)}>{error ? "HQ unreachable" : status === "Healthy" ? "ok" : status}</Status>
      {pins !== null && <span className="hidden text-silver md:inline">· {pins === 4 ? "4 pins" : `${pins}/4 pins verified`}</span>}
      {!live && <span className="text-[12px] text-silver-hi">reconnecting</span>}
    </button>
  );
}

export function TopBar({ onMenu }: { onMenu: () => void }) {
  const [health, setHealth] = useState(false);
  return (
    <header className="sticky top-0 z-40 flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b border-rim bg-ground px-4 py-2.5 lg:px-6">
      <button type="button" onClick={onMenu} className="rounded-[4px] p-1.5 text-silver hover:bg-tray hover:text-paper lg:hidden" aria-label="Open navigation">
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
          <path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      <GlobalSearch />
      <AttentionChip />
      <div className="ml-auto flex items-center gap-3">
        <RuntimeIndicator onOpen={() => setHealth(true)} />
        <div className="flex items-center gap-2" aria-label="Operator">
          <span className="grid size-8 place-items-center rounded-[4px] border border-rim-strong text-[12px] font-bold text-paper">J</span>
          <span className="hidden text-[12.5px] text-silver-hi sm:inline">Operator</span>
        </div>
      </div>
      <HealthDrawer open={health} onClose={() => setHealth(false)} />
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState(false);
  const drawer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu]);
  return (
    <div className="flex min-h-screen bg-ground">
      <aside className="sticky top-0 hidden h-screen w-[264px] shrink-0 border-r border-rim bg-ground lg:block">
        <Sidebar />
      </aside>
      {menu && (
        <div className="fixed inset-0 z-[60] bg-black/70 lg:hidden" onMouseDown={(e) => e.target === e.currentTarget && setMenu(false)}>
          <div ref={drawer} className="h-full w-[264px] border-r border-rim bg-ground">
            <Sidebar onNavigate={() => setMenu(false)} />
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setMenu(true)} />
        <main className="enlarger w-full flex-1 px-4 py-6 lg:px-8">
          <div className="mx-auto w-full max-w-[1600px]">{children}</div>
        </main>
      </div>
    </div>
  );
}

export function PageHeader({ code, title, description, children, actions }: { code: string; title: string; description?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 max-w-full">
        <h1 className="flex min-w-0 items-baseline gap-3 text-[22px] font-bold tracking-[-0.02em] text-paper" title={title}>
          <span className="shrink-0 text-[13px] font-bold tracking-[0.08em] text-silver">{code}</span>
          <span className="min-w-0 truncate">{title}</span>
        </h1>
        {description && <p className="mt-1.5 max-w-[76ch] text-[13px] text-silver">{description}</p>}
        {children && <div className="mt-2">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
