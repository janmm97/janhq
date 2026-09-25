import { EventEmitter } from "node:events";
import { all, json, parseJson, run } from "./db";
import { nowIso } from "./util/time";
import { redactDeep, redactSecrets } from "./util/redact";

export type EventLevel = "info" | "success" | "warning" | "error";
export type EventSystem = "orchestrator" | "One" | "Studio" | "hq";
export type EventVisibility = "chat" | "details";

export interface HqEvent {
  id: number;
  taskId: string | null;
  executionId: string | null;
  system: EventSystem | null;
  type: string;
  level: EventLevel;
  visibility: EventVisibility;
  summary: string;
  data: unknown;
  createdAt: string;
}

export interface EmitInput {
  taskId?: string | null;
  executionId?: string | null;
  system?: EventSystem | null;
  type: string;
  level?: EventLevel;
  visibility?: EventVisibility;
  summary: string;
  data?: unknown;
}

const g = globalThis as unknown as { __josHqBus?: EventEmitter };
function bus(): EventEmitter {
  if (!g.__josHqBus) {
    g.__josHqBus = new EventEmitter();
    g.__josHqBus.setMaxListeners(0);
  }
  return g.__josHqBus;
}

export function emit(input: EmitInput): HqEvent {
  const createdAt = nowIso();
  const summary = redactSecrets(input.summary).slice(0, 4000);
  const data = input.data === undefined ? null : redactDeep(input.data);
  const level = input.level ?? "info";
  const visibility = input.visibility ?? "details";
  const r = run(
    `INSERT INTO events(task_id, execution_id, system, type, level, visibility, summary, data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.taskId ?? null, input.executionId ?? null, input.system ?? null, input.type, level, visibility, summary, json(data), createdAt],
  );
  const ev: HqEvent = {
    id: Number(r.lastInsertRowid),
    taskId: input.taskId ?? null,
    executionId: input.executionId ?? null,
    system: input.system ?? null,
    type: input.type,
    level,
    visibility,
    summary,
    data,
    createdAt,
  };
  bus().emit("event", ev);
  return ev;
}

/** Broadcast a UI invalidation signal without persisting it. */
export function signal(type: string, data: Record<string, unknown> = {}) {
  bus().emit("signal", { type, data, createdAt: nowIso() });
}

export function onEvent(cb: (e: HqEvent) => void): () => void {
  bus().on("event", cb);
  return () => bus().off("event", cb);
}

export function onSignal(cb: (s: { type: string; data: Record<string, unknown> }) => void): () => void {
  bus().on("signal", cb);
  return () => bus().off("signal", cb);
}

interface EventRow {
  id: number;
  task_id: string | null;
  execution_id: string | null;
  system: string | null;
  type: string;
  level: string;
  visibility: string;
  summary: string;
  data_json: string | null;
  created_at: string;
}

export function rowToEvent(r: EventRow): HqEvent {
  return {
    id: r.id,
    taskId: r.task_id,
    executionId: r.execution_id,
    system: r.system as EventSystem | null,
    type: r.type,
    level: r.level as EventLevel,
    visibility: r.visibility as EventVisibility,
    summary: r.summary,
    data: parseJson(r.data_json, null),
    createdAt: r.created_at,
  };
}

export function taskEvents(taskId: string, afterId = 0, limit = 5000): HqEvent[] {
  return all<EventRow>("SELECT * FROM events WHERE task_id = ? AND id > ? ORDER BY id ASC LIMIT ?", [taskId, afterId, limit]).map(rowToEvent);
}

export function recentEvents(limit = 200, afterId = 0): HqEvent[] {
  return all<EventRow>("SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?", [afterId, limit]).map(rowToEvent).reverse();
}

/**
 * Server-Sent Events response. Replays persisted events after `Last-Event-ID` (or ?after=) for the
 * task, then streams live ones. Signals (UI invalidations) are streamed as `event: signal`.
 */
export function sseResponse(req: Request, opts: { taskId?: string; replay?: boolean; signals?: boolean; visibility?: EventVisibility }): Response {
  const url = new URL(req.url);
  const lastId = Number(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0) || 0;
  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup?.();
        }
      };
      const sendEvent = (e: HqEvent) => {
        if (opts.taskId && e.taskId !== opts.taskId) return;
        if (opts.visibility && e.visibility !== opts.visibility) return;
        send(`id: ${e.id}\nevent: hq\ndata: ${JSON.stringify(e)}\n\n`);
      };
      send(`retry: 2000\n: connected\n\n`);
      if (opts.replay !== false && opts.taskId) {
        for (const e of taskEvents(opts.taskId, lastId)) sendEvent(e);
      }
      const offEvent = onEvent(sendEvent);
      const offSignal = opts.signals ? onSignal((s) => send(`event: signal\ndata: ${JSON.stringify(s)}\n\n`)) : () => {};
      const ping = setInterval(() => send(`: ping ${Date.now()}\n\n`), 15000);
      cleanup = () => {
        clearInterval(ping);
        offEvent();
        offSignal();
        cleanup = null;
      };
      req.signal.addEventListener("abort", () => {
        cleanup?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
