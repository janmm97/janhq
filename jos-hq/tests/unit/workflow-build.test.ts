import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { rawPlan } from "./fixtures/plans";

// A throwaway J/OS root and database, so no real log, task or flow is touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-workflow-build-"));
const josRoot = path.join(tmp, "JOS");
beforeAll(() => {
  fs.mkdirSync(path.join(josRoot, "One"), { recursive: true });
  fs.mkdirSync(path.join(josRoot, "Studio"), { recursive: true });
});
process.env.JOS_HQ_JOS_ROOT = josRoot;
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");

const flow = (key: string) => ({ key, name: key, description: null, raw: {} });

// 2026-09-23: a "+ New Workflow" chat ran the job once (four Notion pages) and built no flow, because
// the only thing that said "workflow" was the editable draft text, and it was not in the sent message.
describe("a New Workflow chat builds a One Flow whatever its first message says", () => {
  it("the chat itself carries the purpose; an ordinary chat does not", async () => {
    const { createChat } = await import("@/lib/server/tasks");
    const { chatBuildsFlow } = await import("@/lib/server/flowbuild");
    const wf = createChat("New workflow", "workflow");
    const plain = createChat("Untitled");
    expect(wf.purpose).toBe("workflow");
    expect(chatBuildsFlow(wf.id)).toBe(true);
    expect(chatBuildsFlow(plain.id)).toBe(false);
    expect(chatBuildsFlow(null)).toBe(false);
  });

  it("an existing database gains the column, and chats the button opened are backfilled", async () => {
    const { migrateSchema } = await import("@/lib/server/db");
    const old = new DatabaseSync(":memory:");
    old.exec("CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'Untitled', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    old.exec("INSERT INTO chats VALUES ('c1', 'New workflow', 'x', 'x'), ('c2', 'Weekly notes', 'x', 'x')");
    migrateSchema(old);
    migrateSchema(old); // idempotent
    const rows = old.prepare("SELECT id, purpose FROM chats ORDER BY id").all() as Array<{ id: string; purpose: string | null }>;
    expect(rows).toEqual([
      { id: "c1", purpose: "workflow" },
      { id: "c2", purpose: null },
    ]);
  });

  it("the executor is told to build and save a flow, not to carry out the process", async () => {
    const { buildExecutorPrompt } = await import("@/lib/server/prompt");
    const { coercePlan } = await import("@/lib/server/executors/plan-schema");
    const coerced = coercePlan(rawPlan({ objective: "Prepare meeting notes", success_condition: "Four Notion pages exist" }));
    if (!coerced.ok) throw new Error(coerced.error);
    const base = {
      taskId: "jos_x",
      workspace: "Studio" as const,
      phase: "preview" as const,
      mode: "auto" as const,
      request: "prepares meeting notes for Blake's meetings from Monday through Friday.",
      routeReason: "Named entity: Blake",
      plan: coerced.plan,
      plannerNote: null,
      connections: [],
      flows: [],
      identity: { projectRoot: null, email: null },
      clarifications: [],
      attachments: [],
    };
    const p = buildExecutorPrompt({ ...base, buildFlow: true });
    expect(p).toContain("BUILD A ONE FLOW");
    expect(p).toContain("Do not carry out the process yourself");
    expect(p).toContain("one --agent flow list");
    // The planner's success condition describes a one-off run; the flow contract comes first.
    expect(p.indexOf("saved One Flow")).toBeLessThan(p.indexOf("Four Notion pages exist"));
    expect(buildExecutorPrompt(base)).not.toContain("BUILD A ONE FLOW");
  });

  it("the planner is told the deliverable is a flow", async () => {
    const { buildPlannerPrompt } = await import("@/lib/server/planning");
    const input = { taskId: "jos_x", workspace: "Studio" as const, mode: "auto" as const, request: "prepares meeting notes for Blake", routeReason: "", connections: [], flows: [], identity: { projectRoot: null, email: null }, clarifications: [], attachments: [], conversation: null, buildFlow: true, agent: null, lessons: null };
    expect(buildPlannerPrompt(input)).toContain("BUILD A ONE FLOW");
    expect(buildPlannerPrompt({ ...input, buildFlow: false })).not.toContain("BUILD A ONE FLOW");
  });
});

describe("HQ checks the flow exists itself, from the live flow list", () => {
  const root = () => path.join(josRoot, "Studio");
  const writeFlow = (key: string, mtime: Date) => {
    const f = path.join(root(), ".one", "flows", key, "flow.json");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "{}");
    fs.utimesSync(f, mtime, mtime);
  };

  it("passes when a new flow appears", async () => {
    const { checkFlowBuild } = await import("@/lib/server/flowbuild");
    const r = checkFlowBuild({ workspace: "Studio", workspaceRoot: root(), before: ["old-flow"], since: new Date().toISOString(), after: { flows: [flow("old-flow"), flow("meeting-notes")], error: null } });
    expect(r.created).toEqual(["meeting-notes"]);
    expect(r.problems).toEqual([]);
  });

  it("fails when no flow was saved — the case that shipped as Verified Complete", async () => {
    const { checkFlowBuild } = await import("@/lib/server/flowbuild");
    const r = checkFlowBuild({ workspace: "Studio", workspaceRoot: root(), before: [], since: new Date().toISOString(), after: { flows: [], error: null } });
    expect(r.problems.join(" ")).toMatch(/no new or changed One Flow/);
  });

  it("accepts an edit to an existing flow's definition during the task, but not an untouched one", async () => {
    const { checkFlowBuild } = await import("@/lib/server/flowbuild");
    const since = new Date(Date.now() - 60_000);
    writeFlow("edited", new Date());
    writeFlow("untouched", new Date(Date.now() - 3_600_000));
    const edited = checkFlowBuild({ workspace: "Studio", workspaceRoot: root(), before: ["edited"], since: since.toISOString(), after: { flows: [flow("edited")], error: null } });
    expect(edited.updated).toEqual(["edited"]);
    expect(edited.problems).toEqual([]);
    const untouched = checkFlowBuild({ workspace: "Studio", workspaceRoot: root(), before: ["untouched"], since: since.toISOString(), after: { flows: [flow("untouched")], error: null } });
    expect(untouched.problems).toHaveLength(1);
  });

  it("cannot confirm anything when the flow list fails", async () => {
    const { checkFlowBuild } = await import("@/lib/server/flowbuild");
    const r = checkFlowBuild({ workspace: "Studio", workspaceRoot: root(), before: [], since: new Date().toISOString(), after: { flows: null, error: "spawn failed" } });
    expect(r.problems.join(" ")).toContain("spawn failed");
  });
});
