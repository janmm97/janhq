"use client";

// One shared EventSource for the whole app: chat-visible events plus UI invalidation signals.
export type StreamMessage =
  | { kind: "signal"; type: string; data: Record<string, unknown> }
  | { kind: "event"; type: string; event: HqEventView };

export interface HqEventView {
  id: number;
  taskId: string | null;
  executionId: string | null;
  system: string | null;
  type: string;
  level: "info" | "success" | "warning" | "error";
  visibility: "chat" | "details";
  summary: string;
  data: unknown;
  createdAt: string;
}

type Listener = (m: StreamMessage) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
let connected = false;
const statusListeners = new Set<(c: boolean) => void>();

function ensure() {
  if (source || typeof window === "undefined") return;
  source = new EventSource("/api/stream");
  source.onopen = () => {
    connected = true;
    statusListeners.forEach((l) => l(true));
  };
  source.onerror = () => {
    connected = false;
    statusListeners.forEach((l) => l(false));
  };
  source.addEventListener("signal", (e) => {
    try {
      const s = JSON.parse((e as MessageEvent).data) as { type: string; data: Record<string, unknown> };
      listeners.forEach((l) => l({ kind: "signal", type: s.type, data: s.data }));
    } catch {
      /* ignore */
    }
  });
  source.addEventListener("hq", (e) => {
    try {
      const ev = JSON.parse((e as MessageEvent).data) as HqEventView;
      listeners.forEach((l) => l({ kind: "event", type: ev.type, event: ev }));
    } catch {
      /* ignore */
    }
  });
}

export function onStream(l: Listener): () => void {
  ensure();
  listeners.add(l);
  return () => listeners.delete(l);
}

export function onStreamStatus(l: (connected: boolean) => void): () => void {
  ensure();
  statusListeners.add(l);
  l(connected);
  return () => statusListeners.delete(l);
}
