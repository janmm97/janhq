import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A throwaway J/OS root, database and config, so no real definition, log or task is touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-agent-edit-"));
const josRoot = path.join(tmp, "JOS");
const extraDir = path.join(tmp, "fixture-agents");
for (const d of [path.join(josRoot, "One"), path.join(josRoot, "Studio"), path.join(josRoot, ".claude", "agents"), path.join(josRoot, ".codex", "agents"), extraDir]) fs.mkdirSync(d, { recursive: true });
const realConfig = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "jos-hq.config.json"), "utf8"));
fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ ...realConfig, agentDirsOverride: [extraDir] }));
process.env.JOS_HQ_JOS_ROOT = josRoot;
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
process.env.JOS_HQ_CONFIG = path.join(tmp, "config.json");

const historyDir = () => path.join(tmp, "data", "agent-history");
const answers = (over: Partial<{ purpose: string; mayDo: string; mustNever: string; connections: Array<{ platform: string; name: string }> }> = {}) => ({
  connections: [{ platform: "notion", name: "Studio Notion" }],
  purpose: "Screens applicants.",
  mayDo: "Read the candidates database.",
  mustNever: "Email a candidate.",
  ...over,
});

let seq = 0;
async function hqAgent(workspace: "One" | "Studio") {
  const { createAgentDefinition, findAgent } = await import("@/lib/server/agents");
  const made = createAgentDefinition({ workspace, name: `screener ${++seq}`, ...answers() });
  return findAgent(workspace, made.name)!;
}

async function agentTask(workspace: "One" | "Studio", name: string, status: string) {
  const { createTaskRow, updateTask } = await import("@/lib/server/tasks");
  const task = createTaskRow({ chatId: null, origin: "agent", request: "Screen the new applicants", mode: "auto", routeSelection: workspace, context: { clarifications: [], agent: { workspace, name } } });
  updateTask(task.id, { status: status as never });
  return task;
}

// The shape of studio_hr_assistant_agent.toml as HQ wrote it on 2026-09-23, trimmed: same headings,
// bullets, backslashes, curly quotes and multi-paragraph answers.
const HR_AGENT = `name = "studio_hr_example"
description = "This agent will help us with our recruitment process."
model = "gpt-6-sol"
model_reasoning_effort = "medium"
developer_instructions = """
You are studio_hr_example, a Studio sub-agent of J/OS. You run inside the Studio executor, rooted in JOS/Studio/, and you execute; you never delegate or start other agent sessions.

## Purpose
This agent will help us with our recruitment process.

## Allowed connections
- google-drive · "Studio Drive"
- google-docs · "Studio Docs"
- open-router · "Studio OpenRouter"
- notion · "Studio Notion"
Use no other connection. Resolve each connection's key live with \`one --agent connection list\`, from JOS/Studio/ only.

## What you may do with them
This agent will review all the candidates inside this Notion database: https://app.notion.com/p/3e26?v=3e26&source=copy_link

Then review the candidate’s résumé and provide feedback.

Lastly, create a doc that has the following:\x20
- Full transcript of the interview
- Link to the candidate's resume

## What you must never do
Assume.

## Guardrails (set by the J/OS Orchestrator)
- Identity first: before anything else run \`one --agent config path\` and \`one --agent whoami\`; projectRoot must end in \\JOS\\Studio and the account must be studio-owner@example.com. If not, stop and report.
- Verification: tool success is not objective success; read back the resulting state and report IDs.
"""
`;

describe("reading an agent's answers back", () => {
  it("writes a minimal, escaped TOML definition, and round-trips paths, quotes and control characters through SOP.md", async () => {
    const { draftAgentDefinition, parseSimpleToml, createAgentDefinition, findAgent, agentEditState } = await import("@/lib/server/agents");
    const purpose = 'Screens C:\\new\\test and \\JOS\\Studio with """quoted""" text.';
    const a = { workspace: "Studio" as const, name: "escaping regression", ...answers({ purpose, mayDo: 'Read C:\\new\\test and \\JOS\\Studio. Include """quoted""" text.\nTab:\t end.' }) };
    const draft = draftAgentDefinition(a);
    const toml = parseSimpleToml(draft.content);
    expect(toml.description).toBe(purpose);
    expect(toml.developer_instructions).toContain(".codex/agents/studio_escaping_regression/SOP.md");
    expect(draft.sop).toContain(a.mayDo);
    const created = createAgentDefinition(a);
    expect(agentEditState(findAgent("Studio", created.name)!)).toMatchObject({ editable: true, answers: answers({ purpose, mayDo: a.mayDo }) });
  });
  it.each(["One", "Studio"] as const)("recovers exactly what was answered for an HQ-written %s agent", async (workspace) => {
    const { agentEditState } = await import("@/lib/server/agents");
    const state = agentEditState(await hqAgent(workspace));
    expect(state).toMatchObject({ editable: true, answers: answers() });
  });

  it("reads the studio_hr_assistant_agent format, multi-paragraph answers and all, and asks for migration before an edit", async () => {
    const { agentEditState, findAgent, legacyAnswers } = await import("@/lib/server/agents");
    fs.writeFileSync(path.join(josRoot, ".codex", "agents", "studio_hr_example.toml"), HR_AGENT);
    const def = findAgent("Studio", "studio_hr_example")!;
    expect(def.format).toBe("legacy");
    expect(agentEditState(def)).toMatchObject({ editable: false, reason: expect.stringMatching(/old format/) });
    const parsed = legacyAnswers(def);
    expect(parsed).not.toBeNull();
    const state = { answers: parsed! };
    expect(state.answers.connections).toEqual([
      { platform: "google-drive", name: "Studio Drive" },
      { platform: "google-docs", name: "Studio Docs" },
      { platform: "open-router", name: "Studio OpenRouter" },
      { platform: "notion", name: "Studio Notion" },
    ]);
    expect(state.answers.purpose).toBe("This agent will help us with our recruitment process.");
    expect(state.answers.mayDo).toBe(
      "This agent will review all the candidates inside this Notion database: https://app.notion.com/p/3e26?v=3e26&source=copy_link\n\nThen review the candidate’s résumé and provide feedback.\n\nLastly, create a doc that has the following: \n- Full transcript of the interview\n- Link to the candidate's resume",
    );
    expect(state.answers.mustNever).toBe("Assume.");
  });

  it("does not offer to edit a hand-written definition, since saving would replace what HQ cannot read", async () => {
    const { agentEditState, findAgent, legacyAnswers } = await import("@/lib/server/agents");
    fs.writeFileSync(path.join(josRoot, ".claude", "agents", "one_handwritten.md"), "---\nname: one_handwritten\ndescription: Written by hand.\n---\n\n## What you may do with them\nRead.\n");
    const def = findAgent("One", "one_handwritten")!;
    expect(agentEditState(def)).toMatchObject({ editable: false, reason: expect.stringMatching(/old format/) });
    expect(legacyAnswers(def)).toBeNull();
  });

  it("does not offer to edit a definition outside the Orchestrator-level agent folders", async () => {
    const { agentEditState, draftAgentDefinition, findAgent } = await import("@/lib/server/agents");
    const d = draftAgentDefinition({ workspace: "One", name: "fixture", ...answers() });
    fs.writeFileSync(path.join(extraDir, "one_fixture.md"), d.content);
    expect(agentEditState(findAgent("One", "one_fixture")!)).toMatchObject({ editable: false, reason: expect.stringMatching(/outside/) });
  });
});

describe("editing an agent", () => {
  it("rewrites the same file from the new answers, keeps its name, and archives the previous version", async () => {
    const { agentEditState, draftAgentEdit, findAgent, updateAgentDefinition } = await import("@/lib/server/agents");
    const agent = await hqAgent("Studio");
    const before = fs.readFileSync(agent.file, "utf8");
    const state = agentEditState(agent);
    const next = answers({ mustNever: "Email or message a candidate.", connections: [{ platform: "notion", name: "Studio Notion" }, { platform: "google-drive", name: "Studio Drive" }] });

    const draft = draftAgentEdit("Studio", agent.key, next);
    const r = updateAgentDefinition("Studio", agent.key, next, state.hash);

    expect(r).toMatchObject({ updated: true, name: agent.key, file: agent.file });
    expect(draft).toMatchObject({ name: agent.key, file: agent.file });
    expect(fs.readFileSync(agent.file, "utf8")).toBe(draft.content);
    expect(fs.readFileSync(agent.sopFile!, "utf8")).toBe(draft.sop);
    expect(agentEditState(findAgent("Studio", agent.key)!)).toMatchObject({ editable: true, answers: next });
    const archived = fs.readdirSync(historyDir()).filter((f) => f.startsWith(`${agent.key}.`) && f.endsWith(".before-edit"));
    expect(archived).toHaveLength(1);
    expect(fs.readFileSync(path.join(historyDir(), archived[0], path.basename(agent.file)), "utf8")).toBe(before);
  });

  it("refuses when the file changed after it was loaded, and leaves it as it is", async () => {
    const { agentEditState, updateAgentDefinition } = await import("@/lib/server/agents");
    const agent = await hqAgent("One");
    const { hash } = agentEditState(agent);
    const theirs = fs.readFileSync(agent.file, "utf8").replace("Screens applicants.", "Screens applicants, edited elsewhere.");
    fs.writeFileSync(agent.file, theirs);

    expect(updateAgentDefinition("One", agent.key, answers({ purpose: "Mine." }), hash)).toEqual({ updated: false, reason: "changed" });
    expect(fs.readFileSync(agent.file, "utf8")).toBe(theirs);
  });

  it.each(["executing", "awaiting_approval", "needs_clarification", "interrupted", "needs_reconciliation"])("refuses while one of its tasks is %s, and leaves the file as it is", async (status) => {
    const { agentEditState, updateAgentDefinition } = await import("@/lib/server/agents");
    const agent = await hqAgent("Studio");
    const before = fs.readFileSync(agent.file, "utf8");
    const task = await agentTask("Studio", agent.key, status);

    expect(updateAgentDefinition("Studio", agent.key, answers({ purpose: "Changed." }), agentEditState(agent).hash)).toEqual({ updated: false, reason: "busy", tasks: [{ id: task.id, title: task.title, status }] });
    expect(fs.readFileSync(agent.file, "utf8")).toBe(before);
  });

  it("ignores a busy task that belongs to another agent of the same name in the other workspace", async () => {
    const { agentEditState, updateAgentDefinition } = await import("@/lib/server/agents");
    const agent = await hqAgent("One");
    await agentTask("Studio", agent.key, "executing");
    expect(updateAgentDefinition("One", agent.key, answers({ purpose: "Changed." }), agentEditState(agent).hash)).toMatchObject({ updated: true });
  });

  it("refuses a definition it cannot edit", async () => {
    const { agentEditState, findAgent, updateAgentDefinition } = await import("@/lib/server/agents");
    fs.writeFileSync(path.join(josRoot, ".claude", "agents", "one_handwritten2.md"), "---\nname: one_handwritten2\n---\n\nRead only.\n");
    const agent = findAgent("One", "one_handwritten2")!;
    expect(updateAgentDefinition("One", agent.key, answers(), agentEditState(agent).hash)).toMatchObject({ updated: false, reason: "read_only" });
    expect(fs.readFileSync(agent.file, "utf8")).toBe("---\nname: one_handwritten2\n---\n\nRead only.\n");
  });

  it("still requires both questions answered", async () => {
    const { agentEditState, updateAgentDefinition } = await import("@/lib/server/agents");
    const agent = await hqAgent("One");
    const { hash } = agentEditState(agent);
    expect(() => updateAgentDefinition("One", agent.key, answers({ connections: [] }), hash)).toThrow(/Question 1/);
    expect(() => updateAgentDefinition("One", agent.key, answers({ mustNever: " " }), hash)).toThrow(/Question 2/);
  });

  it("reports an agent that no longer exists", async () => {
    const { updateAgentDefinition } = await import("@/lib/server/agents");
    expect(updateAgentDefinition("One", "one_nobody", answers(), "x")).toEqual({ updated: false, reason: "not_found" });
  });
});

describe("deleting an agent", () => {
  it("moves the file into agent-history, deletes its conversations, and keeps its tasks and the logs", async () => {
    const { createConversation, deleteAgentDefinition, findAgent, listConversations } = await import("@/lib/server/agents");
    const { all, get, run } = await import("@/lib/server/db");
    const agent = await hqAgent("Studio");
    const other = await hqAgent("Studio");
    const content = fs.readFileSync(agent.file, "utf8");
    const conv = createConversation("Studio", agent.key, "Screen Tuesday's applicants");
    const kept = createConversation("Studio", other.key, "Other agent's thread");
    const task = await agentTask("Studio", agent.key, "completed");
    run("INSERT INTO agent_messages(id, conversation_id, role, content, task_id, created_at) VALUES ('amsg_t1', ?, 'user', 'go', ?, ?)", [conv.id, task.id, new Date().toISOString()]);
    const log = path.join(josRoot, "STUDIOMEMORY.md");
    const logText = `# Studio log\n\n## 2026-09-24 · Screen <!-- jos:run=${task.id} -->\n\n- **Status:** done\n`;
    fs.writeFileSync(log, logText);

    const r = deleteAgentDefinition("Studio", agent.key);

    expect(r).toMatchObject({ deleted: true, conversations: 1 });
    expect(fs.existsSync(agent.file)).toBe(false);
    expect(findAgent("Studio", agent.key)).toBeNull();
    if (!r.deleted) return;
    expect(path.dirname(r.archived)).toBe(historyDir());
    expect(path.basename(r.archived)).toMatch(new RegExp(`^${agent.key}\\..+\\.deleted$`));
    expect(fs.readFileSync(path.join(r.archived, path.basename(agent.file)), "utf8")).toBe(content);
    expect(listConversations("Studio", agent.key)).toEqual([]);
    expect(all("SELECT id FROM agent_messages WHERE conversation_id = ?", [conv.id])).toEqual([]);
    expect(listConversations("Studio", other.key).map((c) => c.id)).toEqual([kept.id]);
    expect(get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", [task.id])?.status).toBe("completed");
    expect(fs.readFileSync(log, "utf8")).toBe(logText);
  });

  it.each(["executing", "awaiting_approval", "interrupted"])("refuses while one of its tasks is %s, and changes nothing", async (status) => {
    const { createConversation, deleteAgentDefinition, listConversations } = await import("@/lib/server/agents");
    const agent = await hqAgent("One");
    createConversation("One", agent.key);
    const task = await agentTask("One", agent.key, status);

    expect(deleteAgentDefinition("One", agent.key)).toEqual({ deleted: false, reason: "busy", tasks: [{ id: task.id, title: task.title, status }] });
    expect(fs.existsSync(agent.file)).toBe(true);
    expect(listConversations("One", agent.key)).toHaveLength(1);
  });

  it("refuses while an executor process of a finished task may still be alive", async () => {
    const { deleteAgentDefinition } = await import("@/lib/server/agents");
    const { run } = await import("@/lib/server/db");
    const agent = await hqAgent("One");
    const task = await agentTask("One", agent.key, "failed");
    run(
      `INSERT INTO executions(id, task_id, phase, workspace, cwd, adapter, runtime, binary, model, effort, pid, status, created_at)
       VALUES (?, ?, 'execute', 'One', 'x', 'claude', 'claude', 'claude.exe', 'claude-opus-5', 'medium', 4242, 'running', ?)`,
      [`exec_${task.id}`, task.id, new Date().toISOString()],
    );
    expect(deleteAgentDefinition("One", agent.key)).toMatchObject({ deleted: false, reason: "busy" });
    expect(fs.existsSync(agent.file)).toBe(true);
  });

  it("refuses a definition outside the Orchestrator-level agent folders", async () => {
    const { deleteAgentDefinition, draftAgentDefinition } = await import("@/lib/server/agents");
    const d = draftAgentDefinition({ workspace: "One", name: "fixture two", ...answers() });
    const file = path.join(extraDir, "one_fixture_two.md");
    fs.writeFileSync(file, d.content);
    expect(deleteAgentDefinition("One", "one_fixture_two")).toMatchObject({ deleted: false, reason: "read_only" });
    expect(fs.existsSync(file)).toBe(true);
  });

  it("reports an agent that no longer exists", async () => {
    const { deleteAgentDefinition } = await import("@/lib/server/agents");
    expect(deleteAgentDefinition("Studio", "studio_nobody")).toEqual({ deleted: false, reason: "not_found" });
  });

  it("drops a result that arrives after its conversation was deleted, rather than leave orphan messages", async () => {
    const { recordAgentTaskResult } = await import("@/lib/server/agents");
    const { all } = await import("@/lib/server/db");
    recordAgentTaskResult("conv_gone", "jos_gone", "completed", "Done.");
    expect(all("SELECT id FROM agent_messages WHERE conversation_id = 'conv_gone'")).toEqual([]);
  });
});
