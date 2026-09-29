// What the Tuning page and Runtime Health show.
import { all } from "../db";
import { discoverAll } from "../one/discovery";
import { undescribedPlatforms } from "./catalog";
import { breakerState, rootJevKey, systemOne } from "./client";
import { GATES, TARGETS, judgeConfig } from "./config";
import { gate } from "./gates";
import { questionText } from "./questions";
import { callStats, labelled, latestThreshold } from "./records";
import { backfillStatus } from "./backfill";
import type { ChoiceAnswer, QuestionKey, ScoreAnswer } from "./types";

const QUESTIONS: QuestionKey[] = ["understand.uses", "understand.mail_role", "understand.complexity", "understand.side_effects", "trim.connection", "repeat.same_as"];

const PROBE_CHOICES = { blue: "The sky is blue.", red: "The sky is red.", other: "Something else." };

export interface ProbeFormats { scoreKeys: string[]; scoreRange: [number, number] | null; choiceOk: boolean }

/**
 * One live call that also checks the answer formats D1 relies on: a Score answer keyed "0".."N-1" with
 * `score` inside that range (understand() reads complexity.probabilities["0"]), and a Choice answer
 * that picks one of the offered keys.
 */
export async function probe(): Promise<{ ok: boolean; model: string | null; ms: number; error: string | null; formats: ProbeFormats | null }> {
  const started = Date.now();
  const r = await systemOne({
    taskId: null,
    decision: "probe",
    state: { text: "The sky is blue." },
    questions: {
      blue: { type: "noul", instructions: "Does `text` say the sky is blue?" },
      level: { type: "score", instructions: "How clearly does `text` state the colour of the sky?", criteria: ["Not at all", "Vaguely", "Plainly"] },
      pick: { type: "choice", instructions: "What colour does `text` give the sky?", criteria: PROBE_CHOICES },
    },
  });
  const ms = Date.now() - started;
  if (!r.ok) return { ok: false, model: null, ms, error: r.error, formats: null };
  const formats = probeFormats(r.answers.level as ScoreAnswer, r.answers.pick as ChoiceAnswer);
  const problems: string[] = [];
  if (formats.scoreKeys.join() !== "0,1,2") problems.push(`score probabilities are keyed ${formats.scoreKeys.join(", ") || "(none)"}, expected 0, 1, 2`);
  const score = (r.answers.level as ScoreAnswer).score;
  if (!(score >= 0 && score <= 2)) problems.push(`score ${score} is outside 0..2`);
  if (!formats.choiceOk) problems.push("the choice answer did not pick one of the offered keys");
  return { ok: !problems.length, model: r.model, ms, error: problems.length ? `answer formats differ from what the judge layer assumes: ${problems.join("; ")}` : null, formats };
}

export function probeFormats(level: ScoreAnswer, pick: ChoiceAnswer): ProbeFormats {
  const scoreKeys = Object.keys(level.probabilities ?? {}).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  const nums = scoreKeys.map(Number);
  const scoreRange: [number, number] | null = nums.length && nums.every(Number.isInteger) ? [Math.min(...nums), Math.max(...nums)] : null;
  const offered = Object.keys(PROBE_CHOICES);
  const choiceOk = offered.includes(pick.choice) && Object.keys(pick.probabilities ?? {}).every((k) => offered.includes(k));
  return { scoreKeys, scoreRange, choiceOk };
}

export async function judgeView() {
  const cfg = judgeConfig();
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const d = await discoverAll();
  const key = cfg ? await rootJevKey() : null;
  const gates = GATES.map((k) => {
    const g = gate(k);
    const rows = cfg ? labelled(k, g.version, g.model) : [];
    const at = g.threshold ?? 0;
    const sub = rows.filter((r) => r.score >= at);
    const misses = all<{ task_id: string | null; subject: string | null; predicted: string; score: number; created_at: string; title: string | null }>(
      "SELECT r.task_id, r.subject, r.predicted, r.score, r.created_at, t.title FROM judge_records r LEFT JOIN tasks t ON t.id = r.task_id WHERE r.gate = ? AND r.version = ? AND r.label = 0 ORDER BY r.id DESC LIMIT 10",
      [k, g.version],
    );
    return { key: k, mode: g.mode, live: g.live, held: g.held ?? null, version: g.version, model: g.model, threshold: g.threshold, target: TARGETS[k], labelled: rows.length, accuracyAtThreshold: sub.length ? sub.filter((r) => r.label === 1).length / sub.length : null, latest: cfg ? latestThreshold(k, g.version, g.model) ?? null : null, misses };
  });
  return {
    configured: !!cfg,
    model: cfg?.model ?? null,
    pin: cfg?.pin ?? null,
    rootConnection: key ? "present" : "missing",
    breaker: breakerState(),
    stats: callStats(since),
    undescribed: undescribedPlatforms([...(d.One.connections ?? []), ...(d["Studio"].connections ?? []), ...(d.root.connections ?? [])]),
    gates,
    questions: Object.fromEntries(QUESTIONS.map((q) => [q, questionText(q)])),
    backfill: backfillStatus(),
  };
}
