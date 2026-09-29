// Whether a gate acts now. live: the configured threshold, for the question version it was first seen
// live at, until the tuner reverts it. auto: the tuner's latest live threshold for this question version
// and pinned model. shadow and off never act (shadow still records).
import { DEFAULT_THRESHOLD, gateMode, judgeConfig } from "./config";
import { gateVersion } from "./questions";
import { get } from "../db";
import { latestThreshold, saveThreshold } from "./records";
import type { GateKey, Mode } from "./types";

export interface Gate {
  key: GateKey;
  mode: Mode;
  version: number;
  model: string;
  threshold: number | null;
  live: boolean;
  /** Why a gate configured live is not acting (a revert, or a reworded question). */
  held?: string;
}

/** The reason on the baseline row gate() writes the first time it sees a gate configured live. */
export const CONFIGURED_LIVE = "configured live";

export function gate(key: GateKey): Gate {
  const cfg = judgeConfig();
  const mode = gateMode(key);
  const model = cfg?.pin ?? "";
  if (!cfg || mode === "off") return { key, mode: "off", version: 0, model, threshold: null, live: false };
  const version = gateVersion(key);
  const configured = cfg.decisions[key]?.threshold ?? DEFAULT_THRESHOLD[key];
  if (mode === "live") {
    const row = latestThreshold(key, version, model);
    if (row?.mode === "shadow") return { key, mode, version, model, threshold: configured, live: false, held: `reverted: ${row.reason ?? "accuracy fell below target"}` };
    if (row?.mode === "live") return { key, mode, version, model, threshold: row.reason === CONFIGURED_LIVE ? configured : (row.threshold ?? configured), live: true };
    // No row for this version. A row for an older version means the question was reworded after it
    // went live: the new wording starts in shadow until the tuner promotes it.
    const older = get<{ x: number }>("SELECT 1 AS x FROM judge_thresholds WHERE gate = ? AND model = ? AND version < ? LIMIT 1", [key, model, version]);
    if (older) return { key, mode, version, model, threshold: configured, live: false, held: `question reworded (version ${version}): shadow until the tuner promotes it` };
    saveThreshold({ gate: key, version, model, mode: "live", threshold: configured, n: 0, accuracy: null, lower_bound: null, reason: CONFIGURED_LIVE });
    return { key, mode, version, model, threshold: configured, live: true };
  }
  if (mode === "auto") {
    const row = latestThreshold(key, version, model);
    if (row?.mode === "live" && row.threshold !== null) return { key, mode, version, model, threshold: row.threshold, live: true };
  }
  return { key, mode, version, model, threshold: configured, live: false };
}
