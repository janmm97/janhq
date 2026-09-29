import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useJudgeConfig } from "./fixtures/judge";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-judge-fp-"));
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
process.env.JOS_HQ_JOS_ROOT = path.join(tmp, "JOS");
const c = (platform: string, name: string) => ({ platform, name, key: `live::${platform}::default::${name.replace(/\W/g, "")}`, state: "operational", access: null });
const u = (over: Record<string, unknown> = {}) => ({ model: "jev-1.13.0", platforms: { exa: 0.97, gmail: 0.04 }, mailRole: { choice: "find_address", confidence: 0.93 }, complexity: { score: 0.1, confidence: 0.9, single: 0.92 }, sideEffects: 0.03, relevance: {}, recordIds: { uses: {}, mailRole: null, trim: {} }, ...over });

describe("fast path candidate", () => {
  it("picks the single connection of the single needed platform", async () => {
    const { fastPathCandidate } = await import("@/lib/server/judge/fastpath");
    const p = fastPathCandidate(u() as never, { request: "find x", conns: [c("exa", "Main Exa"), c("gmail", "Main Riley")], usesThreshold: 0.8 });
    expect(p?.connection.name).toBe("Main Exa");
    expect(p!.score).toBeCloseTo(0.92 * 0.97 * 0.97, 3);
  });
  it.each([
    ["side effects", u({ sideEffects: 0.4 })],
    ["not a single lookup", u({ complexity: { score: 1.2, confidence: 0.9, single: 0.1 } })],
    ["two platforms", u({ platforms: { exa: 0.97, tavily: 0.9 } })],
  ])("refuses when %s", async (_l, x) => {
    const { fastPathCandidate } = await import("@/lib/server/judge/fastpath");
    expect(fastPathCandidate(x as never, { request: "find x", conns: [c("exa", "Main Exa"), c("tavily", "Main Tavily")], usesThreshold: 0.8 })).toBeNull();
  });
  it("needs the connection named when the platform has several", async () => {
    const { fastPathCandidate } = await import("@/lib/server/judge/fastpath");
    const conns = [c("exa", "Main Exa"), c("exa", "Acme Exa")];
    expect(fastPathCandidate(u() as never, { request: "find x", conns, usesThreshold: 0.8 })).toBeNull();
    expect(fastPathCandidate(u() as never, { request: "Using acme exa, find x", conns, usesThreshold: 0.8 })?.connection.name).toBe("Acme Exa");
  });
  it("takes it only when the gate is live and the score clears it; records either way", async () => {
    const { decideFastPath } = await import("@/lib/server/judge/fastpath");
    const { taskRecords } = await import("@/lib/server/judge/records");
    useJudgeConfig(tmp, { fastpath: { mode: "shadow" } });
    expect(decideFastPath({ taskId: "fp1", u: u() as never, request: "find x", conns: [c("exa", "Main Exa")], excluded: null }).take).toBe(false);
    useJudgeConfig(tmp, { fastpath: { mode: "live", threshold: 0.8 } });
    expect(decideFastPath({ taskId: "fp2", u: u() as never, request: "find x", conns: [c("exa", "Main Exa")], excluded: null }).take).toBe(true);
    expect(decideFastPath({ taskId: "fp3", u: u() as never, request: "find x", conns: [c("exa", "Main Exa")], excluded: "Plan mode" }).take).toBe(false);
    expect(taskRecords("fp1")[0]).toMatchObject({ gate: "fastpath", predicted: "fast", acted: 0 });
    expect(taskRecords("fp2")[0]).toMatchObject({ acted: 1 });
  });
});
