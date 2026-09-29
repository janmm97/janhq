import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-agent-migrate-"));
const josRoot = path.join(tmp, "JOS");
for (const d of ["One", "Studio", ".claude/agents", ".codex/agents"]) fs.mkdirSync(path.join(josRoot, d), { recursive: true });
process.env.JOS_HQ_JOS_ROOT = josRoot;
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");

// The shape of studio_hr_assistant_agent.toml as HQ wrote it on 2026-09-23 (triple-quoted, trimmed).
const HR = `name = "studio_hr_example"
description = "This agent will help us with our recruitment process."
model = "gpt-6-sol"
model_reasoning_effort = "medium"
developer_instructions = """
You are studio_hr_example, a Studio sub-agent of J/OS. You run inside the Studio executor, rooted in JOS/Studio/, and you execute; you never delegate or start other agent sessions.

## Purpose
This agent will help us with our recruitment process.

## Allowed connections
- google-drive · "Studio Drive"
- notion · "Studio Notion"
Use no other connection. Resolve each connection's key live with \`one --agent connection list\`, from JOS/Studio/ only.

## What you may do with them
Review the candidates in Notion and write "feedback" docs.

## What you must never do
Assume.

## Guardrails (set by the J/OS Orchestrator)
- Identity first: before anything else run \`one --agent config path\` and \`one --agent whoami\`; projectRoot must end in \\JOS\\Studio and the account must be studio-owner@example.com. If not, stop and report.
"""
`;
const hrFile = path.join(josRoot, ".codex", "agents", "studio_hr_example.toml");

describe("migrating an old-format agent", () => {
  it("keeps the instructions word for word, the connections, name, model and effort, and the conversations", async () => {
    fs.writeFileSync(hrFile, HR);
    const { createConversation, findAgent, listConversations, migrateAgentDefinitions, agentEditState, parseSimpleToml } = await import("@/lib/server/agents");
    const conv = createConversation("Studio", "studio_hr_example", "Screen Tuesday's applicants");
    const r = migrateAgentDefinitions();
    expect(r).toContainEqual(expect.objectContaining({ name: "studio_hr_example", status: "migrated" }));
    const a = findAgent("Studio", "studio_hr_example")!;
    expect(a.format).toBe("sop");
    expect(a.instructions).toContain('Review the candidates in Notion and write "feedback" docs.');
    expect(a.instructions).toContain("projectRoot must end in \\JOS\\Studio");
    expect(a.allowedConnections).toEqual([{ platform: "google-drive", name: "Studio Drive" }, { platform: "notion", name: "Studio Notion" }]);
    const t = parseSimpleToml(fs.readFileSync(hrFile, "utf8"));
    expect(t).toMatchObject({ name: "studio_hr_example", model: "gpt-6-sol", model_reasoning_effort: "medium", description: "This agent will help us with our recruitment process." });
    expect(agentEditState(a)).toMatchObject({ editable: true, answers: { mustNever: "Assume." } });
    expect(listConversations("Studio", "studio_hr_example").map((c) => c.id)).toEqual([conv.id]);
    expect(fs.readdirSync(path.join(tmp, "data", "agent-history")).some((f) => f.startsWith("studio_hr_example.") && f.endsWith(".before-migrate.toml"))).toBe(true);
  });

  it("is a no-op the second time", async () => {
    const { migrateAgentDefinitions } = await import("@/lib/server/agents");
    const before = fs.readFileSync(hrFile, "utf8");
    expect(migrateAgentDefinitions()).toContainEqual(expect.objectContaining({ name: "studio_hr_example", status: "skipped", detail: expect.stringMatching(/already/) }));
    expect(fs.readFileSync(hrFile, "utf8")).toBe(before);
  });

  it("stops on a folder collision without overwriting anything", async () => {
    const file = path.join(josRoot, ".claude", "agents", "one_collide.md");
    fs.writeFileSync(file, "---\nname: one_collide\ndescription: d\nmodel: claude-opus-5\n---\n\n## Purpose\nx\n");
    const { migrateAgentDefinitions } = await import("@/lib/server/agents");
    // A folder that already exists (here empty) is never overwritten: that agent is left exactly as it is.
    fs.mkdirSync(path.join(josRoot, ".claude", "agents", "one_collide_2"));
    const file2 = path.join(josRoot, ".claude", "agents", "one_collide_2.md");
    fs.writeFileSync(file2, "---\nname: one_collide_2\ndescription: d\nmodel: claude-opus-5\n---\n\n## Purpose\nx\n");
    const r = migrateAgentDefinitions();
    expect(r).toContainEqual(expect.objectContaining({ name: "one_collide", status: "migrated" }));
    expect(r).toContainEqual(expect.objectContaining({ name: "one_collide_2", status: "skipped", detail: expect.stringMatching(/not overwritten/) }));
    expect(fs.readFileSync(file2, "utf8")).toContain("## Purpose");
    expect(fs.readdirSync(path.join(josRoot, ".claude", "agents", "one_collide_2"))).toEqual([]);
  });

  it("rolls back a failure partway: no new folder, the definition untouched", async () => {
    const file = path.join(josRoot, ".claude", "agents", "one_fragile.md");
    const content = "---\nname: one_fragile\ndescription: d\nmodel: claude-opus-5\n---\n\n## Purpose\nFragile.\n";
    fs.writeFileSync(file, content);
    const { migrateAgentDefinitions } = await import("@/lib/server/agents");
    const r = migrateAgentDefinitions({
      beforeDefinitionRewrite: (n) => {
        if (n === "one_fragile") throw new Error("disk full");
      },
    });
    expect(r).toContainEqual(expect.objectContaining({ name: "one_fragile", status: "failed", detail: expect.stringMatching(/disk full/) }));
    expect(fs.existsSync(path.join(josRoot, ".claude", "agents", "one_fragile"))).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(content);
  });
});
