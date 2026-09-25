"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { onStream } from "./stream";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details: unknown,
  ) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(err?.code ?? `HTTP_${res.status}`, err?.message ?? `Request failed with status ${res.status}`, res.status, err?.details ?? null);
  }
  return json as T;
}

export async function apiGet<T>(url: string): Promise<T> {
  return parse<T>(await fetch(url, { cache: "no-store" }));
}

export async function apiSend<T>(method: "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  return parse<T>(
    await fetch(url, {
      method,
      headers: { "content-type": "application/json", "x-jos-hq": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

export async function apiUpload<T>(url: string, files: File[]): Promise<T> {
  const fd = new FormData();
  for (const f of files) fd.append("file", f);
  return parse<T>(await fetch(url, { method: "POST", headers: { "x-jos-hq": "1" }, body: fd }));
}

/**
 * Fetch a JSON resource and re-fetch it whenever one of `signals` arrives on the live stream
 * (debounced), so panels reflect server truth without polling.
 */
export function useApi<T>(url: string | null, signals: string[] = [], opts: { intervalMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState<boolean>(!!url);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!url) return;
    const n = ++seq.current;
    try {
      const d = await apiGet<T>(url);
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError(e as Error);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    setLoading(!!url);
    void load();
  }, [load, url]);

  const sigKey = signals.join(",");
  useEffect(() => {
    if (!sigKey) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const list = sigKey.split(",");
    const off = onStream((m) => {
      if (list.includes(m.type) || (m.kind === "event" && list.includes("event"))) {
        if (t) clearTimeout(t);
        t = setTimeout(() => void load(), 250);
      }
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [sigKey, load]);

  useEffect(() => {
    if (!opts.intervalMs) return;
    const i = setInterval(() => void load(), opts.intervalMs);
    return () => clearInterval(i);
  }, [opts.intervalMs, load]);

  return { data, error, loading, reload: load, setData };
}
