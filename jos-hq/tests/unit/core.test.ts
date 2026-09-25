import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Point HQ at a throwaway J/OS root so no real log is touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-test-"));
const josRoot = path.join(tmp, "JOS");
beforeAll(() => {
  fs.mkdirSync(path.join(josRoot, "One"), { recursive: true });
  fs.mkdirSync(path.join(josRoot, "Studio"), { recursive: true });
  fs.writeFileSync(path.join(josRoot, "ONEMEMORY.md"), "# J/OS — One session log\n\nWork routed to `One/`. Newest entry first.\n\n---\n\n## 2026-09-22 · Older entry\n\n- **Status:** done\n- **Asked:** older\n");
  fs.writeFileSync(path.join(josRoot, "STUDIOMEMORY.md"), "# Studio — session log\n\n**Note.**\n\n---\n");
  fs.writeFileSync(path.join(josRoot, "JOSMEMORY.md"), "# J/OS — Orchestrator session log\n\nWork that routes nowhere.\n\n## 2026-09-23 · Something\n\n- **Status:** done\n");
});
process.env.JOS_HQ_JOS_ROOT = josRoot;
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");

describe("two-phase Markdown logging", () => {
  it("opens newest-first with a stable anchor, then closes THE SAME entry in place", async () => {
    const { openLogEntry, closeLogEntry, appendLogNote } = await import("@/lib/server/logs");
    await openLogEntry({ taskId: "jos_T1", file: "ONEMEMORY.md", title: "Email Devin the MSA", asked: "Email Devin the signed MSA", route: "One — Named entity: Devin" });
    let text = fs.readFileSync(path.join(josRoot, "ONEMEMORY.md"), "utf8");
    const iNew = text.indexOf("<!-- jos:run=jos_T1 -->");
    const iOld = text.indexOf("Older entry");
    expect(iNew).toBeGreaterThan(text.indexOf("---"));
    expect(iNew).toBeLessThan(iOld);
    expect(text).toMatch(/## \d{4}-\d{2}-\d{2} · Email Devin the MSA <!-- jos:run=jos_T1 -->/);
    expect(text).toContain("- **Status:** in progress");
    await appendLogNote("jos_T1", "ONEMEMORY.md", "Approval requested", "1 action: send email");
    await closeLogEntry({ taskId: "jos_T1", file: "ONEMEMORY.md", status: "done", outcome: "Verified Complete: sent, id 18c", artifacts: "message 18c", learned: "nothing" });
    text = fs.readFileSync(path.join(josRoot, "ONEMEMORY.md"), "utf8");
    expect(text.match(/jos:run=jos_T1/g)?.length).toBe(1);
    expect(text).not.toContain("- **Status:** in progress");
    const entry = text.slice(text.indexOf("jos:run=jos_T1"), text.indexOf("Older entry"));
    expect(entry).toContain("- **Status:** done");
    expect(entry.indexOf("Approval requested")).toBeLessThan(entry.indexOf("- **Outcome:**"));
    for (const k of ["Outcome", "Artifacts", "Learned", "Closed"]) expect(entry).toContain(`- **${k}:**`);
    // The older entry is untouched.
    expect(text).toContain("## 2026-09-22 · Older entry\n\n- **Status:** done\n- **Asked:** older");
  });

  it("is idempotent on open and never writes a second close-out", async () => {
    const { openLogEntry, closeLogEntry } = await import("@/lib/server/logs");
    await openLogEntry({ taskId: "jos_T2", file: "STUDIOMEMORY.md", title: "t", asked: "a", route: "Studio — x" });
    await openLogEntry({ taskId: "jos_T2", file: "STUDIOMEMORY.md", title: "t", asked: "a", route: "Studio — x" });
    await closeLogEntry({ taskId: "jos_T2", file: "STUDIOMEMORY.md", status: "partial", outcome: "o", artifacts: "none", learned: "l" });
    const r = await closeLogEntry({ taskId: "jos_T2", file: "STUDIOMEMORY.md", status: "done", outcome: "reconciled", artifacts: "none", learned: "l" });
    const text = fs.readFileSync(path.join(josRoot, "STUDIOMEMORY.md"), "utf8");
    expect(text.match(/jos:run=jos_T2/g)?.length).toBe(1);
    expect(text.match(/- \*\*Closed:\*\*/g)?.length).toBe(1);
    expect(r.alreadyClosed).toBe(true);
    expect(text).toContain("- **Reconciled:**");
  });

  it("redacts secrets and refuses non-log files", async () => {
    const { openLogEntry, logPath } = await import("@/lib/server/logs");
    await openLogEntry({ taskId: "jos_T3", file: "JOSMEMORY.md", title: "key test", asked: "use sk_live_abcdefghijklmnop and Bearer abcdefghijklmnopqrstuvwxyz", route: "none" });
    const text = fs.readFileSync(path.join(josRoot, "JOSMEMORY.md"), "utf8");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(() => logPath("CLAUDE.md")).toThrow();
  });

  it("serializes concurrent writers without losing entries", async () => {
    const { openLogEntry } = await import("@/lib/server/logs");
    await Promise.all(Array.from({ length: 8 }, (_, i) => openLogEntry({ taskId: `jos_C${i}`, file: "JOSMEMORY.md", title: `c${i}`, asked: "a", route: "none" })));
    const text = fs.readFileSync(path.join(josRoot, "JOSMEMORY.md"), "utf8");
    for (let i = 0; i < 8; i++) expect(text).toContain(`jos:run=jos_C${i} -->`);
  });
});

describe("identity gate", () => {
  const base = (over: Record<string, unknown>) => ({
    scope: "One" as const,
    cwd: path.join(josRoot, "One"),
    ok: true,
    projectRoot: path.join(josRoot, "One"),
    configPath: path.join(os.homedir(), ".one", "projects", path.join(josRoot, "One").replace(/[\\/:]/g, "-"), "config.json"),
    configScope: "project",
    email: "one-operator@example.com",
    name: "Jan",
    orgName: "One",
    orgId: "x",
    keyName: "k",
    error: null,
    checkedAt: new Date().toISOString(),
    ...over,
  });

  it("passes only when projectRoot AND email match", async () => {
    const { evaluateIdentity } = await import("@/lib/server/identity");
    expect(evaluateIdentity("One", base({})).ok).toBe(true);
    const wrongEmail = evaluateIdentity("One", base({ email: "studio-owner@example.com" }));
    expect(wrongEmail.ok).toBe(false);
    expect(wrongEmail.problems.join(" ")).toMatch(/expected one-operator@example\.com/);
  });

  it("detects a workspace that lost its own config and inherits the root", async () => {
    const { evaluateIdentity } = await import("@/lib/server/identity");
    const v = evaluateIdentity("One", base({ projectRoot: josRoot }));
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/inheriting the root/);
  });

  it("rejects a fallback to the global config even when projectRoot looks right", async () => {
    const { evaluateIdentity } = await import("@/lib/server/identity");
    const v = evaluateIdentity("One", base({ configScope: "global", configPath: path.join(os.homedir(), ".one", "config.json") }));
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/global config/);
  });

  it("org is informational: Studio has none by design; an org mismatch warns, never passes a wrong email", async () => {
    const { evaluateIdentity } = await import("@/lib/server/identity");
    const s = base({ scope: "Studio", projectRoot: path.join(josRoot, "Studio"), cwd: path.join(josRoot, "Studio"), configPath: path.join(os.homedir(), ".one", "projects", path.join(josRoot, "Studio").replace(/[\\/:]/g, "-"), "config.json"), email: "studio-owner@example.com", orgName: null });
    expect(evaluateIdentity("Studio", s as never).ok).toBe(true);
    const withOrg = evaluateIdentity("Studio", { ...(s as object), orgName: "One" } as never);
    expect(withOrg.ok).toBe(true);
    expect(withOrg.warnings.length).toBe(1);
  });
});

describe("dispatch target validation", () => {
  it("allows only JOS/One and JOS/Studio and refuses executor origins", async () => {
    const { validateDispatchTarget, DispatchError } = await import("@/lib/server/dispatch");
    expect(validateDispatchTarget({ workspace: "One", origin: { kind: "hq" } })).toBe("One");
    expect(validateDispatchTarget({ workspace: "Studio", origin: { kind: "cli", cwd: josRoot } })).toBe("Studio");
    for (const bad of ["root", "JOS", "", "..\\One", "C:\\Windows", "one"]) {
      expect(() => validateDispatchTarget({ workspace: bad, origin: { kind: "hq" } })).toThrow(DispatchError);
    }
    expect(() => validateDispatchTarget({ workspace: "One", origin: { kind: "cli", cwd: path.join(josRoot, "Studio", "Tasks") } })).toThrow(/inside the Studio executor workspace/);
    expect(() => validateDispatchTarget({ workspace: "One", origin: { kind: "cli", cwd: os.tmpdir() } })).toThrow(/outside the J\/OS root/);
    expect(() => validateDispatchTarget({ workspace: "Studio", origin: { kind: "cli", executorExecutionId: "exe_1" } })).toThrow(/inside an executor session/);
  });
});

describe("secret redaction", () => {
  it("redacts credentials but keeps connection keys", async () => {
    const { redactSecrets, redactDeep } = await import("@/lib/server/util/redact");
    const s = redactSecrets('apiKey="sk_live_1234567890abcdef" auth: Bearer abcdefghijklmnopqrstuvwxyz0123 key live::gmail::default::800e41d2 sk-or-v1-abcdefghijklmnopqrstuv');
    expect(s).not.toMatch(/1234567890abcdef|abcdefghijklmnopqrstuvwxyz0123|abcdefghijklmnopqrstuv/);
    expect(s).toContain("live::gmail::default::800e41d2");
    expect(redactDeep({ nested: { apiKey: "plain-secret-value", ok: "fine" } })).toEqual({ nested: { apiKey: "***REDACTED***", ok: "fine" } });
  });

  it("flags a proposed payload that carries a credential, and leaves ordinary payloads alone", async () => {
    const { containsSecret } = await import("@/lib/server/util/redact");
    expect(containsSecret({ to: "devin@x", subject: "MSA", body: "Attached is the signed MSA." })).toBe(false);
    expect(containsSecret({ connectionKey: "live::gmail::default::75dd6874", to: "operator@example.com" })).toBe(false);
    expect(containsSecret(null)).toBe(false);
    expect(containsSecret({ body: "the key is sk_live_1234567890abcdef" })).toBe(true);
    expect(containsSecret({ headers: { password: "hunter2hunter2" } })).toBe(true);
  });
});

describe("runtime version ordering", () => {
  it("orders prerelease builds the way the Codex resolver needs", async () => {
    const { compareSemver } = await import("@/lib/server/executors/resolve");
    expect(compareSemver("0.147.0", "0.155.0-alpha.2.6")).toBeLessThan(0);
    expect(compareSemver("0.155.0-alpha.16", "0.155.0-alpha.2.6")).toBeGreaterThan(0);
    expect(compareSemver("0.155.0", "0.155.0-alpha.16")).toBeGreaterThan(0);
    expect(compareSemver("0.154.0-alpha.6.1", "0.155.0-alpha.2.6")).toBeLessThan(0);
    expect(compareSemver("0.155.0-alpha.2.6", "0.155.0-alpha.2.6")).toBe(0);
  });
});

describe("executor result contract", () => {
  it("coerces a valid result and rejects an invalid one", async () => {
    const { coerceResult } = await import("@/lib/server/executors/result-schema");
    const ok = coerceResult({ status: "completed", answer: "a", summary: "s", identity_check: { project_root: "x", email: "y", passed: true }, proposed_actions: [], artifacts: [], verification: { performed: true, passed: true, method: "m", evidence: "e" }, limitations: [], learned: [], needs_user_input: "" });
    expect(ok.ok).toBe(true);
    expect(coerceResult({ status: "done" }).ok).toBe(false);
    expect(coerceResult(null).ok).toBe(false);
  });
});
