import { loadConfig } from "../env";
import type { GateKey, JudgeConfig, Mode } from "./types";

export const GATES: GateKey[] = ["understand.uses", "understand.mail_role", "fastpath", "repeat.same_as", "trim.connection"];

/** Accuracy each gate must reach before it acts (spec 7.2). trim.connection is measured on its drops. */
export const TARGETS: Record<GateKey, number> = {
  "understand.uses": 0.9,
  "understand.mail_role": 0.95,
  fastpath: 0.97,
  "repeat.same_as": 0.97,
  "trim.connection": 0.98,
};

/** Used by `live` without a configured threshold, and to record what `shadow` would have done. */
export const DEFAULT_THRESHOLD: Record<GateKey, number> = {
  "understand.uses": 0.8,
  "understand.mail_role": 0.9,
  fastpath: 0.9,
  "repeat.same_as": 0.9,
  "trim.connection": 0.8,
};

export function judgeConfig(): JudgeConfig | null {
  return loadConfig().judge ?? null;
}

export function gateMode(key: GateKey): Mode {
  return judgeConfig()?.decisions[key]?.mode ?? "off";
}

/** True when any gate is on (shadow counts: it calls and records). */
export function judgeEnabled(): boolean {
  return !!judgeConfig() && GATES.some((k) => gateMode(k) !== "off");
}
