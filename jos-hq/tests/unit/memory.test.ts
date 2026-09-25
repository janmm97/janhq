import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-memory-"));
const josRoot = path.join(tmp, "JOS");
process.env.JOS_HQ_JOS_ROOT = josRoot;
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
fs.mkdirSync(josRoot, { recursive: true });
const log = (name: string, text: string) => {
  fs.writeFileSync(path.join(josRoot, name), text);
  return path.join(josRoot, name);
};

async function hqLog(name: string, entries: Array<{ id: string; title: string; asked: string; status: "done" | "blocked" | "partial" | "abandoned" | null; outcome?: string; at: string }>) {
  const { openLogEntry, closeLogEntry } = await import("@/lib/server/logs");
  log(name, `# ${name}\n\n---\n`);
  for (const e of entries) {
    await openLogEntry({ taskId: e.id, file: name, title: e.title, asked: e.asked, route: "Studio — test", at: new Date(e.at) });
    if (e.status) await closeLogEntry({ taskId: e.id, file: name, status: e.status, outcome: e.outcome ?? `${e.title} outcome`, artifacts: "none", learned: `${e.title} lesson` });
  }
  return path.join(josRoot, name);
}

describe("reading the logs", () => {
  it("parses HQ-written entries: date, title, task id, status and bullets", async () => {
    const { parseLogEntries } = await import("@/lib/server/memory");
    const file = await hqLog("STUDIOMEMORY.md", [{ id: "jos_a", title: "Weekly scorecard email", asked: "Draft the weekly scorecard summary email for the team from the KPI sheet", status: "done", outcome: "Draft d_1 created", at: "2026-09-20T12:00:00Z" }]);
    const [e] = parseLogEntries(fs.readFileSync(file, "utf8"), file);
    expect(e).toMatchObject({ date: "2026-09-20", title: "Weekly scorecard email", taskId: "jos_a", status: "done", outcome: "Draft d_1 created", learned: "Weekly scorecard email lesson" });
    expect(e.asked).toContain("KPI sheet");
  });

  it("tolerates odd logs: CRLF, hand-written entries, --- separators, a missing Status", async () => {
    const { parseLogEntries } = await import("@/lib/server/memory");
    const text = "# Log\r\n\r\n## 2026-09-22 · Hand written\r\n\r\n- **Status:** done — fine\r\n- **Asked:** Something long enough to matter here\r\n  and continued\r\n\r\n---\r\n\r\n## No date heading\r\n\r\nfree text\r\n";
    const entries = parseLogEntries(text, "x.md");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ date: "2026-09-22", title: "Hand written", taskId: null, status: "done", asked: "Something long enough to matter here and continued" });
    expect(entries[1]).toMatchObject({ date: null, title: "No date heading", status: "", asked: "" });
  });

  it("strips HQ's own suffixes from the Asked line", async () => {
    const { cleanAsked } = await import("@/lib/server/memory");
    expect(cleanAsked('Please proceed. (continues "Meeting notes", HQ task jos_1)')).toBe("Please proceed.");
    expect(cleanAsked("Review the candidates Earlier in this conversation (for context only): Operator: hi")).toBe("Review the candidates");
  });
});

describe("matching a new request", () => {
  it("matches a reworded repeat", async () => {
    const { findMatches, parseLogEntries } = await import("@/lib/server/memory");
    const file = await hqLog("STUDIOMEMORY.md", [{ id: "jos_a", title: "Scorecard email", asked: "Draft the weekly scorecard summary email for the team from the KPI sheet", status: "done", at: "2026-09-20T12:00:00Z" }]);
    const m = findMatches("Draft weekly scorecard summary email for the team using the KPI sheet", parseLogEntries(fs.readFileSync(file, "utf8"), file), null);
    expect(m.map((x) => x.entry.taskId)).toEqual(["jos_a"]);
    expect(m[0].score).toBeGreaterThanOrEqual(0.75);
  });

  it.each([
    ["a different person", "Send the Q3 revenue report summary email to Riley today", "Send the Q3 revenue report summary email to Owen today"],
    ["a different number", "Create invoices for the 12 new enterprise customers in Stripe", "Create invoices for the 15 new enterprise customers in Stripe"],
    ["a different email", "Forward the signed contract to devin@example.com and file it", "Forward the signed contract to max@example.com and file it"],
    ["a different quoted name", 'Rename the Notion page "Q3 Plan" and archive the old copy', 'Rename the Notion page "Q4 Plan" and archive the old copy'],
  ])("never matches %s", async (_label, before, now) => {
    const { findMatches, parseLogEntries } = await import("@/lib/server/memory");
    const file = await hqLog("ONEMEMORY.md", [{ id: "jos_b", title: "Before", asked: before, status: "done", at: "2026-09-20T12:00:00Z" }]);
    expect(findMatches(now, parseLogEntries(fs.readFileSync(file, "utf8"), file), null)).toEqual([]);
  });

  it("never matches a short follow-up, or the task's own entry", async () => {
    const { findMatches, parseLogEntries } = await import("@/lib/server/memory");
    const file = await hqLog("ONEMEMORY.md", [
      { id: "jos_c", title: "Proceed", asked: "Please proceed.", status: "done", at: "2026-09-20T12:00:00Z" },
      { id: "jos_self", title: "Self", asked: "Summarize the Notion meeting notes for this week", status: null, at: "2026-09-21T12:00:00Z" },
    ]);
    const entries = parseLogEntries(fs.readFileSync(file, "utf8"), file);
    expect(findMatches("Please proceed.", entries, null)).toEqual([]);
    expect(findMatches("Summarize the Notion meeting notes for this week", entries, "jos_self")).toEqual([]);
  });
});

describe("deciding", () => {
  const req = "Summarize the Notion meeting notes for this week into one page";
  it("reuses the newest close match when it ended done", async () => {
    const { decide, findMatches, readEntries } = await import("@/lib/server/memory");
    const file = await hqLog("STUDIOMEMORY.md", [
      { id: "jos_old", title: "Notes v1", asked: req, status: "blocked", at: "2026-09-18T12:00:00Z" },
      { id: "jos_new", title: "Notes v2", asked: req, status: "done", at: "2026-09-21T12:00:00Z" },
    ]);
    const d = decide(findMatches(req, readEntries([file]), null));
    expect(d.kind).toBe("reuse");
    if (d.kind !== "reuse") return;
    expect(d.match.entry.taskId).toBe("jos_new");
    expect(d.lessons.map((l) => l.entry.taskId)).toEqual(["jos_old"]);
  });

  it("plans again when a newer similar task failed after an older success", async () => {
    const { decide, findMatches, readEntries, renderLessons } = await import("@/lib/server/memory");
    const file = await hqLog("STUDIOMEMORY.md", [
      { id: "jos_ok", title: "Notes ok", asked: req, status: "done", at: "2026-09-18T12:00:00Z" },
      { id: "jos_bad", title: "Notes bad", asked: req, status: "partial", outcome: "Vertex rejected temperature", at: "2026-09-22T12:00:00Z" },
    ]);
    const d = decide(findMatches(req, readEntries([file]), null));
    expect(d.kind).toBe("plan");
    expect(renderLessons(d.lessons)).toContain("Vertex rejected temperature");
  });

  it("plans when nothing matches", async () => {
    const { decide } = await import("@/lib/server/memory");
    expect(decide([])).toEqual({ kind: "plan", lessons: [] });
  });

  it("looks in the route's log, JOSMEMORY.md and the agent's log", async () => {
    const { logSources } = await import("@/lib/server/memory");
    expect(logSources("Studio", "C:\\a\\LOGS.md")).toEqual([path.join(josRoot, "STUDIOMEMORY.md"), path.join(josRoot, "JOSMEMORY.md"), "C:\\a\\LOGS.md"]);
    expect(logSources("One", null)).toEqual([path.join(josRoot, "ONEMEMORY.md"), path.join(josRoot, "JOSMEMORY.md")]);
  });
});

describe("agent history for a prompt", () => {
  it("always includes unfinished work, then the newest, then related older entries, within the budget", async () => {
    const { agentHistory } = await import("@/lib/server/memory");
    const entries = Array.from({ length: 12 }, (_, i) => ({
      id: `jos_${i}`,
      title: `Task ${i}`,
      asked: i === 11 ? "Review the ecommerce candidates interviews and write feedback docs" : `Unrelated chore number ${i} about invoices and receipts`,
      status: (i === 1 ? "blocked" : "done") as "done" | "blocked",
      at: `2026-09-${String(10 + i).padStart(2, "0")}T12:00:00Z`,
    }));
    // Opened oldest first, as HQ would have: each new entry goes on top, so the file ends newest first.
    const file = await hqLog("STUDIOMEMORY.md", entries);
    const text = agentHistory(file, "Review the ecommerce candidates interviews again", "jos_none", 6000)!;
    expect(text).toContain("Unfinished (open, blocked or partial):");
    expect(text).toContain("Task 1 [blocked]");
    expect(text).toContain("Most recent:");
    expect(text).toContain("Task 11");
    expect(text).toContain(`Older entries: ${file}`);
    expect(agentHistory(file, "x", null, 400)!.length).toBeLessThan(700);
  });
});
