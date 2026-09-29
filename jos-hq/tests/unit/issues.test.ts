import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Submit issue (2026-09-25). A throwaway root, database and config, and a fake One CLI: nothing here can
// reach a real account or repository. The config names a repository that does not exist.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-issues-"));
const josRoot = path.join(tmp, "JOS");
fs.mkdirSync(path.join(josRoot, "One"), { recursive: true });
fs.mkdirSync(path.join(josRoot, "Studio"), { recursive: true });
const cfg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "jos-hq.config.json"), "utf8"));
cfg.root.expectedEmail = "root@invalid.test";
cfg.workspaces.One.expectedEmail = "one@invalid.test";
cfg.workspaces["Studio"].expectedEmail = "two@invalid.test";
cfg.issues = { owner: "example-owner", repo: "example-repo" };
fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify(cfg));
process.env.JOS_HQ_JOS_ROOT = josRoot;
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
process.env.JOS_HQ_CONFIG = path.join(tmp, "config.json");

const h = vi.hoisted(() => ({
  writes: [] as string[][],
  listed: [] as Array<{ body: string; number: number; html_url: string }>,
  writeResult: null as null | { ok: boolean; json: unknown; error?: string },
  identityOk: true,
  unreadable: false,
}));

vi.mock("@/lib/server/one/cli", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/one/cli")>();
  return {
    ...real,
    resolveOneCli: vi.fn(async () => ({ ok: true, shim: "one", cliJs: "cli.js", node: "node", version: "9.9.9" })),
    runOneReadOnly: vi.fn(async (_scope: string, args: string[]) => {
      real.assertReadOnly(args);
      return { ok: true, json: { response: h.listed }, code: 0, stderr: "", durationMs: 1 };
    }),
    runOneIssueWrite: vi.fn(async (args: string[], repo: { owner: string; repo: string }) => {
      real.assertIssueWrite(args, repo);
      h.writes.push(args);
      return { code: 0, stderr: "", durationMs: 1, ...(h.writeResult ?? { ok: true, json: { response: { number: 7, html_url: "https://github.com/example-owner/example-repo/issues/7" } } }) };
    }),
  };
});
vi.mock("@/lib/server/identity", () => ({
  verifyIdentity: vi.fn(async () => ({ ok: h.identityOk, problems: h.identityOk ? [] : ["account email is someone@invalid.test"] })),
}));
vi.mock("@/lib/server/one/discovery", () => {
  const ident = (name: string) => ({ name, ok: true });
  const conns = [
    { platform: "gmail", key: "live::gmail::default::abc123", name: "Acme Support", state: "operational", access: null },
    { platform: "github", key: "live::github::default::def456", name: "hq-github", state: "operational", access: null },
  ];
  return {
    discoverAll: vi.fn(async () => ({
      root: { scope: "root", identity: ident("Robin Example"), connections: conns.slice(1) },
      One: { scope: "One", identity: ident("Robin Example"), connections: h.unreadable ? null : conns.slice(0, 1) },
      "Studio": { scope: "Studio", identity: ident("Quinn Sample"), connections: [] },
    })),
    listConnections: vi.fn(async () => ({ connections: conns, error: null })),
  };
});

async function failedTask(extra: { request?: string; error?: string; status?: string } = {}) {
  const { createTaskRow, updateTask } = await import("@/lib/server/tasks");
  const t = createTaskRow({ chatId: null, origin: "chat", request: extra.request ?? "Email Devin the Q3 notes from Acme Support", mode: "auto", routeSelection: "auto", context: { clarifications: [] } });
  updateTask(t.id, { status: (extra.status ?? "failed") as never, error: extra.error ?? "Send failed for devin@example.com via live::gmail::default::abc123" } as never);
  return t;
}

beforeEach(() => {
  h.writes.length = 0;
  h.listed.length = 0;
  h.writeResult = null;
  h.identityOk = true;
  h.unreadable = false;
});

describe("the public scrubber", () => {
  const terms = {
    people: ["Devin", "Max"],
    companies: ["Northwind Partners", "Studio Publishing"],
    accounts: ["Robin Example"],
    connections: [{ name: "Acme Support", platform: "gmail" }],
    roots: ["C:\\Users\\robin\\Desktop\\JOS"],
  };
  it("replaces people, companies, accounts, emails, connection names and keys, IDs and paths", async () => {
    const { scrubPublic } = await import("@/lib/server/util/public-scrub");
    const out = scrubPublic(
      "Devin's file from Northwind Partners, sent by Robin Example (robin@example.com) through Acme Support live::gmail::default::abc123, org 00000000-0000-4000-8000-000000000001, at C:\\Users\\robin\\Desktop\\JOS\\One\\Tasks and C:\\Users\\robin\\other",
      terms,
    );
    expect(out).toBe(
      "[person] file from [company], sent by [account holder] ([email]) through [gmail connection] [gmail connection], org [id], at JOS\\One\\Tasks and ~\\other",
    );
  });
  it("keeps tool names and ordinary words, and names the client workspace generically", async () => {
    const { scrubPublic } = await import("@/lib/server/util/public-scrub");
    expect(scrubPublic("Same result in Gmail via the One CLI; studio_calendar_agent in JOS/Studio wrote STUDIOMEMORY.md; cost $226.5", terms)).toBe(
      "Same result in Gmail via the One CLI; wsb_calendar_agent in JOS/Workspace B wrote wsbMEMORY.md; cost $226.5",
    );
  });
  it("still removes credentials", async () => {
    const { scrubPublic } = await import("@/lib/server/util/public-scrub");
    expect(scrubPublic("token ghp_abcdefghijklmnopqrstuvwxyz123456", terms)).not.toContain("ghp_abcdefghij");
  });
});

describe("HQ's only write of its own", () => {
  const repo = { owner: "example-owner", repo: "example-repo" };
  const ok = ["--agent", "actions", "execute", "github", "conn_mod_def::GJ3ZOgmKVac::6mksPa9nTK-WqE9cw3w6sg", "live::github::default::x", "--path-vars", JSON.stringify(repo), "-d", "{}"];
  it("accepts exactly the create-issue call on the configured repository", async () => {
    const { assertIssueWrite } = await import("@/lib/server/one/cli");
    expect(() => assertIssueWrite(ok, repo)).not.toThrow();
  });
  it("refuses any other repository, action, platform or extra flag", async () => {
    const { assertIssueWrite } = await import("@/lib/server/one/cli");
    const variants = [
      ok.map((a, i) => (i === 7 ? JSON.stringify({ owner: "someone", repo: "else" }) : a)),
      ok.map((a, i) => (i === 4 ? "conn_mod_def::other" : a)),
      ok.map((a, i) => (i === 3 ? "gmail" : a)),
      [...ok, "--skip-validation"],
    ];
    for (const v of variants) expect(() => assertIssueWrite(v, repo)).toThrow(/refuses/);
  });
  it("is still refused by the read-only gate", async () => {
    const { assertReadOnly } = await import("@/lib/server/one/cli");
    expect(() => assertReadOnly(ok)).toThrow(/refuses/);
  });
});

describe("Submit issue", () => {
  it("drafts a scrubbed report for a failed task", async () => {
    const { draftIssue } = await import("@/lib/server/issues");
    const t = await failedTask();
    const d = await draftIssue(t.id);
    expect(d.repo).toBe("example-owner/example-repo");
    expect(d.title).toMatch(/^\[failed\]/);
    for (const leak of ["Devin", "devin@example.com", "Acme Support", "abc123", "Robin"]) {
      expect(d.title + d.body).not.toContain(leak);
    }
    expect(d.body).toContain("## Error");
    expect(d.body).toContain("[gmail connection]");
  });

  it("drafts nothing when a scope's connection names cannot be read, since they could not be scrubbed", async () => {
    const { draftIssue } = await import("@/lib/server/issues");
    const t = await failedTask();
    h.unreadable = true;
    await expect(draftIssue(t.id)).rejects.toMatchObject({ code: "SCRUB_TERMS_UNAVAILABLE" });
  });

  it("scrubs connection names HQ recorded earlier, even when they are no longer live", async () => {
    const { draftIssue } = await import("@/lib/server/issues");
    const { run } = await import("@/lib/server/db");
    run("INSERT INTO connection_usage(workspace, platform, connection_name, category, decision, created_at) VALUES ('One', 'slack', 'Old Team Chat', 'read', 'allowed', '2026-09-25T00:00:00Z')");
    const t = await failedTask({ error: "posting to Old Team Chat failed" });
    expect((await draftIssue(t.id)).body).toContain("posting to [slack connection] failed");
  });

  it("is offered only for failed and blocked tasks", async () => {
    const { draftIssue } = await import("@/lib/server/issues");
    const t = await failedTask({ status: "completed" });
    await expect(draftIssue(t.id)).rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
  });

  it("files once, with a marker, re-scrubbing the operator's edits", async () => {
    const { fileIssue, filedIssue } = await import("@/lib/server/issues");
    const t = await failedTask();
    const issue = await fileIssue(t.id, { title: "Send failed for Devin", body: "Tried Acme Support" });
    expect(issue).toMatchObject({ number: 7, url: "https://github.com/example-owner/example-repo/issues/7" });
    expect(h.writes).toHaveLength(1);
    const sent = JSON.parse(h.writes[0][9]);
    expect(sent.title).toBe("Send failed for [person]");
    expect(sent.body).toContain("[gmail connection]");
    expect(sent.body).toContain(`<!-- jos-issue:${t.id} -->`);
    expect(filedIssue(t.id)?.number).toBe(7);
    await expect(fileIssue(t.id, { title: "again", body: "again" })).rejects.toMatchObject({ code: "ALREADY_FILED" });
    expect(h.writes).toHaveLength(1);
  });

  it("does not refile when the repository already holds this task's issue", async () => {
    const { fileIssue } = await import("@/lib/server/issues");
    const t = await failedTask();
    h.listed.push({ body: `report\n\n<!-- jos-issue:${t.id} -->`, number: 3, html_url: "https://github.com/example-owner/example-repo/issues/3" });
    expect((await fileIssue(t.id, { title: "x", body: "y" })).number).toBe(3);
    expect(h.writes).toHaveLength(0);
  });

  it("after an unclear failure, finds the issue instead of filing blind, or says it is safe to retry", async () => {
    const { fileIssue } = await import("@/lib/server/issues");
    const t = await failedTask();
    h.writeResult = { ok: false, json: undefined, error: "timed out after 90000 ms" };
    await expect(fileIssue(t.id, { title: "x", body: "y" })).rejects.toMatchObject({ code: "ISSUE_NOT_FILED" });
    const t2 = await failedTask();
    let calls = 0;
    const { runOneReadOnly } = await import("@/lib/server/one/cli");
    vi.mocked(runOneReadOnly).mockImplementation(async () => {
      calls++;
      const response = calls === 1 ? [] : [{ body: `<!-- jos-issue:${t2.id} -->`, number: 9, html_url: "https://github.com/example-owner/example-repo/issues/9" }];
      return { ok: true, json: { response }, code: 0, stderr: "", durationMs: 1 } as never;
    });
    expect((await fileIssue(t2.id, { title: "x", body: "y" })).number).toBe(9);
  });

  it("files nothing when the root's identity check fails", async () => {
    const { fileIssue } = await import("@/lib/server/issues");
    const t = await failedTask();
    h.identityOk = false;
    await expect(fileIssue(t.id, { title: "x", body: "y" })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(h.writes).toHaveLength(0);
  });
});
