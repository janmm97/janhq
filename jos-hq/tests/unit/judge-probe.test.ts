import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-judge-probe-"));
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
process.env.JOS_HQ_JOS_ROOT = path.join(tmp, "JOS");

const h = vi.hoisted(() => ({ questions: {} as Record<string, { type: string }>, answers: {} as Record<string, unknown> }));
vi.mock("@/lib/server/judge/client", () => ({
  systemOne: vi.fn(async (o: { questions: Record<string, { type: string }> }) => {
    h.questions = o.questions;
    return { ok: true, model: "jev-1.13.0", answers: h.answers, callId: 1 };
  }),
  breakerState: () => ({ open: false, until: null, failures: 0 }),
  rootJevKey: async () => null,
}));

const noul = { type: "noul", noul: 0.98 };
const pick = { type: "choice", choice: "blue", probabilities: { blue: 0.97, red: 0.01, other: 0.02 }, confidence: 0.96 };
const level = (probabilities: Record<string, number>, score: number) => ({ type: "score", score, probabilities, confidence: 0.9 });

describe("jos judge probe", () => {
  it("asks a noul, a 3-level score and a choice question, and reports the formats", async () => {
    h.answers = { blue: noul, level: level({ "0": 0.02, "1": 0.08, "2": 0.9 }, 1.9), pick };
    const { probe } = await import("@/lib/server/judge/view");
    const r = await probe();
    expect(Object.fromEntries(Object.entries(h.questions).map(([k, q]) => [k, q.type]))).toEqual({ blue: "noul", level: "score", pick: "choice" });
    expect(r).toMatchObject({ ok: true, model: "jev-1.13.0", error: null, formats: { scoreKeys: ["0", "1", "2"], scoreRange: [0, 2], choiceOk: true } });
  });
  it("fails when score probabilities are not keyed 0..2", async () => {
    h.answers = { blue: noul, level: level({ "1": 0.1, "2": 0.1, "3": 0.8 }, 2.7), pick };
    const { probe } = await import("@/lib/server/judge/view");
    const r = await probe();
    expect(r.ok).toBe(false);
    expect(r.formats).toMatchObject({ scoreKeys: ["1", "2", "3"], scoreRange: [1, 3] });
    expect(r.error).toMatch(/keyed 1, 2, 3, expected 0, 1, 2/);
    expect(r.error).toMatch(/score 2.7 is outside 0..2/);
  });
  it("fails when the score is outside 0..2 or the choice is not an offered key", async () => {
    h.answers = { blue: noul, level: level({ "0": 0.1, "1": 0.1, "2": 0.8 }, 80), pick: { ...pick, choice: "BLUE", probabilities: { BLUE: 1 } } };
    const { probe } = await import("@/lib/server/judge/view");
    const r = await probe();
    expect(r.ok).toBe(false);
    expect(r.formats).toMatchObject({ scoreRange: [0, 2], choiceOk: false });
    expect(r.error).toMatch(/score 80 is outside/);
    expect(r.error).toMatch(/did not pick one of the offered keys/);
  });
});
