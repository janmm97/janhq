import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// A throwaway J/OS root and database, so no real log or task is touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-continuity-"));
const josRoot = path.join(tmp, "JOS");
beforeAll(() => {
  fs.mkdirSync(path.join(josRoot, "One"), { recursive: true });
  fs.mkdirSync(path.join(josRoot, "Studio"), { recursive: true });
});
process.env.JOS_HQ_JOS_ROOT = josRoot;
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");

const action = (problems: string[] = []) => ({ problems });

describe("Auto mode needs no operator approval", () => {
  it("approves validated actions in Auto, and only in Auto", async () => {
    const { autoApproves } = await import("@/lib/server/orchestrator");
    expect(autoApproves("auto", [action(), action()])).toBe(true);
    for (const mode of ["manual", "edit", "plan"] as const) expect(autoApproves(mode, [action()])).toBe(false);
  });

  it("still stops on an action HQ could not validate, since nobody can approve that", async () => {
    const { autoApproves } = await import("@/lib/server/orchestrator");
    expect(autoApproves("auto", [action(), action(["HQ dry-run failed: 404"])])).toBe(false);
    expect(autoApproves("auto", [])).toBe(false);
  });

  it("records who approved, and the approved action is released to EXECUTE exactly as for an operator", async () => {
    const { createApproval, resolveApproval, approvedActionsFor, getApproval } = await import("@/lib/server/approvals");
    const { createTaskRow } = await import("@/lib/server/tasks");
    const t = createTaskRow({ chatId: null, origin: "chat", request: "send it", mode: "auto", routeSelection: "Studio", context: { clarifications: [] } });
    const ap = createApproval(t.id, null, [fakeAction()], "Send the draft", "Studio");
    resolveApproval(ap.id, "approved", "Auto mode: approved by HQ without asking", "auto");
    expect(getApproval(ap.id)?.status).toBe("approved");
    expect(getApproval(ap.id)?.states.map((s) => s.state)).toEqual(["ready"]);
    expect(approvedActionsFor(ap.id).map((a) => a.payloadHash)).toEqual(["hash-1"]);
  });
});

describe("a follow-up message keeps its conversation's route", () => {
  const ask = (signals: Array<{ workspace: "One" | "Studio" | "both" | null }>) => ({ kind: "clarify" as const, reason: "", signals: signals.map((s) => ({ step: "platform" as const, label: "x", ...s })), warnings: [], impliedPlatforms: [] });

  it("inherits the route when the message names no business at all", async () => {
    const { continuesConversation } = await import("@/lib/server/routing");
    expect(continuesConversation(ask([]), "Studio")).toBe(true);
    expect(continuesConversation(ask([{ workspace: "both" }]), "One")).toBe(true);
  });

  it("still asks on a real ambiguity, and never invents a route for a chat's first message", async () => {
    const { continuesConversation } = await import("@/lib/server/routing");
    expect(continuesConversation(ask([{ workspace: "One" }, { workspace: "Studio" }]), "Studio")).toBe(false);
    expect(continuesConversation(ask([{ workspace: null }]), "Studio")).toBe(false); // a platform neither has connected
    expect(continuesConversation(ask([]), null)).toBe(false);
    expect(continuesConversation({ kind: "routed", workspace: "One", reason: "", signals: [], warnings: [], impliedPlatforms: [] }, "Studio")).toBe(false);
  });
});

describe("chat history reaches the next task", () => {
  it("renders what was asked, answered, approved and how it ended — newest task last", async () => {
    const { createTaskRow, updateTask, addMessage } = await import("@/lib/server/tasks");
    const { createApproval, resolveApproval } = await import("@/lib/server/approvals");
    const { run } = await import("@/lib/server/db");
    const { conversationContext } = await import("@/lib/server/conversation");
    const chatId = "chat_continuity_1";
    run("INSERT INTO chats(id, title, created_at, updated_at) VALUES (?, 'New workflow', ?, ?)", [chatId, new Date().toISOString(), new Date().toISOString()]);

    expect(conversationContext(chatId, null)).toBeNull();

    const first = createTaskRow({ chatId, origin: "chat", request: "Build a One Flow that prepares meeting notes for Blake", mode: "auto", routeSelection: "auto", context: { clarifications: [{ kind: "executor", question: "Grant Notion access?", answer: "Yes" }] } });
    updateTask(first.id, { route: "Studio", status: "unverified", title: "Meeting Notes Flow", plan_json: JSON.stringify({ normalized_objective: "Weekly meeting-notes One Flow for Blake" }) });
    const ap = createApproval(first.id, null, [fakeAction("Notion discovery search")], "search", "Studio");
    resolveApproval(ap.id, "approved", null);
    addMessage(chatId, "assistant", "result", "Executor turn failed: usage limit.", first.id, {});

    const ctx = conversationContext(chatId, null)!;
    expect(ctx.route).toBe("Studio");
    expect(ctx.lastTaskId).toBe(first.id);
    expect(ctx.text).toContain("Build a One Flow that prepares meeting notes for Blake");
    expect(ctx.text).toContain("Weekly meeting-notes One Flow for Blake");
    expect(ctx.text).toContain('"Grant Notion access?" → Yes');
    expect(ctx.text).toContain('"Notion discovery search": approved, not run');
    expect(ctx.text).toContain("usage limit");

    // A later unrouted task does not erase the route the conversation established.
    const second = createTaskRow({ chatId, origin: "chat", request: "Please proceed.", mode: "auto", routeSelection: "auto", context: { clarifications: [] } });
    updateTask(second.id, { status: "cancelled" });
    const again = conversationContext(chatId, null)!;
    expect(again.route).toBe("Studio");
    expect(again.lastTaskId).toBe(second.id);
    expect(again.text.indexOf("meeting notes for Blake")).toBeLessThan(again.text.indexOf("Please proceed."));
    expect(conversationContext(chatId, second.id)!.text).not.toContain("Please proceed.");
  });

  it("drops the oldest turns first when over budget", async () => {
    const { renderConversation } = await import("@/lib/server/conversation");
    const turn = (n: number) => ({ taskId: `t${n}`, title: `Task ${n}`, request: `request ${n} ${"x".repeat(1400)}`, route: "One", status: "completed", objective: null, clarifications: [], actions: [], answer: null });
    const text = renderConversation([turn(1), turn(2), turn(3)], 3200);
    expect(text).toContain("request 3");
    expect(text).not.toContain("request 1");
    expect(text.length).toBeLessThanOrEqual(3200);
  });

  it("puts the history in the executor prompt, and leaves a first message's prompt unchanged", async () => {
    const { buildExecutorPrompt } = await import("@/lib/server/prompt");
    const base = { taskId: "jos_x", workspace: "Studio" as const, phase: "preview" as const, mode: "auto" as const, request: "Please proceed.", routeReason: "Continues this conversation", plan: null, plannerNote: null, connections: [], flows: [], identity: { projectRoot: null, email: null }, clarifications: [], attachments: [] };
    const withHistory = buildExecutorPrompt({ ...base, conversation: 'Earlier task 1 of 1 — "Meeting Notes Flow"' });
    expect(withHistory).toContain("CONVERSATION SO FAR");
    expect(withHistory).toContain("Meeting Notes Flow");
    expect(withHistory).toContain("check with reads whether it already happened");
    expect(buildExecutorPrompt(base)).not.toContain("CONVERSATION SO FAR");
  });

  it("gives the planner the history too", async () => {
    const { buildPlannerPrompt } = await import("@/lib/server/planning");
    const p = buildPlannerPrompt({ taskId: "jos_x", workspace: "Studio", mode: "auto", request: "Please proceed.", routeReason: "", connections: [], flows: [], identity: { projectRoot: null, email: null }, clarifications: [], attachments: [], conversation: "Operator asked: build the meeting notes flow", buildFlow: false, agent: null, lessons: null });
    expect(p).toContain("CONVERSATION SO FAR");
    expect(p).toContain("build the meeting notes flow");
  });
});

function fakeAction(title = "Send the draft") {
  return {
    index: 1,
    kind: "one_action" as const,
    title,
    platform: "gmail",
    actionId: "conn_mod_def::x",
    connectionKey: "live::gmail::default::abc",
    connectionName: "Studio gmail",
    method: "POST",
    target: null,
    data: { a: 1 },
    pathVars: null,
    queryParams: null,
    flowKey: null,
    flowInputs: null,
    sideEffect: "send",
    idempotent: false,
    expectedCalls: 1,
    estimatedCost: "",
    payloadHash: "hash-1",
    dryRun: { ok: true, method: "POST", url: "https://x", detail: null },
    executorDryRunMatched: true,
    problems: [],
  };
}
