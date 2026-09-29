import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useJudgeConfig } from "./fixtures/judge";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-judge-lab-"));
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
process.env.JOS_HQ_JOS_ROOT = path.join(tmp, "JOS");
fs.mkdirSync(path.join(tmp, "JOS"), { recursive: true });

async function seedTask(id: string, over: { status: string; verification: string; planJson?: string | null; plannerModel?: string | null; context?: Record<string, unknown> }) {
  const { run } = await import("@/lib/server/db");
  const now = new Date().toISOString();
  run(
    "INSERT INTO tasks(id, chat_id, origin, title, request, mode, route_selection, route, status, stage, verification, plan_json, planner_model, context_json, created_at, updated_at) VALUES (?, NULL, 'chat', 't', 'r', 'auto', 'auto', 'One', ?, 'respond', ?, ?, ?, ?, ?, ?)",
    [id, over.status, over.verification, over.planJson ?? null, over.plannerModel ?? null, JSON.stringify({ clarifications: [], ...(over.context ?? {}) }), now, now],
  );
}
/** An executions row for the given phase; connection_usage.execution_id joins to this by default.
 * `verified` defaults to true (a successful launch) since that's what most seeded tasks need; pass
 * `verified: false` to model a launch that never verified (dispatch.ts's default before verification). */
async function seedExecution(taskId: string, phase: "plan" | "preview" | "execute", opts: { id?: string; verified?: boolean } = {}) {
  const { run } = await import("@/lib/server/db");
  const id = opts.id ?? `${taskId}-${phase}`;
  const verified = opts.verified === false ? 0 : 1;
  run(
    "INSERT INTO executions(id, task_id, phase, workspace, cwd, adapter, runtime, binary, model, effort, status, verified, created_at) VALUES (?, ?, ?, 'One', 'c', 'a', 'r', 'b', 'm', 'e', 'exited', ?, ?)",
    [id, taskId, phase, verified, new Date().toISOString()],
  );
  return id;
}
async function usage(taskId: string, platform: string, name: string, action = "a1", executionId: string = `${taskId}-execute`) {
  const { run } = await import("@/lib/server/db");
  run(
    "INSERT INTO connection_usage(task_id, execution_id, workspace, platform, connection_key, connection_name, action_id, category, decision, ok, created_at) VALUES (?, ?, 'One', ?, ?, ?, ?, 'read', 'allowed', 1, ?)",
    [taskId, executionId, platform, `live::${platform}::k`, name, action, new Date().toISOString()],
  );
}
async function approvedWrite(taskId: string, platform: string, name: string, action = "a1", executionId: string = `${taskId}-execute`) {
  const { run } = await import("@/lib/server/db");
  run(
    "INSERT INTO connection_usage(task_id, execution_id, workspace, platform, connection_key, connection_name, action_id, category, decision, ok, created_at) VALUES (?, ?, 'One', ?, ?, ?, ?, 'write', 'approved', 1, ?)",
    [taskId, executionId, platform, `live::${platform}::k`, name, action, new Date().toISOString()],
  );
}

describe("labels", () => {
  it("labels uses, mail_role, trim and fastpath from what the task really did", async () => {
    useJudgeConfig(tmp, { "understand.uses": { mode: "auto" } });
    const { recordJudgment, taskRecords } = await import("@/lib/server/judge/records");
    const { labelTask } = await import("@/lib/server/judge/labels");
    await seedTask("L1", { status: "completed", verification: "verified", plannerModel: "none (fast path: x)", context: { fastPath: null } });
    await seedExecution("L1", "execute");
    await usage("L1", "exa", "Main Exa");
    const base = { callId: null, taskId: "L1", version: 1, model: "jev-1.13.0", answer: null, acted: false, fallbackReason: null };
    recordJudgment({ ...base, gate: "understand.uses", subject: "exa", predicted: "used", score: 0.97 });
    recordJudgment({ ...base, gate: "understand.uses", subject: "gmail", predicted: "not_used", score: 0.96 });
    recordJudgment({ ...base, gate: "understand.mail_role", subject: null, predicted: "find_address", score: 0.93 });
    recordJudgment({ ...base, gate: "trim.connection", subject: "Main Stripe", predicted: "drop", score: 0.99 });
    recordJudgment({ ...base, gate: "trim.connection", subject: "Main Exa", predicted: "drop", score: 0.6 });
    recordJudgment({ ...base, gate: "fastpath", subject: "exa", predicted: "fast", score: 0.9, acted: true });
    const r = labelTask("L1");
    expect(r.labelled).toBe(6);
    const byKey = Object.fromEntries(taskRecords("L1").map((x) => [`${x.gate}:${x.subject}`, x.label]));
    expect(byKey).toEqual({ "understand.uses:exa": 1, "understand.uses:gmail": 1, "understand.mail_role:null": 1, "trim.connection:Main Stripe": 1, "trim.connection:Main Exa": 0, "fastpath:exa": 1 });
  });
  it("grades uses disagreements: an add is right iff the platform was used, a remove iff it was not", async () => {
    const { recordJudgment, taskRecords } = await import("@/lib/server/judge/records");
    const { labelTask } = await import("@/lib/server/judge/labels");
    await seedTask("AR1", { status: "completed", verification: "verified" });
    await seedExecution("AR1", "execute");
    await usage("AR1", "exa", "Main Exa");
    const base = { callId: null, taskId: "AR1", version: 1, model: "jev-1.13.0", answer: null, acted: false, fallbackReason: null };
    recordJudgment({ ...base, gate: "understand.uses", subject: "exa", predicted: "add", score: 0.97 });
    recordJudgment({ ...base, gate: "understand.uses", subject: "tavily", predicted: "add", score: 0.8 });
    recordJudgment({ ...base, gate: "understand.uses", subject: "gmail", predicted: "remove", score: 0.96 });
    recordJudgment({ ...base, gate: "understand.uses", subject: "exa", predicted: "remove", score: 0.7 });
    labelTask("AR1");
    expect(taskRecords("AR1").map((x) => [x.subject, x.predicted, x.label])).toEqual([["exa", "add", 1], ["tavily", "add", 0], ["gmail", "remove", 1], ["exa", "remove", 0]]);
  });
  it("does not label a task that never ran an executor, and never relabels", async () => {
    const { recordJudgment, taskRecords } = await import("@/lib/server/judge/records");
    const { labelTask } = await import("@/lib/server/judge/labels");
    await seedTask("L2", { status: "cancelled", verification: "none" });
    recordJudgment({ callId: null, taskId: "L2", gate: "understand.uses", version: 1, model: "jev-1.13.0", subject: "exa", predicted: "used", score: 0.9, answer: null, acted: false, fallbackReason: null });
    expect(labelTask("L2").labelled).toBe(0);
    expect(taskRecords("L2")[0].label).toBeNull();
    expect(labelTask("L1").labelled).toBe(0);
  });
  it("labels repeat candidates by comparing saved plans", async () => {
    const { recordJudgment, taskRecords } = await import("@/lib/server/judge/records");
    const { labelTask } = await import("@/lib/server/judge/labels");
    const plan = (action: string) => JSON.stringify({ version: 2, steps: [{ n: 1, connection_key: "live::exa::k", action_id: action }] });
    await seedTask("C1", { status: "completed", verification: "verified", planJson: plan("search") });
    await seedTask("C2", { status: "completed", verification: "verified", planJson: plan("contents") });
    await seedTask("N1", { status: "completed", verification: "verified", planJson: plan("search"), plannerModel: "Claude Code Opus 5.5 (medium)" });
    await seedExecution("N1", "execute");
    await usage("N1", "exa", "Main Exa", "search");
    for (const s of ["C1", "C2"]) recordJudgment({ callId: null, taskId: "N1", gate: "repeat.same_as", version: 1, model: "jev-1.13.0", subject: s, predicted: "same", score: 0.8, answer: null, acted: false, fallbackReason: null });
    labelTask("N1");
    expect(Object.fromEntries(taskRecords("N1").filter((x) => x.gate === "repeat.same_as").map((x) => [x.subject, x.label]))).toEqual({ C1: 1, C2: 0 });
  });

  it("does not count a planning session's own reads as the executor's usage", async () => {
    const { recordJudgment, taskRecords } = await import("@/lib/server/judge/records");
    const { labelTask } = await import("@/lib/server/judge/labels");
    await seedTask("P1", { status: "completed", verification: "verified" });
    await seedExecution("P1", "plan");
    await seedExecution("P1", "execute");
    // Only the PLAN-phase gateway session touched exa; the executor (preview/execute) never did.
    await usage("P1", "exa", "Main Exa", "a1", "P1-plan");
    const base = { callId: null, taskId: "P1", version: 1, model: "jev-1.13.0", answer: null, acted: false, fallbackReason: null };
    recordJudgment({ ...base, gate: "understand.uses", subject: "exa", predicted: "used", score: 0.9 });
    labelTask("P1");
    expect(taskRecords("P1").find((x) => x.gate === "understand.uses")?.label).toBe(0);
  });

  it("counts an approved write as the executor's usage", async () => {
    const { recordJudgment, taskRecords } = await import("@/lib/server/judge/records");
    const { labelTask } = await import("@/lib/server/judge/labels");
    await seedTask("W1", { status: "completed", verification: "verified" });
    await seedExecution("W1", "execute");
    await approvedWrite("W1", "gmail", "One Gmail", "send");
    const base = { callId: null, taskId: "W1", version: 1, model: "jev-1.13.0", answer: null, acted: false, fallbackReason: null };
    recordJudgment({ ...base, gate: "understand.uses", subject: "gmail", predicted: "used", score: 0.9 });
    const r = labelTask("W1");
    expect(r.labelled).toBe(1);
    expect(taskRecords("W1")[0].label).toBe(1);
  });

  it("labels a blocked task that an executor actually ran", async () => {
    const { recordJudgment, taskRecords } = await import("@/lib/server/judge/records");
    const { labelTask } = await import("@/lib/server/judge/labels");
    await seedTask("B1", { status: "blocked", verification: "failed" });
    await seedExecution("B1", "execute");
    await usage("B1", "exa", "Main Exa");
    recordJudgment({ callId: null, taskId: "B1", gate: "understand.uses", version: 1, model: "jev-1.13.0", subject: "exa", predicted: "used", score: 0.9, answer: null, acted: false, fallbackReason: null });
    const r = labelTask("B1");
    expect(r.labelled).toBe(1);
    expect(taskRecords("B1")[0].label).toBe(1);
  });

  it("leaves uses, trim and mail_role unlabelled for a flow-building task", async () => {
    const { recordJudgment, taskRecords } = await import("@/lib/server/judge/records");
    const { labelTask } = await import("@/lib/server/judge/labels");
    await seedTask("F1", { status: "completed", verification: "verified", context: { buildFlow: true } });
    await seedExecution("F1", "execute");
    await usage("F1", "exa", "Main Exa");
    const base = { callId: null, taskId: "F1", version: 1, model: "jev-1.13.0", answer: null, acted: false, fallbackReason: null };
    recordJudgment({ ...base, gate: "understand.uses", subject: "exa", predicted: "used", score: 0.9 });
    recordJudgment({ ...base, gate: "trim.connection", subject: "Main Exa", predicted: "drop", score: 0.9 });
    recordJudgment({ ...base, gate: "understand.mail_role", subject: null, predicted: "find_address", score: 0.9 });
    const r = labelTask("F1");
    expect(r.labelled).toBe(0);
    expect(taskRecords("F1").every((x) => x.label === null)).toBe(true);
  });

  it("does not label a blocked task whose only execution never verified its launch", async () => {
    const { recordJudgment, taskRecords } = await import("@/lib/server/judge/records");
    const { labelTask } = await import("@/lib/server/judge/labels");
    await seedTask("B2", { status: "blocked", verification: "failed" });
    await seedExecution("B2", "preview", { verified: false });
    // No connection_usage at all: a launch fault, not a decision not to use anything.
    const base = { callId: null, taskId: "B2", version: 1, model: "jev-1.13.0", answer: null, acted: false, fallbackReason: null };
    recordJudgment({ ...base, gate: "understand.uses", subject: "exa", predicted: "not_used", score: 0.9 });
    recordJudgment({ ...base, gate: "trim.connection", subject: "Main Exa", predicted: "drop", score: 0.9 });
    recordJudgment({ ...base, gate: "fastpath", subject: "exa", predicted: "fast", score: 0.9 });
    const r = labelTask("B2");
    expect(r.labelled).toBe(0);
    expect(taskRecords("B2").every((x) => x.label === null)).toBe(true);
  });

  it("labels only the reused candidate by outcome, leaving the other repeat candidates unlabelled", async () => {
    const { recordJudgment, taskRecords } = await import("@/lib/server/judge/records");
    const { labelTask } = await import("@/lib/server/judge/labels");
    await seedTask("R1", {
      status: "completed",
      verification: "verified",
      plannerModel: "reused from R1cand (2026-09-20)",
      context: { memory: { decision: "reuse", match: { taskId: "R1cand", file: "ONEMEMORY.md", date: "2026-09-20", title: "t" }, hasPlan: true, reuseText: null, lessons: null } },
    });
    await seedExecution("R1", "execute");
    const base = { callId: null, taskId: "R1", gate: "repeat.same_as" as const, version: 1, model: "jev-1.13.0", predicted: "same", answer: null, acted: false, fallbackReason: null };
    // Neither record is marked `acted`: the outcome label must come from matching the reused task id,
    // not from whichever candidate happens to carry `acted`.
    recordJudgment({ ...base, subject: "R1cand", score: 0.8 });
    recordJudgment({ ...base, subject: "R1other", score: 0.6 });
    labelTask("R1");
    const byKey = Object.fromEntries(taskRecords("R1").filter((x) => x.gate === "repeat.same_as").map((x) => [x.subject, x.label]));
    expect(byKey).toEqual({ R1cand: 1, R1other: null });
  });
});
