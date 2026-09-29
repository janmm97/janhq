// D2 (spec §6): skip the planning session when Jev is confident the task is one read-only lookup on
// one connection. The executor still runs in PREVIEW, where the gateway refuses every write, and is
// told to return needs_planning if the task turns out bigger; HQ then plans it once.
import type { ConnectionInfo } from "../one/discovery";
import { toolCatalog } from "./catalog";
import { gate } from "./gates";
import { gateVersion } from "./questions";
import { markActed, recordJudgment } from "./records";
import type { UnderstandResult } from "./understand";

export interface FastPath { connection: { name: string; key: string; platform: string }; purpose: string | null; score: number; recordId: number | null }

export function fastPathCandidate(u: UnderstandResult | null, o: { request: string; conns: ConnectionInfo[]; usesThreshold: number }): { connection: { name: string; key: string; platform: string }; score: number } | null {
  if (!u) return null;
  if (u.sideEffects >= 0.1 || u.complexity.score >= 0.5) return null;
  const needed = Object.entries(u.platforms).filter(([, n]) => n >= o.usesThreshold).map(([p]) => p);
  if (needed.length !== 1) return null;
  const platform = needed[0];
  const live = o.conns.filter((c) => c.platform === platform && c.state === "operational");
  const lower = o.request.toLowerCase();
  const named = live.filter((c) => lower.includes(c.name.toLowerCase()));
  const pick = live.length === 1 ? live[0] : named.length === 1 ? named[0] : null;
  if (!pick) return null;
  return { connection: { name: pick.name, key: pick.key, platform }, score: u.complexity.single * (1 - u.sideEffects) * u.platforms[platform] };
}

/** `excluded` names why this task may never take the fast path (Plan mode, agent, flow, brief, bounced). */
export function decideFastPath(o: { taskId: string; u: UnderstandResult | null; request: string; conns: ConnectionInfo[]; excluded: string | null }): { take: boolean; pick: FastPath | null } {
  const g = gate("fastpath");
  if (g.mode === "off" || !o.u) return { take: false, pick: null };
  // A task that already bounced once never retakes the fast path (evaluatePreview clears fastPath and
  // sets fastPathBounced on the bounce); recording again here would duplicate the record this same
  // task already got when it was first taken.
  if (o.excluded === "bounced before") return { take: false, pick: null };
  const cand = fastPathCandidate(o.u, { request: o.request, conns: o.conns, usesThreshold: gate("understand.uses").threshold ?? 0.8 });
  if (!cand) return { take: false, pick: null };
  const take = !o.excluded && g.live && g.threshold !== null && cand.score >= g.threshold;
  const recordId = recordJudgment({
    callId: null, taskId: o.taskId, gate: "fastpath", version: gateVersion("fastpath"), model: o.u.model, subject: cand.connection.platform,
    predicted: "fast", score: cand.score, answer: { complexity: o.u.complexity, sideEffects: o.u.sideEffects }, acted: take,
    fallbackReason: take ? null : o.excluded ?? (g.live ? "below threshold" : `gate ${g.mode}`),
  });
  if (!take) markActed(recordId, false, o.excluded ?? (g.live ? "below threshold" : `gate ${g.mode}`));
  return { take, pick: { ...cand, purpose: toolCatalog()[cand.connection.platform]?.purpose ?? null, recordId } };
}
