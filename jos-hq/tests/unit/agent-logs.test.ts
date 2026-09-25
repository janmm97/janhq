import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-agent-logs-"));
const josRoot = path.join(tmp, "JOS");
for (const d of ["One", "Studio", ".claude/agents", ".codex/agents/studio_notes"]) fs.mkdirSync(path.join(josRoot, d), { recursive: true });
process.env.JOS_HQ_JOS_ROOT = josRoot;
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
const logs = path.join(josRoot, ".codex", "agents", "studio_notes", "LOGS.md");
fs.writeFileSync(logs, "# studio_notes — agent log\n");

describe("agent LOGS.md", () => {
  it("opens and closes one entry per task, with the central log named", async () => {
    const { openLogEntry, closeLogEntry } = await import("@/lib/server/logs");
    await openLogEntry({ taskId: "jos_1", file: logs, title: "Notes", asked: "Summarize the notes", extra: [{ label: "Central log", text: "STUDIOMEMORY.md" }] });
    await openLogEntry({ taskId: "jos_1", file: logs, title: "Notes", asked: "Summarize the notes" }); // a retry
    await closeLogEntry({ taskId: "jos_1", file: logs, status: "done", outcome: "Page p_1 created", artifacts: "notion p_1", learned: "Use the Meetings database", extra: [{ label: "Actions", text: "Create page: succeeded" }, { label: "Open", text: null }] });
    const text = fs.readFileSync(logs, "utf8");
    expect(text.match(/jos:run=jos_1/g)).toHaveLength(1);
    expect(text).toContain("- **Central log:** STUDIOMEMORY.md");
    expect(text).toContain("- **Actions:** Create page: succeeded");
    expect(text).not.toContain("**Open:**");
    expect(text).toMatch(/- \*\*Status:\*\* done/);
    expect(text).not.toContain("**Route:**");
  });

  it("concurrent agent log writes: none lost, none duplicated", async () => {
    const { openLogEntry } = await import("@/lib/server/logs");
    await Promise.all(Array.from({ length: 6 }, (_, i) => openLogEntry({ taskId: `jos_c${i}`, file: logs, title: `C${i}`, asked: `Concurrent ${i}` })));
    await Promise.all(Array.from({ length: 6 }, (_, i) => openLogEntry({ taskId: `jos_c${i}`, file: logs, title: `C${i}`, asked: `Concurrent ${i}` })));
    const text = fs.readFileSync(logs, "utf8");
    for (let i = 0; i < 6; i++) expect(text.match(new RegExp(`jos:run=jos_c${i} `, "g"))).toHaveLength(1);
  });

  it("strips secrets, and refuses a LOGS.md outside the agent folders", async () => {
    const { openLogEntry, logPath } = await import("@/lib/server/logs");
    await openLogEntry({ taskId: "jos_s", file: logs, title: "Secret", asked: "Use key sk-ant-abcdefghijklmnop123 for it" });
    expect(fs.readFileSync(logs, "utf8")).not.toContain("sk-ant-abcdefghijklmnop123");
    const stray = path.join(josRoot, "One", "LOGS.md");
    fs.writeFileSync(stray, "x");
    expect(() => logPath(stray)).toThrow(/not a J\/OS log/);
    expect(() => logPath(path.join(josRoot, "..", "ONEMEMORY.md"))).toThrow(/not a J\/OS log/);
  });
});
