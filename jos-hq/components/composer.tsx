"use client";

import { useEffect, useRef, useState } from "react";
import { apiSend, apiUpload } from "@/lib/client/api";
import { Menu, type MenuOption, cx } from "./ui";

export type RouteChoice = "auto" | "One" | "Studio";
export type ModeChoice = "manual" | "edit" | "plan" | "auto";

export const ROUTE_OPTIONS: Array<MenuOption<RouteChoice>> = [
  { value: "auto", label: "Auto", description: "J/OS routes: names and flows, topics, then live connections, and asks if it is unclear." },
  { value: "One", label: "One", description: "Send to the One executor (Claude Code Opus 5.5, medium)." },
  { value: "Studio", label: "Studio", description: "Send to the Studio executor (GPT 6 Sol, medium)." },
];

export const MODE_OPTIONS: Array<MenuOption<ModeChoice>> = [
  { value: "manual", label: "Manual", description: "Strictest. Reads proceed; every edit or action waits for your approval." },
  { value: "edit", label: "Edit automatically", description: "Local file edits proceed. Sends, deletes, publishing and charges still wait for approval." },
  { value: "plan", label: "Plan", description: "Understand, route, discover and plan, then stop. Nothing is executed." },
  { value: "auto", label: "Auto", description: "No approvals. Everything proceeds, including sends, deletes, publishing and charges. Only questions about your intent stop for you." },
];

interface Chip {
  id: string;
  name: string;
  size: number;
}

export interface SendPayload {
  content: string;
  route: RouteChoice;
  mode: ModeChoice;
  attachmentIds: string[];
}

function fmtSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function Composer({
  chatId,
  onSend,
  initialText = "",
  initialRoute = "auto",
  compact = false,
  answering,
  disabled = false,
  showRoute = true,
  placeholder = "Ask anything...",
  testIdPrefix = "composer",
}: {
  chatId?: string;
  onSend: (p: SendPayload) => Promise<void>;
  initialText?: string;
  initialRoute?: RouteChoice;
  compact?: boolean;
  answering?: string | null;
  disabled?: boolean;
  showRoute?: boolean;
  placeholder?: string;
  testIdPrefix?: string;
}) {
  const [text, setText] = useState(initialText);
  const [route, setRoute] = useState<RouteChoice>(initialRoute);
  const [mode, setMode] = useState<ModeChoice>("auto");
  const [chips, setChips] = useState<Chip[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, compact ? 180 : 320)}px`;
  }, [text, compact]);

  const send = async () => {
    const content = text.trim();
    if (!content || sending || disabled) return;
    setSending(true);
    setError(null);
    try {
      await onSend({ content, route, mode, attachmentIds: chips.map((c) => c.id) });
      setText("");
      setChips([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
      area.current?.focus();
    }
  };

  const attach = async (files: FileList | null) => {
    if (!files?.length || !chatId) return;
    setError(null);
    try {
      const r = await apiUpload<{ attachments: Chip[] }>(`/api/chats/${chatId}/attachments`, Array.from(files));
      setChips((c) => [...c, ...r.attachments]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (file.current) file.current.value = "";
    }
  };

  const remove = async (id: string) => {
    setChips((c) => c.filter((x) => x.id !== id));
    try {
      await apiSend("DELETE", `/api/attachments/${id}`);
    } catch {
      /* already attached to a task or gone */
    }
  };

  return (
    // The textarea's own outline is off; the box shows focus with the safelight rim instead.
    <div className={cx("rounded-[6px] border border-rim-strong bg-room shadow-[0_20px_50px_-24px_rgba(0,0,0,0.95)] transition-colors duration-200 ease-out-expo focus-within:border-safe", compact ? "p-2" : "p-3")}>
      {answering && <p className="mb-1.5 px-1 text-[12.5px] text-safe">Answering: {answering}</p>}
      {chips.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Attachments">
          {chips.map((c) => (
            <li key={c.id} className="inline-flex items-center gap-1.5 rounded-[4px] border border-rim bg-tray py-1 pl-2.5 pr-1 text-[12.5px]">
              <span className="max-w-[200px] truncate text-silver-hi" title={c.name}>
                {c.name}
              </span>
              <span className="text-silver">{fmtSize(c.size)}</span>
              <button type="button" onClick={() => void remove(c.id)} aria-label={`Remove ${c.name}`} className="rounded-[3px] p-0.5 text-silver hover:bg-room hover:text-paper">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                  <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="sr-only" htmlFor={`${testIdPrefix}-input`}>
        Message J/OS
      </label>
      <textarea
        id={`${testIdPrefix}-input`}
        ref={area}
        data-testid={`${testIdPrefix}-input`}
        value={text}
        rows={compact ? 2 : 3}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Hard requirement: plain Enter and Shift+Enter insert a newline. Only Ctrl/Cmd+Enter sends.
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
        className={cx("block w-full resize-none bg-transparent px-1.5 text-paper placeholder:text-silver focus:outline-none focus-visible:outline-none", compact ? "text-[13.5px]" : "text-[14px] leading-[1.55]")}
      />
      <div className="mt-2 flex items-center gap-2">
        {chatId && (
          <>
            <input ref={file} type="file" multiple className="hidden" onChange={(e) => void attach(e.target.files)} aria-hidden tabIndex={-1} />
            <button type="button" onClick={() => file.current?.click()} aria-label="Attach files" title="Attach local files" data-testid={`${testIdPrefix}-attach`} className="grid size-8 place-items-center rounded-[4px] border border-rim-strong text-silver-hi transition-colors duration-200 ease-out-expo hover:border-silver hover:text-paper">
              <svg aria-hidden width="12" height="12" viewBox="0 0 12 12">
                <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          </>
        )}
        {showRoute && <Menu<RouteChoice> label="Route" value={route} onChange={setRoute} options={ROUTE_OPTIONS} placement="top" testId={`${testIdPrefix}-route`} />}
        <div className="ml-auto flex items-center gap-2">
          <Menu<ModeChoice> label="Mode" value={mode} onChange={setMode} options={MODE_OPTIONS} align="right" placement="top" testId={`${testIdPrefix}-mode`} />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!text.trim() || sending || disabled}
            data-testid={`${testIdPrefix}-send`}
            className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-safe bg-safe px-3.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-on-safe transition-colors duration-200 ease-out-expo hover:bg-safe-lit disabled:cursor-not-allowed disabled:border-rim disabled:bg-transparent disabled:text-gray"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 px-1 text-[12.5px] text-fog">
          {error}
        </p>
      )}
    </div>
  );
}
