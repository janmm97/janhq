// D3 (spec §6): among the candidates memory.ts nominates (identifiers identical, Jaccard ≥ 0.35), Jev
// judges which is the same task. The newest done one above threshold is reused exactly like today's
// lexical reuse.
import { cleanAsked, newer, type Match } from "../memory";
import { systemOne } from "./client";
import { fill, gateVersion, questionText } from "./questions";
import { recordJudgment } from "./records";
import type { NoulAnswer, NoulCriteria, Question } from "./types";

export async function judgeRepeat(o: { taskId: string; request: string; candidates: Match[] }): Promise<{ scores: number[]; recordIds: number[] } | null> {
  if (!o.candidates.length) return null;
  const q = questionText("repeat.same_as");
  const questions: Record<string, Question> = {};
  o.candidates.forEach((_c, i) => {
    questions[`same_as_${i}`] = { type: "noul", instructions: fill(q.instructions, { i }), criteria: q.criteria as unknown as NoulCriteria };
  });
  const state = { request: o.request, candidates: o.candidates.map((c) => ({ asked: cleanAsked(c.entry.asked).slice(0, 500), outcome: c.entry.outcome.slice(0, 300) })) };
  const r = await systemOne({ taskId: o.taskId, decision: "repeat", state, questions });
  if (!r.ok) return null;
  const version = gateVersion("repeat.same_as");
  const scores = o.candidates.map((_c, i) => (r.answers[`same_as_${i}`] as NoulAnswer).noul);
  const recordIds = o.candidates.map((c, i) =>
    recordJudgment({ callId: r.callId, taskId: o.taskId, gate: "repeat.same_as", version, model: r.model, subject: c.entry.taskId ?? `${c.entry.file}#${c.entry.index}`, predicted: "same", score: scores[i], answer: { noul: scores[i] }, acted: false, fallbackReason: null }),
  );
  return { scores, recordIds };
}

export function pickRepeat(candidates: Match[], scores: number[], threshold: number): { reuse: Match | null; reuseIndex: number | null; lessons: Match[] } {
  const same = candidates.map((c, i) => ({ c, i, s: scores[i] }));
  const done = same.filter((x) => x.s >= threshold && x.c.entry.status === "done").sort((a, b) => newer(a.c.entry, b.c.entry));
  const lessons = same.filter((x) => x.s >= 0.5 && x.c.entry.status !== "done").slice(0, 2).map((x) => x.c);
  return done.length ? { reuse: done[0].c, reuseIndex: done[0].i, lessons } : { reuse: null, reuseIndex: null, lessons };
}
