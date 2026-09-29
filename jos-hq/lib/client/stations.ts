// A task's six darkroom stations (Tasks/HQ-Redesign-Spec-2026-09-25.md, 1.6): a pure function of its
// status, its executions and its approvals, so the Dashboard, chats and task pages always agree.
import { markText, statusTone, type Tone } from "./format";

export type StationKey = "compose" | "strip" | "expose" | "develop" | "fix" | "dry";
export type StationState = "done" | "current" | "waiting" | "skipped" | "todo" | "failed" | "stopped";

export interface Station {
  key: StationKey;
  label: string;
  under: string;
  state: StationState;
}

export interface StationInput {
  status: string;
  executions: Array<{ phase: string; status: string }>;
  approvals: Array<{ status: string }>;
  stage?: string | null;
}

export const STATIONS: ReadonlyArray<{ key: StationKey; label: string; under: string }> = [
  { key: "compose", label: "Compose", under: "route · plan" },
  { key: "strip", label: "Test strip", under: "preview" },
  { key: "expose", label: "Expose", under: "approve" },
  { key: "develop", label: "Develop", under: "execute" },
  { key: "fix", label: "Fix", under: "verify" },
  { key: "dry", label: "Dry", under: "logged" },
];

export const STATE_TEXT: Record<StationState, string> = {
  done: "done",
  current: "now",
  waiting: "waiting for you",
  skipped: "skipped",
  todo: "not yet",
  failed: "failed here",
  stopped: "stopped here",
};

const ENDED_WELL = ["completed", "unverified", "closed", "planned"];
const FAILED = ["failed", "blocked"];
const HELD = ["needs_reconciliation", "interrupted"];
const NEEDS_YOU = ["awaiting_approval", "needs_clarification", ...HELD];
const TERMINAL = [...ENDED_WELL, ...FAILED, "cancelled", "rejected", ...HELD];

export function stationsFor(t: StationInput): Station[] {
  const hadPreview = t.executions.some((e) => e.phase === "preview");
  const hadApproval = t.approvals.length > 0;
  const approved = t.approvals.some((a) => a.status === "approved");
  const hadExecute = t.executions.some((e) => e.phase === "execute");
  const running = t.executions.find((e) => e.status === "running" || e.status === "starting");
  const reached = [true, hadPreview, hadApproval, hadExecute, t.status === "verifying" || t.stage === "verify" || ["completed", "unverified", "closed"].includes(t.status)];
  const states: StationState[] = ["todo", "todo", "todo", "todo", "todo", "todo"];
  const fill = (upTo: number) => {
    for (let i = 0; i < upTo; i++) states[i] = reached[i] ? "done" : "skipped";
  };

  if (!TERMINAL.includes(t.status)) {
    let at = 0;
    if (t.status === "verifying" || t.stage === "verify") at = 4;
    else if (running?.phase === "execute") at = 3;
    else if (t.status === "awaiting_approval") at = 2;
    else if (running?.phase === "preview") at = 1;
    else if (t.status === "needs_clarification") at = hadPreview ? 2 : 0;
    else if (t.status === "dispatching" || t.status === "executing") at = approved ? 3 : hadPreview || t.status === "executing" ? 1 : 0;
    fill(at);
    states[at] = NEEDS_YOU.includes(t.status) ? "waiting" : "current";
  } else if (ENDED_WELL.includes(t.status)) {
    fill(5);
    states[5] = "done";
  } else {
    const at = reached.lastIndexOf(true);
    fill(at);
    states[at] = FAILED.includes(t.status) ? "failed" : HELD.includes(t.status) ? "waiting" : "stopped";
    // The log is closed for a failed or cancelled task; an interrupted one stays open until reconciled.
    if (!HELD.includes(t.status)) states[5] = "done";
  }
  return STATIONS.map((s, i) => ({ ...s, state: states[i] }));
}

/** A task's mark (spec 1.5): Preview while a PREVIEW run is running, otherwise its status's own tone and word. */
export function markFor(t: StationInput): { tone: Tone; text: string } {
  const running = t.executions.find((e) => e.status === "running" || e.status === "starting");
  if (running?.phase === "preview") return { tone: "preview", text: "Preview" };
  return { tone: statusTone(t.status), text: markText(t.status) };
}
