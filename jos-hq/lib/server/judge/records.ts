// SQLite for the judgment layer: every Jev call, every answer HQ could act on, its label (what really
// happened) and every threshold the tuner set. Telemetry, not J/OS memory (CLAUDE.md §14).
import { all, get, run } from "../db";
import { nowIso } from "../util/time";
import { redactSecrets } from "../util/redact";
import type { GateKey } from "./types";

export interface NewRecord {
  callId: number | null;
  taskId: string | null;
  gate: GateKey;
  version: number;
  model: string;
  subject: string | null;
  predicted: string;
  score: number;
  answer: unknown;
  acted: boolean;
  fallbackReason: string | null;
}
export interface JudgeRecord {
  id: number;
  call_id: number | null;
  task_id: string | null;
  gate: GateKey;
  version: number;
  model: string;
  subject: string | null;
  predicted: string;
  score: number;
  acted: number;
  fallback_reason: string | null;
  label: number | null;
  label_source: string | null;
  created_at: string;
}
export interface ThresholdRow {
  id: number;
  gate: GateKey;
  version: number;
  model: string;
  mode: "live" | "shadow";
  threshold: number | null;
  n: number;
  accuracy: number | null;
  lower_bound: number | null;
  reason: string | null;
  created_at: string;
}

export function recordCall(c: { taskId: string | null; decision: string; model: string | null; inputTokens: number | null; durationMs: number; ok: boolean; error: string | null }): number {
  const r = run("INSERT INTO judge_calls(task_id, decision, model, input_tokens, duration_ms, ok, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    c.taskId, c.decision, c.model, c.inputTokens, c.durationMs, c.ok ? 1 : 0, c.error ? redactSecrets(c.error).slice(0, 500) : null, nowIso(),
  ]);
  return Number(r.lastInsertRowid);
}

export function recordJudgment(x: NewRecord): number {
  const r = run(
    "INSERT INTO judge_records(call_id, task_id, gate, version, model, subject, predicted, score, answer_json, acted, fallback_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [x.callId, x.taskId, x.gate, x.version, x.model, x.subject, x.predicted, x.score, x.answer === undefined || x.answer === null ? null : JSON.stringify(x.answer), x.acted ? 1 : 0, x.fallbackReason, nowIso()],
  );
  return Number(r.lastInsertRowid);
}

export function markActed(id: number, acted: boolean, fallbackReason: string | null = null): void {
  run("UPDATE judge_records SET acted = ?, fallback_reason = ? WHERE id = ?", [acted ? 1 : 0, fallbackReason, id]);
}

export function taskRecords(taskId: string): JudgeRecord[] {
  return all<JudgeRecord>("SELECT * FROM judge_records WHERE task_id = ? ORDER BY id", [taskId]);
}

export function setLabel(id: number, label: 0 | 1, source: string): void {
  run("UPDATE judge_records SET label = ?, label_source = ?, labeled_at = ? WHERE id = ?", [label, source, nowIso(), id]);
}

/** Labelled records a gate is tuned on. understand.uses rows from before disagreement-only recording
 * ("used"/"not_used", which pooled every easy "not used" platform) are left out. */
export function labelled(gate: GateKey, version: number, model: string): Array<{ score: number; label: 0 | 1; created_at: string }> {
  return all<{ score: number; label: 0 | 1; created_at: string }>(
    "SELECT score, label, created_at FROM judge_records WHERE gate = ? AND version = ? AND model = ? AND label IS NOT NULL AND NOT (gate = 'understand.uses' AND predicted IN ('used', 'not_used')) ORDER BY created_at, id",
    [gate, version, model],
  );
}

export function saveThreshold(t: Omit<ThresholdRow, "id" | "created_at">): void {
  run("INSERT INTO judge_thresholds(gate, version, model, mode, threshold, n, accuracy, lower_bound, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    t.gate, t.version, t.model, t.mode, t.threshold, t.n, t.accuracy, t.lower_bound, t.reason, nowIso(),
  ]);
}

export function latestThreshold(gate: GateKey, version: number, model: string): ThresholdRow | undefined {
  return get<ThresholdRow>("SELECT * FROM judge_thresholds WHERE gate = ? AND version = ? AND model = ? ORDER BY id DESC LIMIT 1", [gate, version, model]);
}

export function callStats(sinceIso: string): { calls: number; failures: number; lastModel: string | null; lastError: string | null } {
  const s = get<{ calls: number; failures: number }>("SELECT COUNT(*) AS calls, COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failures FROM judge_calls WHERE created_at >= ?", [sinceIso]) ?? { calls: 0, failures: 0 };
  const last = get<{ model: string | null }>("SELECT model FROM judge_calls WHERE ok = 1 ORDER BY id DESC LIMIT 1");
  const err = get<{ error: string | null }>("SELECT error FROM judge_calls WHERE ok = 0 ORDER BY id DESC LIMIT 1");
  return { calls: s.calls, failures: s.failures, lastModel: last?.model ?? null, lastError: err?.error ?? null };
}
