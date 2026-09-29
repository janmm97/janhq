import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useJudgeConfig } from "./fixtures/judge";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-judge-rep-"));
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
process.env.JOS_HQ_JOS_ROOT = path.join(tmp, "JOS");
vi.mock("@/lib/server/judge/client", () => ({
  systemOne: vi.fn(async (o: { questions: Record<string, unknown> }) => ({ ok: true, model: "jev-1.13.0", callId: 1, answers: Object.fromEntries(Object.keys(o.questions).map((k, i) => [k, { type: "noul", noul: i === 0 ? 0.95 : 0.2 }])) })),
}));
const m = (i: number, status: string, date: string) => ({ entry: { file: "x", index: i, date, title: `t${i}`, taskId: `jos_${i}`, status, asked: `asked ${i}`, outcome: "", artifacts: "", learned: "" }, score: 0.5 });

describe("D3 repeat", () => {
  it("scores each candidate and records it", async () => {
    useJudgeConfig(tmp, { "repeat.same_as": { mode: "shadow" } });
    const { judgeRepeat } = await import("@/lib/server/judge/repeat");
    const r = (await judgeRepeat({ taskId: "rep1", request: "find it", candidates: [m(0, "done", "2026-09-28"), m(1, "blocked", "2026-09-27")] }))!;
    expect(r.scores).toEqual([0.95, 0.2]);
    const { taskRecords } = await import("@/lib/server/judge/records");
    expect(taskRecords("rep1").map((x) => x.subject)).toEqual(["jos_0", "jos_1"]);
  });
  it("reuses the newest done candidate above threshold; lessons from unfinished ones above 0.5", async () => {
    const { pickRepeat } = await import("@/lib/server/judge/repeat");
    const cands = [m(0, "done", "2026-09-20"), m(1, "done", "2026-09-28"), m(2, "blocked", "2026-09-27")];
    expect(pickRepeat(cands, [0.95, 0.93, 0.7], 0.9)).toMatchObject({ reuse: cands[1], reuseIndex: 1, lessons: [cands[2]] });
    expect(pickRepeat(cands, [0.5, 0.4, 0.3], 0.9)).toMatchObject({ reuse: null, lessons: [] });
  });
  it("breaks a same-date tie across different log files the same way the lexical log check would", async () => {
    const { pickRepeat } = await import("@/lib/server/judge/repeat");
    const { newer } = await import("@/lib/server/memory");
    // Same date, different files: `index` is only a per-file position (memory.ts's own `newer` only
    // uses it when both entries share a file), so this must not be decided by comparing 5 to 0.
    const a = { entry: { file: "A", index: 5, date: "2026-09-28", title: "a", taskId: "jos_a", status: "done", asked: "asked a", outcome: "", artifacts: "", learned: "" }, score: 0.5 };
    const b = { entry: { file: "B", index: 0, date: "2026-09-28", title: "b", taskId: "jos_b", status: "done", asked: "asked b", outcome: "", artifacts: "", learned: "" }, score: 0.5 };
    const cands = [a, b];
    const scores = [0.95, 0.95];
    const expected = [...cands].sort((x, y) => newer(x.entry, y.entry))[0];
    const r1 = pickRepeat(cands, scores, 0.9);
    expect(r1.reuse).toBe(expected);
    // Stable: repeating the call picks the same candidate again.
    const r2 = pickRepeat(cands, scores, 0.9);
    expect(r2.reuse).toBe(expected);
  });
});
