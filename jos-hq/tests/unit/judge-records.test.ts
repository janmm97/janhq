import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-judge-rec-"));
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
process.env.JOS_HQ_JOS_ROOT = path.join(tmp, "JOS");

describe("judge records", () => {
  it("records a call and judgments, labels them, and reads labelled rows back per gate/version/model", async () => {
    const r = await import("@/lib/server/judge/records");
    const call = r.recordCall({ taskId: "jos_1", decision: "understand", model: "jev-1.13.0", inputTokens: 900, durationMs: 120, ok: true, error: null });
    const a = r.recordJudgment({ callId: call, taskId: "jos_1", gate: "understand.uses", version: 1, model: "jev-1.13.0", subject: "exa", predicted: "add", score: 0.97, answer: { noul: 0.97 }, acted: false, fallbackReason: null });
    r.recordJudgment({ callId: call, taskId: "jos_1", gate: "understand.uses", version: 2, model: "jev-1.13.0", subject: "exa", predicted: "add", score: 0.9, answer: null, acted: false, fallbackReason: null });
    r.markActed(a, true);
    r.setLabel(a, 1, "connection_usage");
    expect(r.labelled("understand.uses", 1, "jev-1.13.0")).toEqual([expect.objectContaining({ score: 0.97, label: 1 })]);
    expect(r.labelled("understand.uses", 2, "jev-1.13.0")).toEqual([]);
    expect(r.taskRecords("jos_1").find((x) => x.id === a)).toMatchObject({ acted: 1, label: 1 });
  });
  it("never tunes understand.uses on rows from before disagreement-only recording", async () => {
    const r = await import("@/lib/server/judge/records");
    for (const predicted of ["used", "not_used", "remove"]) {
      const id = r.recordJudgment({ callId: null, taskId: "jos_legacy", gate: "understand.uses", version: 7, model: "jev-1.13.0", subject: "gmail", predicted, score: 0.96, answer: null, acted: false, fallbackReason: null });
      r.setLabel(id, 1, "connection_usage");
    }
    expect(r.labelled("understand.uses", 7, "jev-1.13.0")).toHaveLength(1);
  });
  it("keeps threshold history and returns the latest", async () => {
    const r = await import("@/lib/server/judge/records");
    r.saveThreshold({ gate: "fastpath", version: 3, model: "jev-1.13.0", mode: "shadow", threshold: null, n: 10, accuracy: null, lower_bound: null, reason: "n < 30" });
    r.saveThreshold({ gate: "fastpath", version: 3, model: "jev-1.13.0", mode: "live", threshold: 0.91, n: 40, accuracy: 1, lower_bound: 0.96, reason: "tuned" });
    expect(r.latestThreshold("fastpath", 3, "jev-1.13.0")).toMatchObject({ mode: "live", threshold: 0.91 });
  });
});
