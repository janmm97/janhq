// Learning from HQ's history (spec 7.2): the lowest threshold whose accuracy, over labelled records
// scoring at or above it, has a Wilson lower bound at or above the gate's target, with at least 30
// cases. One-sided 90% (z = 1.2816): every decision fails safe, and z = 1.96 would need 124 perfect
// cases before a 97% gate could act at HQ's volume.
import { gateMode, judgeConfig, TARGETS } from "./config";
import { gateVersion } from "./questions";
import { labelled, latestThreshold, saveThreshold, type ThresholdRow } from "./records";
import type { GateKey } from "./types";

export const Z = 1.2816;
export const MIN_N = 30;

export function wilsonLower(k: number, n: number, z = Z): number {
  if (n <= 0) return 0;
  const p = k / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

export function tune(rows: Array<{ score: number; label: 0 | 1 }>, target: number): { threshold: number; n: number; accuracy: number; lower: number } | null {
  for (let i = 50; i <= 99; i++) {
    const t = i / 100;
    const sub = rows.filter((r) => r.score >= t);
    if (sub.length < MIN_N) return null; // higher thresholds only shrink the subset
    const k = sub.filter((r) => r.label === 1).length;
    const lower = wilsonLower(k, sub.length);
    if (lower >= target) return { threshold: t, n: sub.length, accuracy: k / sub.length, lower };
  }
  return null;
}

/** Accuracy over the newest `last` labelled records at or above `threshold`. */
export function recentAccuracy(rows: Array<{ score: number; label: 0 | 1 }>, threshold: number, last = 30): { n: number; accuracy: number } {
  const sub = rows.filter((r) => r.score >= threshold).slice(-last);
  return { n: sub.length, accuracy: sub.length ? sub.filter((r) => r.label === 1).length / sub.length : 0 };
}

/** Re-tunes one gate from its labels and stores the result when it changes. Returns the latest row. */
export function retune(gate: GateKey): ThresholdRow | undefined {
  const cfg = judgeConfig();
  if (!cfg) return undefined;
  const version = gateVersion(gate);
  const model = cfg.pin;
  const rows = labelled(gate, version, model);
  const prev = latestThreshold(gate, version, model);
  const target = TARGETS[gate];
  if (prev?.mode === "live" && prev.threshold !== null) {
    const recent = recentAccuracy(rows, prev.threshold);
    if (recent.n >= MIN_N && recent.accuracy < target) {
      saveThreshold({ gate, version, model, mode: "shadow", threshold: null, n: recent.n, accuracy: recent.accuracy, lower_bound: null, reason: `recent accuracy ${recent.accuracy.toFixed(3)} fell below target ${target}` });
      return latestThreshold(gate, version, model);
    }
    // A gate the config sets live keeps the operator's threshold while it holds up; the tuner only
    // reverts it. After a revert (or a reworded question) the code below may promote it again.
    if (gateMode(gate) === "live") return prev;
  }
  const t = tune(rows, target);
  if (t) {
    // Before promoting to live, verify the recent window also meets target
    const recent = recentAccuracy(rows, t.threshold);
    if (recent.n >= MIN_N && recent.accuracy < target) {
      // Recent accuracy is too low - don't promote to live
      // If prev was live at a different threshold, revert to shadow
      if (prev?.mode === "live" && prev.threshold !== t.threshold) {
        saveThreshold({ gate, version, model, mode: "shadow", threshold: null, n: recent.n, accuracy: recent.accuracy, lower_bound: null, reason: `recent accuracy ${recent.accuracy.toFixed(3)} fell below target ${target} at tuned threshold ${t.threshold}` });
      }
    } else if (!(prev?.mode === "live" && prev.threshold === t.threshold)) {
      // Recent accuracy is good - promote to live
      saveThreshold({ gate, version, model, mode: "live", threshold: t.threshold, n: t.n, accuracy: t.accuracy, lower_bound: t.lower, reason: "tuned" });
    }
  } else if (!t && prev?.mode === "live") {
    saveThreshold({ gate, version, model, mode: "shadow", threshold: null, n: rows.length, accuracy: null, lower_bound: null, reason: "no threshold meets the target" });
  }
  return latestThreshold(gate, version, model);
}
