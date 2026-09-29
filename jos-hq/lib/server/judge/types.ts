// Types for HQ's TypeSafe judgment layer (Tasks/TypeSafe-Judgment-Spec-2026-09-29.md). Question and
// answer shapes are TypeSafe's /v1/systemone contract, read from docs.typesafe.ai on 2026-09-29.
export type Entry = string | Record<string, unknown> | unknown[] | null;
export interface NoulCriteria { true: string; false: string }
export type Question =
  | { type: "noul"; instructions: Entry; criteria?: NoulCriteria }
  | { type: "choice"; instructions: Entry; criteria: Record<string, Entry> }
  | { type: "score"; instructions: Entry; criteria: Entry[] };

export interface NoulAnswer { type: "noul"; noul: number }
export interface ChoiceAnswer { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
export interface ScoreAnswer { type: "score"; score: number; probabilities: Record<string, number>; confidence: number; legend?: Record<string, string> }
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type GateKey = "understand.uses" | "understand.mail_role" | "fastpath" | "repeat.same_as" | "trim.connection";
export type QuestionKey = "understand.uses" | "understand.mail_role" | "understand.complexity" | "understand.side_effects" | "trim.connection" | "repeat.same_as";
export type Mode = "off" | "shadow" | "auto" | "live";

export interface JudgeConfig {
  /** Sent as `model`. */
  model: string;
  /** Expected in the response's `model`; a different value fails the call (thresholds are per version). */
  pin: string;
  scrub: boolean;
  timeoutMs: number;
  decisions: Partial<Record<GateKey, { mode: Mode; threshold?: number }>>;
}
