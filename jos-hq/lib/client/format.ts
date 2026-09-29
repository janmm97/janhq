export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function duration(fromIso: string | null | undefined, now = Date.now()): string {
  if (!fromIso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** US dollars; sub-cent amounts (a planner call is about $0.003) keep enough digits to be non-zero. */
export function usd(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  return `$${amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2)}`;
}

export function stamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const STATUS_TEXT: Record<string, string> = {
  queued: "Received",
  routing: "Routing",
  needs_clarification: "Needs your answer",
  discovering: "Discovering",
  in_line: "In line",
  planning: "Planning",
  dispatching: "Dispatching",
  executing: "Executing",
  awaiting_approval: "Awaiting approval",
  verifying: "Verifying",
  completed: "Verified complete",
  unverified: "Execution complete — not verified",
  planned: "Planned",
  failed: "Failed",
  blocked: "Blocked",
  cancelled: "Cancelled",
  rejected: "Rejected",
  interrupted: "Interrupted",
  needs_reconciliation: "Needs reconciliation",
  closed: "Closed",
};

/** A state's tone in the darkroom (spec 1.5): outline, dash and fill carry it; only "you" and "fog" have colour. */
export type Tone = "you" | "run" | "plan" | "line" | "fixed" | "unfixed" | "fog" | "pulled" | "preview";
const TONES: Array<[Tone, string[]]> = [
  ["you", ["awaiting_approval", "needs_clarification", "needs_reconciliation", "interrupted", "Waiting"]],
  ["fog", ["failed", "blocked", "Blocked", "Down", "fail", "Failed"]],
  ["fixed", ["completed", "planned", "closed", "Operational", "Healthy", "pass", "verified", "Verified", "Complete", "done", "succeeded"]],
  ["unfixed", ["unverified", "warn", "Attention", "stale", "unverified_model", "ambiguous"]],
  ["run", ["executing", "verifying", "Working", "Verifying", "running", "starting", "Active"]],
  ["line", ["in_line", "queued"]],
  ["pulled", ["cancelled", "rejected", "superseded", "Paused"]],
];

/** The tone for any HQ status word; everything not listed (routing, planning, Idle, Ready…) is "plan". */
export function statusTone(status: string): Tone {
  for (const [tone, list] of TONES) if (list.includes(status)) return tone;
  return "plan";
}

/** The short word a mark carries (spec 1.5). STATUS_TEXT stays the long form for sentences. */
export const MARK_TEXT: Record<string, string> = {
  queued: "In line",
  in_line: "In line",
  routing: "Planning",
  discovering: "Planning",
  planning: "Planning",
  dispatching: "Planning",
  executing: "Running",
  verifying: "Verifying",
  awaiting_approval: "Needs you",
  needs_clarification: "Needs you",
  needs_reconciliation: "Needs you",
  interrupted: "Needs you",
  completed: "Verified",
  planned: "Planned",
  closed: "Done",
  unverified: "Unverified",
  failed: "Failed",
  blocked: "Blocked",
  cancelled: "Cancelled",
  rejected: "Rejected",
};
export function markText(status: string): string {
  return MARK_TEXT[status] ?? status;
}

export const MODE_TEXT: Record<string, string> = { manual: "Manual", edit: "Edit automatically", plan: "Plan", auto: "Auto" };

const two = (n: number) => String(n).padStart(2, "0");
function clockOf(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`;
}
/** Elapsed time as a timer reads it: mm:ss, or h:mm:ss past an hour. */
export function elapsed(fromIso: string, now: number): string {
  return clockOf((now - Date.parse(fromIso)) / 1000);
}
/** The same reading between two instants. */
export function span(fromIso: string, toIso: string): string {
  return clockOf((Date.parse(toIso) - Date.parse(fromIso)) / 1000);
}
/** HH:MM for today, "Sep 24" for another day. */
export function when(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return new Date(now).toDateString() === d.toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}
