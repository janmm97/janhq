import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useJudgeConfig } from "./fixtures/judge";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-judge-tune-"));
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
process.env.JOS_HQ_JOS_ROOT = path.join(tmp, "JOS");

describe("tuner", () => {
  it("wilson lower bound (one-sided 90%)", async () => {
    const { wilsonLower } = await import("@/lib/server/judge/tuner");
    expect(wilsonLower(30, 30)).toBeCloseTo(0.948, 2);
    expect(wilsonLower(0, 0)).toBe(0);
  });
  it("needs 30 cases and picks the lowest threshold that meets the target", async () => {
    const { tune } = await import("@/lib/server/judge/tuner");
    const rows = [...Array.from({ length: 40 }, () => ({ score: 0.95, label: 1 as const })), ...Array.from({ length: 20 }, () => ({ score: 0.6, label: 0 as const }))];
    expect(tune(rows.slice(0, 20), 0.9)).toBeNull();
    const t = tune(rows, 0.9)!;
    expect(t.threshold).toBeGreaterThan(0.6);
    expect(t.threshold).toBeLessThanOrEqual(0.95);
    expect(t.n).toBe(40);
  });
  it("auto gate goes live after retune and falls back to shadow when accuracy drops", async () => {
    useJudgeConfig(tmp, { "understand.uses": { mode: "auto" } });
    const { recordJudgment, setLabel } = await import("@/lib/server/judge/records");
    const { retune } = await import("@/lib/server/judge/tuner");
    const { gate } = await import("@/lib/server/judge/gates");
    const g0 = gate("understand.uses");
    expect(g0.live).toBe(false);
    for (let i = 0; i < 40; i++) {
      const id = recordJudgment({ callId: null, taskId: `t${i}`, gate: "understand.uses", version: g0.version, model: "jev-1.13.0", subject: "exa", predicted: "add", score: 0.97, answer: null, acted: false, fallbackReason: null });
      setLabel(id, 1, "test");
    }
    expect(retune("understand.uses")?.mode).toBe("live");
    expect(gate("understand.uses")).toMatchObject({ live: true });
    for (let i = 0; i < 30; i++) {
      const id = recordJudgment({ callId: null, taskId: `u${i}`, gate: "understand.uses", version: g0.version, model: "jev-1.13.0", subject: "exa", predicted: "add", score: 0.97, answer: null, acted: true, fallbackReason: null });
      setLabel(id, 0, "test");
    }
    expect(retune("understand.uses")?.mode).toBe("shadow");
    expect(gate("understand.uses").live).toBe(false);
    // Regression: retune with no new labels should stay in shadow, not flap back to live
    expect(retune("understand.uses")?.mode).toBe("shadow");
    expect(gate("understand.uses").live).toBe(false);
  });
  it("live mode uses the configured threshold; off is never live", async () => {
    useJudgeConfig(tmp, { "understand.mail_role": { mode: "live", threshold: 0.9 } });
    const { gate } = await import("@/lib/server/judge/gates");
    expect(gate("understand.mail_role")).toMatchObject({ live: true, threshold: 0.9 });
    expect(gate("fastpath")).toMatchObject({ live: false, mode: "off" });
  });
  it("a gate the config sets live is reverted by the tuner when its recent accuracy falls, and stays reverted", async () => {
    useJudgeConfig(tmp, { "repeat.same_as": { mode: "live", threshold: 0.9 } });
    const { recordJudgment, setLabel, latestThreshold } = await import("@/lib/server/judge/records");
    const { retune } = await import("@/lib/server/judge/tuner");
    const { gate, CONFIGURED_LIVE } = await import("@/lib/server/judge/gates");
    const g0 = gate("repeat.same_as");
    expect(g0).toMatchObject({ live: true, threshold: 0.9 });
    // The first live sighting is recorded as the baseline for this question version.
    expect(latestThreshold("repeat.same_as", g0.version, "jev-1.13.0")).toMatchObject({ mode: "live", threshold: 0.9, reason: CONFIGURED_LIVE });
    // Good labels do not move the operator's threshold.
    for (let i = 0; i < 40; i++) setLabel(recordJudgment({ callId: null, taskId: `r${i}`, gate: "repeat.same_as", version: g0.version, model: "jev-1.13.0", subject: "x", predicted: "same", score: 0.99, answer: null, acted: true, fallbackReason: null }), 1, "test");
    expect(retune("repeat.same_as")).toMatchObject({ mode: "live", reason: CONFIGURED_LIVE });
    expect(gate("repeat.same_as")).toMatchObject({ live: true, threshold: 0.9 });
    for (let i = 0; i < 30; i++) setLabel(recordJudgment({ callId: null, taskId: `rb${i}`, gate: "repeat.same_as", version: g0.version, model: "jev-1.13.0", subject: "x", predicted: "same", score: 0.99, answer: null, acted: true, fallbackReason: null }), 0, "test");
    expect(retune("repeat.same_as")?.mode).toBe("shadow");
    const g1 = gate("repeat.same_as");
    expect(g1.live).toBe(false);
    expect(g1.held).toMatch(/reverted/);
    expect(retune("repeat.same_as")?.mode).toBe("shadow");
    expect(gate("repeat.same_as").live).toBe(false);
    // Runtime Health names the reverted gate.
    const { jevHealth } = await import("@/lib/server/health");
    const hc = jevHealth(null, null, null)!;
    expect(hc.status).toBe("warn");
    expect(hc.detail).toMatch(/reverted to shadow by the tuner: repeat\.same_as \(recent accuracy/);
  });
  it("a gate the config sets live is held in shadow after its question is reworded", async () => {
    useJudgeConfig(tmp, { "trim.connection": { mode: "live", threshold: 0.8 } });
    const { saveThreshold, latestThreshold } = await import("@/lib/server/judge/records");
    const { gate, CONFIGURED_LIVE } = await import("@/lib/server/judge/gates");
    const { gateVersion } = await import("@/lib/server/judge/questions");
    const v = gateVersion("trim.connection");
    // It went live at an older wording; nothing recorded for the current one.
    saveThreshold({ gate: "trim.connection", version: v - 1, model: "jev-1.13.0", mode: "live", threshold: 0.8, n: 0, accuracy: null, lower_bound: null, reason: CONFIGURED_LIVE });
    const g = gate("trim.connection");
    expect(g.live).toBe(false);
    expect(g.held).toMatch(/reworded/);
    expect(latestThreshold("trim.connection", v, "jev-1.13.0")).toBeUndefined();
  });
  it("revert stays in shadow on consecutive retune with no new evidence", async () => {
    useJudgeConfig(tmp, { "understand.uses": { mode: "auto" } });
    const { recordJudgment, setLabel } = await import("@/lib/server/judge/records");
    const { retune } = await import("@/lib/server/judge/tuner");
    const { gate } = await import("@/lib/server/judge/gates");
    const { tx } = await import("@/lib/server/db");
    const g0 = gate("understand.uses");
    // Insert 1000 good records at high score - tune will find a live threshold
    tx(() => {
      for (let i = 0; i < 1000; i++) {
        const id = recordJudgment({ callId: null, taskId: `good${i}`, gate: "understand.uses", version: g0.version, model: "jev-1.13.0", subject: "exa", predicted: "add", score: 0.99, answer: null, acted: false, fallbackReason: null });
        setLabel(id, 1, "test");
      }
    });
    const r1 = retune("understand.uses");
    expect(r1?.mode).toBe("live");
    expect(gate("understand.uses").live).toBe(true);
    // Insert 30 bad records at the same score - recent accuracy check triggers revert to shadow
    tx(() => {
      for (let i = 0; i < 30; i++) {
        const id = recordJudgment({ callId: null, taskId: `bad${i}`, gate: "understand.uses", version: g0.version, model: "jev-1.13.0", subject: "exa", predicted: "add", score: 0.99, answer: null, acted: false, fallbackReason: null });
        setLabel(id, 0, "test");
      }
    });
    const r2 = retune("understand.uses");
    expect(r2?.mode).toBe("shadow");
    expect(gate("understand.uses").live).toBe(false);
    // 3rd call: no new labels. Without the fix, tune() with full history (1000+30 good+bad at 0.99)
    // would find threshold 0.99 at ~97% accuracy (> 0.9 target) and promote back to live.
    // With the fix, recentAccuracy at that threshold returns 0/30 (last 30 are bad), < 0.9 target, so stays shadow.
    const r3 = retune("understand.uses");
    expect(r3?.mode).toBe("shadow");
    expect(gate("understand.uses").live).toBe(false);
    // 4th call: still no new labels, should stay shadow
    const r4 = retune("understand.uses");
    expect(r4?.mode).toBe("shadow");
    expect(gate("understand.uses").live).toBe(false);
  });
});
