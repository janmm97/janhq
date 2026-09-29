import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rawPlan } from "./fixtures/plans";

// A throwaway J/OS root, and fakes for everything that would reach a real account or launch a process.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-pipeline-"));
const josRoot = path.join(tmp, "JOS");
process.env.JOS_HQ_JOS_ROOT = josRoot;
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
for (const d of ["One", "Studio", ".claude/agents", ".codex/agents"]) fs.mkdirSync(path.join(josRoot, d), { recursive: true });
// No test may reach a real One account: HQ's own read-only One calls (e.g. the approval dry-run in
// validateProposals) stop here, exactly as with the CLI missing (lib/server/one/cli.ts).
Object.assign(globalThis, {
  __josOneCli: { ok: false, shim: null, cliJs: null, node: process.execPath, version: null, error: "One CLI disabled in unit tests" },
  __josOneCliAt: Number.MAX_SAFE_INTEGER,
});

type Call = { phase: string; prompt: string; allowedConnectionKeys: string[] | null; mode: string };
// vi.mock factories are hoisted above this file's other top-level code, so their shared state is too.
const h = vi.hoisted(() => ({
  CONNS: [
    { platform: "notion", name: "Studio Notion", key: "live::notion::default::n1", state: "operational", access: null },
    { platform: "gmail", name: "Studio gmail", key: "live::gmail::default::g1", state: "operational", access: null },
  ],
  FLOWS: [] as Array<{ key: string; name: string; description: string | null; raw: Record<string, unknown> }>,
  calls: [] as Array<{ phase: string; prompt: string; allowedConnectionKeys: string[] | null; mode: string }>,
  script: [] as Array<(c: { phase: string; prompt: string; allowedConnectionKeys: string[] | null; mode: string }) => unknown>,
}));
const calls: Call[] = h.calls;
const script = h.script;

vi.mock("@/lib/server/one/discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/one/discovery")>()),
  listConnections: vi.fn(async () => ({ connections: h.CONNS, error: null })),
  listFlows: vi.fn(async () => ({ flows: h.FLOWS, error: null })),
}));
vi.mock("@/lib/server/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/identity")>()),
  verifyIdentity: vi.fn(async (scope: string) => ({ scope, ok: true, expected: { projectRoot: "", email: "", org: null }, actual: { projectRoot: `C:\\JOS\\${scope}`, email: "studio-owner@example.com", org: null, name: null, keyName: null }, problems: [], warnings: [], checkedAt: "" })),
}));
vi.mock("@/lib/server/dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/dispatch")>()),
  assertRuntimeReady: vi.fn(async () => ({ ok: true })),
  dispatch: vi.fn(async (req: { phase: string; prompt: string; allowedConnectionKeys?: string[] | null; mode: string }) => {
    const call = { phase: req.phase, prompt: req.prompt, allowedConnectionKeys: req.allowedConnectionKeys ?? null, mode: req.mode };
    h.calls.push(call);
    const next = h.script.shift();
    const executionId = `exe_${h.calls.length}`;
    const exit = next ? await next(call) : { plan: null, structured: null, error: "no scripted outcome" };
    return {
      executionId,
      identity: {},
      done: Promise.resolve({ executionId, status: "exited", exit: { code: 0, timedOut: false, killed: false, resultText: null, durationMs: 1, structured: null, plan: null, error: null, ...(exit as object) }, verification: { ok: true, model: "m", effort: "medium", cwd: "", mainModels: [] } }),
    };
  }),
}));

async function planWith(over: Record<string, unknown> = {}) {
  const { coercePlan } = await import("@/lib/server/executors/plan-schema");
  const r = coercePlan(rawPlan(over));
  if (!r.ok) throw new Error(r.error);
  return r.plan;
}
function done(answer = "Done.") {
  return { structured: { status: "completed", answer, summary: answer, identity_check: { project_root: "C:\\JOS\\Studio", email: "studio-owner@example.com", passed: true }, proposed_actions: [], artifacts: [], verification: { performed: true, passed: true, method: "read back", evidence: "page p_1" }, limitations: [], learned: [], needs_user_input: "" } };
}
async function waitFor(taskId: string, statuses: string[], ms = 15000) {
  const { getTask } = await import("@/lib/server/tasks");
  const end = Date.now() + ms;
  for (;;) {
    const t = getTask(taskId)!;
    if (statuses.includes(t.status)) return t;
    if (Date.now() > end) throw new Error(`task ${taskId} is ${t.status}, waited for ${statuses.join("/")}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
async function send(text: string, mode: "auto" | "edit" | "manual" | "plan" = "auto") {
  const { submitTask } = await import("@/lib/server/orchestrator");
  const { createChat } = await import("@/lib/server/tasks");
  return submitTask({ chatId: createChat().id, text, routeSelection: "Studio", mode });
}

beforeEach(async () => {
  calls.length = 0;
  script.length = 0;
  h.FLOWS = [];
  fs.writeFileSync(path.join(josRoot, "ONEMEMORY.md"), "# One log\n\n---\n");
  fs.writeFileSync(path.join(josRoot, "STUDIOMEMORY.md"), "# Studio log\n\n---\n");
  fs.writeFileSync(path.join(josRoot, "JOSMEMORY.md"), "# J/OS log\n");
  const { run } = await import("@/lib/server/db");
  for (const t of ["tasks", "executions", "events", "chats", "chat_messages", "approvals", "approval_actions"]) run(`DELETE FROM ${t}`);
});

describe("planning sessions", () => {
  it("plans in a read-only PLAN session, checks the plan, and stops in Plan mode", async () => {
    const p = await planWith();
    script.push(() => ({ plan: p }));
    const t = await send("Summarize this week's Notion meeting notes into one page", "plan");
    const end = await waitFor(t.id, ["planned", "blocked", "failed"]);
    expect(end.status).toBe("planned");
    expect(calls.map((c) => c.phase)).toEqual(["plan"]);
    expect(calls[0].prompt).toContain("PHASE: PLAN — read-only");
    expect(JSON.parse(end.plan_json!).version).toBe(2);
    expect(end.planner_model).toBe("GPT 6 Astra (medium)");
    expect(fs.readFileSync(path.join(josRoot, "STUDIOMEMORY.md"), "utf8")).toMatch(/- \*\*Status:\*\* done/);
  });

  it("hands the checked plan to the executor, with unverified steps marked", async () => {
    const p = await planWith();
    script.push(() => ({ plan: p }), () => done());
    const t = await send("Summarize this week's Notion meeting notes into one page");
    const end = await waitFor(t.id, ["completed", "unverified", "blocked", "failed"]);
    expect(end.status).toBe("completed");
    expect(calls.map((c) => c.phase)).toEqual(["plan", "preview"]);
    expect(calls[1].prompt).toContain("CHECKED PLAN (GPT 6 Astra (medium);");
    expect(calls[1].prompt).toContain("UNVERIFIED: look this action up yourself");
  });

  it("asks the planner's intent question, then passes the answer to the executor", async () => {
    const { answerClarification } = await import("@/lib/server/orchestrator");
    const p = await planWith({ status: "blocked", intent_questions: ["Which Notion database should hold the summary?"] });
    script.push(() => ({ plan: p }), () => done());
    const t = await send("Summarize this week's Notion meeting notes into one page");
    await waitFor(t.id, ["needs_clarification"]);
    await answerClarification(t.id, "The Meetings database");
    await waitFor(t.id, ["completed"]);
    expect(calls[1].prompt).toContain('Operator answered "Which Notion database should hold the summary?" → The Meetings database');
  });

  it("planning failure in auto: continues without a plan and says so", async () => {
    script.push(() => ({ plan: null, error: "Executor timed out after 600 s" }), () => done());
    const t = await send("Summarize this week's Notion meeting notes into one page");
    const end = await waitFor(t.id, ["completed"]);
    expect(end.planner_model).toMatch(/^none \(planning failed: Executor timed out/);
    expect(calls[1].prompt).not.toContain("CHECKED PLAN");
  });

  it("planning failure in manual: stops, dispatching nothing else", async () => {
    script.push(() => ({ plan: null, error: "the planner returned no structured plan" }));
    const t = await send("Summarize this week's Notion meeting notes into one page", "manual");
    const end = await waitFor(t.id, ["blocked"]);
    expect(end.error).toMatch(/Planning failed/);
    expect(calls.map((c) => c.phase)).toEqual(["plan"]);
  });

  it("Plan mode waits in the workspace line like every other mode", async () => {
    const { afterDiscovery } = await import("@/lib/server/orchestrator");
    for (const mode of ["auto", "manual", "edit", "plan"] as const) expect(afterDiscovery(mode)).toEqual({ status: "in_line", stage: "queue" });
  });
});

describe("checking the logs first", () => {
  const req = "Summarize this week's Notion meeting notes into one page";
  async function earlier(status: "done" | "blocked", plan: boolean) {
    const { createTaskRow, updateTask } = await import("@/lib/server/tasks");
    const { openLogEntry, closeLogEntry } = await import("@/lib/server/logs");
    const prev = createTaskRow({ chatId: null, origin: "chat", request: req, mode: "auto", routeSelection: "Studio", context: { clarifications: [] } });
    // The earlier plan was made for the earlier request: its objective and success condition are its own.
    if (plan) updateTask(prev.id, { plan_json: JSON.stringify(await planWith({ objective: "Summarize LAST week's notes (earlier request)", success_condition: "OLD SUCCESS CONDITION" })) });
    await openLogEntry({ taskId: prev.id, file: "STUDIOMEMORY.md", title: "Notes summary", asked: req, route: "Studio — test", at: new Date("2026-09-21T12:00:00Z") });
    await closeLogEntry({ taskId: prev.id, file: "STUDIOMEMORY.md", status, outcome: status === "done" ? "Summary page p_9 created" : "Notion refused", artifacts: "none", learned: "Use the Meetings database" });
    return prev;
  }

  it("reuse keeps the new request as the objective and skips the planner", async () => {
    const prev = await earlier("done", true);
    script.push(() => done());
    const t = await send(req);
    const end = await waitFor(t.id, ["completed"]);
    expect(calls.map((c) => c.phase)).toEqual(["preview"]);
    expect(end.planner_model).toBe(`reused from ${prev.id} (2026-09-21)`);
    expect(calls[0].prompt).toContain(`USER OBJECTIVE\n${req}`);
    expect(calls[0].prompt).toContain("FROM THE J/OS LOGS");
    expect(calls[0].prompt).toContain("Summary page p_9 created");
    expect(calls[0].prompt).toContain(`CHECKED PLAN (reused from ${prev.id} (2026-09-21)`);
    // Review Focus 1: the reused plan is reference only; the new request stays the only objective.
    expect(calls[0].prompt).toContain("made for an earlier, similar request");
    expect(calls[0].prompt).not.toContain("Normalized objective: Summarize LAST week");
    expect(calls[0].prompt).not.toContain("OLD SUCCESS CONDITION");
    expect(fs.readFileSync(path.join(josRoot, "STUDIOMEMORY.md"), "utf8")).toContain(`- **Reused:** matched "Notes summary"`);
  });

  it("re-plans a match that ended blocked, with its lessons in the brief", async () => {
    await earlier("blocked", false);
    const p = await planWith();
    script.push(() => ({ plan: p }), () => done());
    const t = await send(req);
    await waitFor(t.id, ["completed"]);
    expect(calls[0].phase).toBe("plan");
    expect(calls[0].prompt).toContain("LESSONS FROM SIMILAR EARLIER TASKS");
    expect(calls[0].prompt).toContain("Notion refused");
  });

  it("a reuse without a saved plan still plans in Plan mode", async () => {
    await earlier("done", false);
    const p = await planWith();
    script.push(() => ({ plan: p }));
    const t = await send(req, "plan");
    await waitFor(t.id, ["planned"]);
    expect(calls.map((c) => c.phase)).toEqual(["plan"]);
  });

  it("a root-session brief takes only lessons from the logs, never a reuse (spec 1.6)", async () => {
    await earlier("done", true);
    script.push(() => done());
    const { submitTask } = await import("@/lib/server/orchestrator");
    const { createChat, taskContext } = await import("@/lib/server/tasks");
    const brief = `YOU ARE THE PRIMARY EXECUTOR FOR THIS TASK\nUSER OBJECTIVE\n${req}\nSUCCESS CONDITION\nOne summary page exists in Meetings.`;
    const t = submitTask({ chatId: createChat().id, text: req, routeSelection: "Studio", mode: "auto", origin: "cli", orchestratorBrief: brief });
    const end = await waitFor(t.id, ["completed", "unverified", "failed", "blocked"]);
    expect(calls.map((c) => c.phase)).toEqual(["preview"]);
    expect(end.planner_model).toBe("root Orchestrator session (jos dispatch)");
    expect(taskContext(end).memory?.decision).toBe("plan");
    expect(calls[0].prompt).not.toContain("planning was skipped");
    expect(calls[0].prompt).not.toContain("CHECKED PLAN");
  });
});

describe("agents keep their own memory", () => {
  it("logs to the agent's LOGS.md and carries it into a later conversation's prompts", async () => {
    const { createAgentDefinition, createConversation, sendAgentMessage } = await import("@/lib/server/agents");
    const { getTask } = await import("@/lib/server/tasks");
    const a = createAgentDefinition({ workspace: "Studio", name: "notes keeper", connections: [{ platform: "notion", name: "Studio Notion" }], purpose: "Keeps meeting notes.", mayDo: "Read and write Notion pages.", mustNever: "Email anyone." });
    const logsFile = path.join(josRoot, ".codex", "agents", a.name, "LOGS.md");
    const p = await planWith();
    script.push(() => ({ plan: p }), () => done("Created page p_1 in Meetings."));
    const conv1 = createConversation("Studio", a.name).id;
    const t1 = sendAgentMessage(conv1, "Summarize the Notion meeting notes from Monday", "auto");
    await waitFor(t1.id, ["completed"]);
    const log = fs.readFileSync(logsFile, "utf8");
    expect(log).toContain(`jos:run=${t1.id}`);
    expect(log).toMatch(/- \*\*Status:\*\* done/);
    expect(fs.readFileSync(path.join(josRoot, "STUDIOMEMORY.md"), "utf8")).toContain(`- **Agent log:** .codex/agents/${a.name}/LOGS.md`);
    expect(getTask(t1.id)!.request).toBe("Summarize the Notion meeting notes from Monday");

    script.push(() => ({ plan: p }), () => done());
    const t2 = sendAgentMessage(createConversation("Studio", a.name).id, "Now do Tuesday's notes as well please", "auto");
    await waitFor(t2.id, ["completed"]);
    const planCall = calls.filter((c) => c.phase === "plan").at(-1)!;
    expect(planCall.prompt).toContain("AGENT HISTORY");
    expect(planCall.prompt).toContain("Created page p_1 in Meetings.");
    expect(planCall.prompt).toContain("## Purpose\nKeeps meeting notes.");

    // A follow-up in the first conversation: the chat history travels as context, not inside the request.
    script.push(() => ({ plan: p }), () => done());
    const t3 = sendAgentMessage(conv1, "And Wednesday's notes too please", "auto");
    await waitFor(t3.id, ["completed"]);
    expect(getTask(t3.id)!.request).toBe("And Wednesday's notes too please");
    expect(calls.filter((c) => c.phase === "preview").at(-1)!.prompt).toContain("Earlier in this conversation (for context only):");
  });

  it("narrows every session to the agent's connections and flags a plan that goes outside them", async () => {
    const { createAgentDefinition, createConversation, sendAgentMessage } = await import("@/lib/server/agents");
    const { getTask, taskContext } = await import("@/lib/server/tasks");
    const a = createAgentDefinition({ workspace: "Studio", name: "scoped one", connections: [{ platform: "notion", name: "Studio Notion" }], purpose: "p", mayDo: "m", mustNever: "n" });
    const p = await planWith({ connections: [{ platform: "gmail", connection_key: "live::gmail::default::g1", connection_name: "Studio gmail", why: "x" }] });
    script.push(() => ({ plan: p }), () => done());
    const t = sendAgentMessage(createConversation("Studio", a.name).id, "Summarize the Notion meeting notes from Monday", "auto");
    await waitFor(t.id, ["completed"]);
    expect(calls.map((c) => c.allowedConnectionKeys)).toEqual([["live::notion::default::n1"], ["live::notion::default::n1"]]);
    expect((taskContext(getTask(t.id)!).planProblems ?? []).join(" ")).toMatch(/outside this agent's allowed connections/);
  });

  it("does not auto-approve a proposal on a connection outside the agent's scope", async () => {
    const { createAgentDefinition, createConversation, sendAgentMessage } = await import("@/lib/server/agents");
    const { approvalsForTask } = await import("@/lib/server/approvals");
    const a = createAgentDefinition({ workspace: "Studio", name: "scoped two", connections: [{ platform: "notion", name: "Studio Notion" }], purpose: "p", mayDo: "m", mustNever: "n" });
    const p = await planWith();
    const proposal = { kind: "one_action", title: "Email the notes", platform: "gmail", action_id: "conn_mod_def::gmail::send", connection_key: "live::gmail::default::g1", connection_name: "Studio gmail", method: "POST", target: "x", data_json: "{}", path_vars_json: "", query_params_json: "", flow_key: "", flow_inputs_json: "", side_effect: "send", idempotent: false, expected_calls: 1, estimated_cost: "", dry_run_ok: true };
    script.push(() => ({ plan: p }), () => ({ structured: { ...done().structured, status: "needs_approval", proposed_actions: [proposal] } }));
    const t = sendAgentMessage(createConversation("Studio", a.name).id, "Summarize the Notion meeting notes and email them", "auto");
    const end = await waitFor(t.id, ["awaiting_approval", "completed", "failed", "blocked"]);
    expect(end.status).toBe("awaiting_approval");
    expect(approvalsForTask(t.id)[0].actions[0].problems.join(" ")).toMatch(/outside this agent's allowed connections/);
  });

  it("does not auto-approve a flow run whose steps use a connection outside the agent's scope", async () => {
    const { createAgentDefinition, createConversation, sendAgentMessage } = await import("@/lib/server/agents");
    const { approvalsForTask } = await import("@/lib/server/approvals");
    const a = createAgentDefinition({ workspace: "Studio", name: "scoped three", connections: [{ platform: "notion", name: "Studio Notion" }], purpose: "p", mayDo: "m", mustNever: "n" });
    const dir = path.join(josRoot, "Studio", ".one", "flows", "notes-and-mail");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify({ key: "notes-and-mail", name: "Notes and mail", steps: [{ id: "mail", type: "action", action: { platform: "gmail", actionId: "conn_mod_def::gmail::send", connectionKey: "live::gmail::default::g1" } }] }));
    h.FLOWS = [{ key: "notes-and-mail", name: "Notes and mail", description: null, raw: {} }];
    const p = await planWith();
    const proposal = { kind: "one_flow", title: "Run notes-and-mail", platform: "", action_id: "", connection_key: "", connection_name: "", method: "", target: "x", data_json: "", path_vars_json: "", query_params_json: "", flow_key: "notes-and-mail", flow_inputs_json: "{}", side_effect: "send", idempotent: false, expected_calls: 1, estimated_cost: "", dry_run_ok: true };
    script.push(() => ({ plan: p }), () => ({ structured: { ...done().structured, status: "needs_approval", proposed_actions: [proposal] } }));
    const t = sendAgentMessage(createConversation("Studio", a.name).id, "Summarize the Notion meeting notes and email them", "auto");
    const end = await waitFor(t.id, ["awaiting_approval", "completed", "failed", "blocked"]);
    expect(end.status).toBe("awaiting_approval");
    expect(approvalsForTask(t.id)[0].actions[0].problems.join(" ")).toMatch(/step "mail" uses connection "Studio gmail", which is outside this agent's allowed connections/);
  });

  it("Execute this plan keeps the agent: its connections, its SOP and its log", async () => {
    const { createAgentDefinition, createConversation, sendAgentMessage } = await import("@/lib/server/agents");
    const { executePlan } = await import("@/lib/server/orchestrator");
    const { taskContext } = await import("@/lib/server/tasks");
    const a = createAgentDefinition({ workspace: "Studio", name: "plan runner", connections: [{ platform: "notion", name: "Studio Notion" }], purpose: "Keeps meeting notes.", mayDo: "m", mustNever: "n" });
    const p = await planWith();
    script.push(() => ({ plan: p }));
    const planned = sendAgentMessage(createConversation("Studio", a.name).id, "Summarize the Notion meeting notes from Thursday", "plan");
    await waitFor(planned.id, ["planned"]);
    script.push(() => done());
    const t = executePlan(planned.id, "auto");
    const end = await waitFor(t.id, ["completed", "unverified", "failed", "blocked"]);
    expect(end.status).toBe("completed");
    expect(end.origin).toBe("agent");
    expect(taskContext(end).agent).toEqual({ workspace: "Studio", name: a.name });
    const preview = calls.at(-1)!;
    expect(preview.phase).toBe("preview");
    expect(preview.allowedConnectionKeys).toEqual(["live::notion::default::n1"]);
    expect(preview.prompt).toContain("## Purpose\nKeeps meeting notes.");
    expect(fs.readFileSync(path.join(josRoot, ".codex", "agents", a.name, "LOGS.md"), "utf8")).toContain(`jos:run=${t.id}`);
  });

  it("Execute this plan shows in the agent's conversation, before the result it leads to", async () => {
    const { createAgentDefinition, createConversation, sendAgentMessage, conversationMessages } = await import("@/lib/server/agents");
    const { executePlan } = await import("@/lib/server/orchestrator");
    const a = createAgentDefinition({ workspace: "Studio", name: "plan echo", connections: [{ platform: "notion", name: "Studio Notion" }], purpose: "Keeps hiring notes.", mayDo: "m", mustNever: "n" });
    const conv = createConversation("Studio", a.name);
    const p = await planWith();
    script.push(() => ({ plan: p }));
    const planned = sendAgentMessage(conv.id, "List the open action items in the Notion hiring notes", "plan");
    await waitFor(planned.id, ["planned"]);
    script.push(() => done("Listed."));
    const t = executePlan(planned.id, "manual");
    await waitFor(t.id, ["completed", "unverified", "failed", "blocked"]);
    const msgs = conversationMessages(conv.id).map((m) => [m.role, m.content, m.task_id]);
    const ran = msgs.findIndex((m) => m[0] === "user" && m[1] === "Execute the plan (manual)" && m[2] === t.id);
    expect(ran).toBeGreaterThan(-1);
    expect(ran).toBeLessThan(msgs.findIndex((m) => m[0] === "agent" && m[2] === t.id));
  });

  it("lists when each agent was registered", async () => {
    const { createAgentDefinition, listAgentsView } = await import("@/lib/server/agents");
    const a = createAgentDefinition({ workspace: "Studio", name: "registered one", connections: [{ platform: "notion", name: "Studio Notion" }], purpose: "p", mayDo: "m", mustNever: "n" });
    const at = listAgentsView("Studio").find((x) => x.key === a.name)?.registeredAt;
    expect(Date.parse(at ?? "")).toBeGreaterThan(Date.now() - 60_000);
  });

  it("recreates a missing LOGS.md, says so, and still logs the task in it", async () => {
    const { createAgentDefinition, createConversation, sendAgentMessage } = await import("@/lib/server/agents");
    const { all } = await import("@/lib/server/db");
    const a = createAgentDefinition({ workspace: "Studio", name: "log keeper", connections: [{ platform: "notion", name: "Studio Notion" }], purpose: "p", mayDo: "m", mustNever: "n" });
    const logsFile = path.join(josRoot, ".codex", "agents", a.name, "LOGS.md");
    fs.rmSync(logsFile);
    const p = await planWith();
    script.push(() => ({ plan: p }), () => done());
    const t = sendAgentMessage(createConversation("Studio", a.name).id, "Summarize the Notion meeting notes from Friday", "auto");
    await waitFor(t.id, ["completed"]);
    const log = fs.readFileSync(logsFile, "utf8");
    expect(log).toContain(`# ${a.name} — agent log`);
    expect(log).toContain(`jos:run=${t.id}`);
    expect(fs.readFileSync(path.join(josRoot, "STUDIOMEMORY.md"), "utf8")).toContain(`- **Agent log:** .codex/agents/${a.name}/LOGS.md`);
    expect(all<{ level: string }>("SELECT level FROM events WHERE task_id = ? AND type = 'agent_log_recreated'", [t.id]).map((e) => e.level)).toEqual(["warning"]);
  });

  it("no readable connection list: blocks the task with a clear message", async () => {
    const { createAgentDefinition, createConversation, sendAgentMessage, findAgent } = await import("@/lib/server/agents");
    const a = createAgentDefinition({ workspace: "Studio", name: "unscoped", connections: [{ platform: "notion", name: "Studio Notion" }], purpose: "p", mayDo: "m", mustNever: "n" });
    const sop = findAgent("Studio", a.name)!.sopFile!;
    fs.writeFileSync(sop, fs.readFileSync(sop, "utf8").replace('- notion · "Studio Notion"\n', ""));
    const t = sendAgentMessage(createConversation("Studio", a.name).id, "Summarize the Notion meeting notes from Monday", "auto");
    const end = await waitFor(t.id, ["blocked"]);
    expect(end.error).toMatch(/lists no connection HQ can read/);
    expect(calls).toHaveLength(0);
  });

  it("marks an interrupted agent task in its LOGS.md and keeps the entry open", async () => {
    const { createAgentDefinition } = await import("@/lib/server/agents");
    const { createTaskRow, updateTask } = await import("@/lib/server/tasks");
    const { openLogEntry } = await import("@/lib/server/logs");
    const { reconcileTasksAfterRestart } = await import("@/lib/server/orchestrator");
    const a = createAgentDefinition({ workspace: "Studio", name: "restart probe", connections: [{ platform: "notion", name: "Studio Notion" }], purpose: "p", mayDo: "m", mustNever: "n" });
    const logsFile = path.join(josRoot, ".codex", "agents", a.name, "LOGS.md");
    const t = createTaskRow({ chatId: null, origin: "agent", request: "Long job", mode: "auto", routeSelection: "Studio", context: { clarifications: [], agent: { workspace: "Studio", name: a.name }, agentLog: { file: logsFile, closed: false } } });
    await openLogEntry({ taskId: t.id, file: "STUDIOMEMORY.md", title: "Long job", asked: "Long job", route: "Studio" });
    await openLogEntry({ taskId: t.id, file: logsFile, title: "Long job", asked: "Long job" });
    updateTask(t.id, { route: "Studio", status: "executing", log_file: "STUDIOMEMORY.md", log_opened_at: new Date().toISOString() });
    await reconcileTasksAfterRestart();
    const log = fs.readFileSync(logsFile, "utf8");
    expect(log).toMatch(/- \*\*Interrupted:\*\*/);
    expect(log).toMatch(/- \*\*Status:\*\* in progress/);
  });
});
