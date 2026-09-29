import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-agent-sop-"));
const josRoot = path.join(tmp, "JOS");
for (const d of ["One", "Studio", ".claude/agents", ".codex/agents"]) fs.mkdirSync(path.join(josRoot, d), { recursive: true });
process.env.JOS_HQ_JOS_ROOT = josRoot;
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");

const answers = { connections: [{ platform: "notion", name: "Studio Notion" }], purpose: "Screens applicants.", mayDo: "Read the candidates database.", mustNever: "Email a candidate." };
let seq = 0;
async function make(workspace: "One" | "Studio") {
  const { createAgentDefinition, findAgent } = await import("@/lib/server/agents");
  const r = createAgentDefinition({ workspace, name: `screener ${++seq}`, ...answers });
  return findAgent(workspace, r.name)!;
}

describe("creating an agent writes a minimal definition, SOP.md and an empty LOGS.md", () => {
  it.each(["One", "Studio"] as const)("for %s", async (ws) => {
    const a = await make(ws);
    const folder = path.join(path.dirname(a.file), a.key);
    expect(a).toMatchObject({ format: "sop", sopFile: path.join(folder, "SOP.md"), logsFile: path.join(folder, "LOGS.md"), sopError: null });
    const def = fs.readFileSync(a.file, "utf8");
    expect(def).toContain(`agents/${a.key}/SOP.md`);
    expect(def).not.toContain("## Purpose");
    expect(def).toContain(ws === "One" ? "model: claude-opus-5-5" : 'model = "gpt-6-sol"');
    const sop = fs.readFileSync(a.sopFile!, "utf8");
    expect(sop).toContain("<!-- jos:sop v1 -->");
    for (const h of ["## Purpose", "## Allowed connections", "## What you may do with them", "## What you must never do", "## Guardrails (set by the J/OS Orchestrator)", "## How you work", "## What you return", "## Verification"]) expect(sop).toContain(h);
    expect(fs.readFileSync(a.logsFile!, "utf8")).toMatch(/agent log/);
    expect(a.instructions).toBe(sop.trim());
    expect(a.allowedConnections).toEqual(answers.connections);
  });

  it("refuses a name whose folder already exists, and leaves both alone", async () => {
    const { createAgentDefinition } = await import("@/lib/server/agents");
    const folder = path.join(josRoot, ".codex", "agents", "studio_taken");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "SOP.md"), "theirs");
    expect(() => createAgentDefinition({ workspace: "Studio", name: "taken", ...answers })).toThrow(/already exists/);
    expect(fs.readFileSync(path.join(folder, "SOP.md"), "utf8")).toBe("theirs");
    expect(fs.existsSync(path.join(josRoot, ".codex", "agents", "studio_taken.toml"))).toBe(false);
  });
});

describe("discovery and SOP safety", () => {
  it("reports a missing SOP instead of running without instructions", async () => {
    const { findAgent } = await import("@/lib/server/agents");
    const a = await make("Studio");
    fs.rmSync(a.sopFile!);
    expect(findAgent("Studio", a.key)).toMatchObject({ format: "sop", instructions: "", sopError: expect.stringMatching(/SOP\.md is missing or unreadable/) });
  });

  it("refuses unsafe paths: a bad name, a folder that is a link, a definition outside the agent folders", async () => {
    const { agentPaths } = await import("@/lib/server/agent-files");
    expect(agentPaths(path.join(josRoot, ".claude", "agents", "one_Bad-Name.md"))).toMatchObject({ ok: false, error: expect.stringMatching(/not a valid agent name/) });
    expect(agentPaths(path.join(josRoot, "One", "one_x.md"))).toMatchObject({ ok: false, error: expect.stringMatching(/not directly inside an agent folder/) });
    const target = fs.mkdtempSync(path.join(tmp, "elsewhere-"));
    const link = path.join(josRoot, ".claude", "agents", "one_linked");
    fs.symlinkSync(target, link, "junction");
    expect(agentPaths(`${link}.md`)).toMatchObject({ ok: false, error: expect.stringMatching(/is a link/) });
  });

  it("hand-edited SOP: runs as written, but Edit is refused when HQ cannot reproduce the answers", async () => {
    const { agentEditState, findAgent } = await import("@/lib/server/agents");
    const a = await make("One");
    fs.writeFileSync(a.sopFile!, fs.readFileSync(a.sopFile!, "utf8").replace("## What you must never do\n", "## What you must never do\n(hand note)\n"));
    const again = findAgent("One", a.key)!;
    expect(again.instructions).toContain("(hand note)");
    expect(agentEditState(again)).toMatchObject({ editable: true });
    fs.writeFileSync(a.sopFile!, "# mine\n\nFree-form instructions.\n");
    expect(agentEditState(findAgent("One", a.key)!)).toMatchObject({ editable: false, reason: expect.stringMatching(/not written by HQ/) });
  });
});

describe("editing and deleting", () => {
  it("edit rewrites SOP.md, keeps LOGS.md, updates the description and archives both files first", async () => {
    const { agentEditState, findAgent, updateAgentDefinition } = await import("@/lib/server/agents");
    const a = await make("Studio");
    fs.appendFileSync(a.logsFile!, "\n## 2026-09-24 · kept <!-- jos:run=jos_k -->\n");
    const logsBefore = fs.readFileSync(a.logsFile!, "utf8");
    const sopBefore = fs.readFileSync(a.sopFile!, "utf8");
    const r = updateAgentDefinition("Studio", a.key, { ...answers, purpose: "Screens applicants for Studio." }, agentEditState(a).hash);
    expect(r).toMatchObject({ updated: true });
    expect(fs.readFileSync(a.sopFile!, "utf8")).toContain("Screens applicants for Studio.");
    expect(fs.readFileSync(a.file, "utf8")).toContain("Screens applicants for Studio.");
    expect(fs.readFileSync(a.logsFile!, "utf8")).toBe(logsBefore);
    if (!r.updated) return;
    expect(fs.readFileSync(path.join(r.archived, "SOP.md"), "utf8")).toBe(sopBefore);
    expect(fs.existsSync(path.join(r.archived, path.basename(a.file)))).toBe(true);
    expect(agentEditState(findAgent("Studio", a.key)!)).toMatchObject({ editable: true, answers: { ...answers, purpose: "Screens applicants for Studio." } });
  });

  it("an edit elsewhere to SOP.md changes the hash, so a stale form is refused", async () => {
    const { agentEditState, updateAgentDefinition } = await import("@/lib/server/agents");
    const a = await make("One");
    const { hash } = agentEditState(a);
    fs.appendFileSync(a.sopFile!, "\n");
    expect(updateAgentDefinition("One", a.key, answers, hash)).toEqual({ updated: false, reason: "changed" });
  });

  it("delete archives the definition and the whole folder, LOGS.md included, and frees the name", async () => {
    const { createAgentDefinition, deleteAgentDefinition } = await import("@/lib/server/agents");
    const a = await make("Studio");
    fs.appendFileSync(a.logsFile!, "\n## 2026-09-24 · history <!-- jos:run=jos_h -->\n");
    const r = deleteAgentDefinition("Studio", a.key);
    expect(r).toMatchObject({ deleted: true });
    if (!r.deleted) return;
    expect(fs.existsSync(a.file)).toBe(false);
    expect(fs.existsSync(path.dirname(a.sopFile!))).toBe(false);
    expect(path.basename(r.archived)).toMatch(new RegExp(`^${a.key}\\..+\\.deleted$`));
    expect(fs.readFileSync(path.join(r.archived, a.key, "LOGS.md"), "utf8")).toContain("jos:run=jos_h");
    const again = createAgentDefinition({ workspace: "Studio", name: a.key.replace(/^studio_/, ""), ...answers });
    expect(fs.readFileSync(path.join(path.dirname(again.file), again.name, "LOGS.md"), "utf8")).not.toContain("jos_h");
  });
});
