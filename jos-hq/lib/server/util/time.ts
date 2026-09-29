import { loadConfig } from "../env";

export function nowIso(): string {
  return new Date().toISOString();
}

function parts(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** Local calendar date, the date the J/OS logs and Tasks/ names use. */
export function logDate(d = new Date()): string {
  return parts(d).date;
}

/** Absolute local timestamp in the logs' convention, e.g. "2026-09-23 03:15 CST". */
export function logTimestamp(d = new Date()): string {
  const p = parts(d);
  return `${p.date} ${p.time} ${loadConfig().logTimezoneLabel}`;
}
