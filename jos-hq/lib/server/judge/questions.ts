// Question wording lives in reference/judge-questions.json so the Tuning page can reword it. Each
// save bumps the question's version; thresholds are tuned per version, so a reworded question starts
// in shadow again.
import fs from "node:fs";
import path from "node:path";
import { hqRoot } from "../env";
import type { Entry, GateKey, QuestionKey } from "./types";

export interface QuestionText {
  version: number;
  instructions: string;
  criteria: Entry | Record<string, Entry> | Entry[];
}

function file(): string {
  return path.join(hqRoot(), "reference", "judge-questions.json");
}

function readAll(): Record<QuestionKey, QuestionText> {
  return JSON.parse(fs.readFileSync(file(), "utf8")) as Record<QuestionKey, QuestionText>;
}

export function questionText(key: QuestionKey): QuestionText {
  const q = readAll()[key];
  if (!q) throw new Error(`judge question ${key} is missing from reference/judge-questions.json`);
  return q;
}

/** Replaces {name} placeholders. Unknown placeholders are left as they are. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([a-z_]+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** A question's criteria shape, keyed by its answer kind (client.ts's `Question["type"]`). */
const KIND: Record<QuestionKey, "noul" | "choice" | "score"> = {
  "understand.uses": "noul",
  "understand.mail_role": "choice",
  "understand.complexity": "score",
  "understand.side_effects": "noul",
  "trim.connection": "noul",
  "repeat.same_as": "noul",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validates a reworded question's `criteria` against its answer kind, before it can ever reach a live
 * call or a stored answer. Returns null when valid, or a human-readable reason when not:
 * - noul (understand.uses, understand.side_effects, trim.connection, repeat.same_as): an object with
 *   non-empty string `true` and `false`.
 * - choice (understand.mail_role): a non-empty object whose values are strings or null, keeping an
 *   `other` key (client.ts's `ans.choice in crit` and Jev's own fallback both depend on it).
 * - score (understand.complexity): an array of 2-10 non-empty strings.
 */
export function validateCriteria(key: QuestionKey, criteria: unknown): string | null {
  const kind = KIND[key];
  if (kind === "noul") {
    if (!isPlainObject(criteria)) return "criteria must be an object with true and false";
    const { true: t, false: f } = criteria as { true?: unknown; false?: unknown };
    if (typeof t !== "string" || !t.trim() || typeof f !== "string" || !f.trim()) return "criteria must have non-empty string true and false";
    return null;
  }
  if (kind === "choice") {
    if (!isPlainObject(criteria)) return "criteria must be a non-empty object of string (or null) values";
    const entries = Object.entries(criteria);
    if (!entries.length) return "criteria must be a non-empty object";
    if (!("other" in criteria)) return 'criteria must keep an "other" key';
    for (const [k, v] of entries) {
      if (v !== null && typeof v !== "string") return `criteria.${k} must be a string or null`;
    }
    return null;
  }
  // score
  if (!Array.isArray(criteria)) return "criteria must be an array of 2-10 non-empty strings";
  if (criteria.length < 2 || criteria.length > 10) return "criteria must have between 2 and 10 entries";
  for (const v of criteria) if (typeof v !== "string" || !v.trim()) return "criteria entries must be non-empty strings";
  return null;
}

/** Placeholders a templated question must keep: HQ fills them per platform, connection or candidate. */
export const PLACEHOLDERS: Partial<Record<QuestionKey, string[]>> = {
  "understand.uses": ["{platform}", "{purpose}"],
  "trim.connection": ["{name}"],
  "repeat.same_as": ["{i}"],
};
export const MAX_INSTRUCTIONS = 1000;

/** Validates a Tuning-page save before anything is written. Null when valid, else the reason. */
export function validateQuestionPatch(key: QuestionKey, patch: { instructions?: unknown; criteria?: unknown }): string | null {
  if (patch.instructions === undefined && patch.criteria === undefined) return "nothing to save: give instructions or criteria";
  if (patch.instructions !== undefined) {
    if (typeof patch.instructions !== "string" || !patch.instructions.trim()) return "instructions must be text";
    if (patch.instructions.length > MAX_INSTRUCTIONS) return `instructions must be at most ${MAX_INSTRUCTIONS} characters`;
    const missing = (PLACEHOLDERS[key] ?? []).filter((ph) => !(patch.instructions as string).includes(ph));
    if (missing.length) return `instructions must keep ${missing.join(" and ")}`;
  }
  if (patch.criteria !== undefined) return validateCriteria(key, patch.criteria);
  return null;
}

export function saveQuestionText(key: QuestionKey, patch: { instructions?: string; criteria?: QuestionText["criteria"] }): QuestionText {
  const all = readAll();
  const cur = all[key];
  if (!cur) throw new Error(`unknown judge question ${key}`);
  const err = validateQuestionPatch(key, patch);
  if (err) throw new Error(err);
  const next: QuestionText = { version: cur.version + 1, instructions: patch.instructions ?? cur.instructions, criteria: patch.criteria ?? cur.criteria };
  all[key] = next;
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
  fs.renameSync(tmp, file());
  return next;
}

/** The version a gate's thresholds are tuned against. fastpath depends on three D1 questions. */
export function gateVersion(gate: GateKey): number {
  if (gate === "fastpath") return questionText("understand.uses").version + questionText("understand.complexity").version + questionText("understand.side_effects").version;
  return questionText(gate).version;
}
