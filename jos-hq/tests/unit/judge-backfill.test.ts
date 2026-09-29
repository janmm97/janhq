import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useJudgeConfig } from "./fixtures/judge";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-judge-bf-"));
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
process.env.JOS_HQ_JOS_ROOT = path.join(tmp, "JOS");
fs.mkdirSync(path.join(tmp, "JOS"), { recursive: true });
const h = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/server/one/discovery", async (orig) => ({ ...(await orig<typeof import("@/lib/server/one/discovery")>()), listConnections: vi.fn(async () => ({ connections: [{ platform: "exa", name: "Main Exa", key: "live::exa::k", state: "operational", access: null }], error: null })) }));
vi.mock("@/lib/server/judge/client", () => ({
  systemOne: vi.fn(async (o: { state?: { request?: string }; questions: Record<string, { type: string }> }) => {
    h.calls++;
    // One request triggers a throw so a test can prove backfill isolates a single task's failure
    // instead of aborting the whole run.
    if (o.state?.request === "THROW ME") throw new Error("boom (systemOne)");
    const answers: Record<string, unknown> = {};
    for (const [k, q] of Object.entries(o.questions)) answers[k] = q.type === "noul" ? { type: "noul", noul: 0.9 } : q.type === "choice" ? { type: "choice", choice: "no_mail", probabilities: {}, confidence: 0.9 } : { type: "score", score: 0, probabilities: { "0": 1 }, confidence: 1 };
    return { ok: true, model: "jev-1.13.0", answers, callId: 1 };
  }),
}));

describe("backfill", () => {
  it("replays finished tasks once each, in shadow, and labels them", async () => {
    useJudgeConfig(tmp, { "understand.uses": { mode: "auto" }, "understand.mail_role": { mode: "live", threshold: 0.9 }, fastpath: { mode: "auto" }, "repeat.same_as": { mode: "auto" }, "trim.connection": { mode: "auto" } });
    const { run } = await import("@/lib/server/db");
    const now = new Date().toISOString();
    for (const id of ["B1", "B2"]) run("INSERT INTO tasks(id, chat_id, origin, title, request, mode, route_selection, route, status, stage, verification, context_json, created_at, updated_at) VALUES (?, NULL, 'chat', 't', 'find x on the web', 'auto', 'auto', 'One', 'completed', 'respond', 'verified', '{\"clarifications\":[]}', ?, ?)", [id, now, now]);
    const { backfill } = await import("@/lib/server/judge/backfill");
    const s1 = await backfill();
    expect(s1).toMatchObject({ state: "done", tasks: 2 });
    const first = h.calls;
    const s2 = await backfill();
    expect(s2.tasks).toBe(0);
    expect(h.calls).toBe(first);
    const { taskRecords } = await import("@/lib/server/judge/records");
    expect(taskRecords("B1").every((r) => r.acted === 0)).toBe(true);
  });

  it("isolates a per-task failure: the other task is still processed and the run still ends done", async () => {
    // A fresh data dir: the first test's tasks (B1, B2) already carry judge_records and would show up
    // as additional "already replayed" skips here, which would make this test couple to the other
    // one's state instead of testing isolation on its own.
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-judge-bf2-"));
    const prevDataDir = process.env.JOS_HQ_DATA_DIR;
    process.env.JOS_HQ_DATA_DIR = path.join(tmp2, "data");
    try {
      useJudgeConfig(tmp2, { "understand.uses": { mode: "auto" }, "understand.mail_role": { mode: "live", threshold: 0.9 }, fastpath: { mode: "auto" }, "repeat.same_as": { mode: "auto" }, "trim.connection": { mode: "auto" } });
      const { run } = await import("@/lib/server/db");
      const now = new Date().toISOString();
      run("INSERT INTO tasks(id, chat_id, origin, title, request, mode, route_selection, route, status, stage, verification, context_json, created_at, updated_at) VALUES (?, NULL, 'chat', 't', 'THROW ME', 'auto', 'auto', 'One', 'completed', 'respond', 'verified', '{\"clarifications\":[]}', ?, ?)", ["T1", now, now]);
      run("INSERT INTO tasks(id, chat_id, origin, title, request, mode, route_selection, route, status, stage, verification, context_json, created_at, updated_at) VALUES (?, NULL, 'chat', 't', 'find y on the web', 'auto', 'auto', 'One', 'completed', 'respond', 'verified', '{\"clarifications\":[]}', ?, ?)", ["T2", now, now]);
      const { backfill } = await import("@/lib/server/judge/backfill");
      const s = await backfill();
      expect(s.state).toBe("done");
      expect(s.skipped).toBe(1);
      expect(s.tasks).toBe(1);
      expect(s.error).toMatch(/boom/);
    } finally {
      process.env.JOS_HQ_DATA_DIR = prevDataDir;
    }
  });
});
