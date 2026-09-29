import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { onlyCommandsAllows } from "../../gateway/lib/commands.mjs";
import { hasAmbiguousSegment, validatePattern, writeDenied } from "../../gateway/lib/write-globs.mjs";

const GUARD = path.resolve(import.meta.dirname, "../../gateway/claude-guard.mjs");
let server: http.Server;
let url = "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "guard-outside-"));

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  fs.writeFileSync(path.join(outside, "secret.txt"), "shh\n");
  fs.mkdirSync(path.join(dir, "jos-hq", "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "jos-hq", "lib", "x.ts"), "x\n");
  // Junctions need no privilege on Windows; elsewhere "junction" is ignored and a dir symlink is made.
  fs.symlinkSync(outside, path.join(dir, "jos-hq", "jx"), "junction");
});
afterAll(() => {
  server.close();
  try {
    fs.unlinkSync(path.join(dir, "jos-hq", "jx"));
  } catch {
    /* already gone */
  }
});

function guard(policyExtra: Record<string, unknown>, command: string): Promise<string> {
  return guardTool(policyExtra, "Bash", { command });
}

function guardTool(policyExtra: Record<string, unknown>, tool: string, toolInput: Record<string, unknown>): Promise<string> {
  return new Promise((resolve) => {
    const policy = { executionId: "e1", workspace: "gh", workspaceRoot: dir, requiredEffort: "medium", allowLocalWrites: true, mode: "edit", ...policyExtra };
    const file = path.join(dir, `policy-${Math.random()}.json`);
    fs.writeFileSync(file, JSON.stringify(policy));
    const child = spawn(process.execPath, [GUARD], {
      env: { ...process.env, JOS_HQ_POLICY_FILE: file, JOS_HQ_EXECUTION_ID: "e1", JOS_HQ_SERVER: url, JOS_HQ_GATEWAY_NONCE: "n" },
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", () => {
      const result = stdout ? JSON.parse(stdout).hookSpecificOutput?.permissionDecision ?? "allow" : "allow";
      resolve(result);
    });
    child.stdin.write(JSON.stringify({ tool_name: tool, tool_input: toolInput, effort: { level: "medium" }, cwd: dir }));
    child.stdin.end();
  });
}

describe("claude-guard agent policy", () => {
  it("leaves HQ policies unchanged: one is allowed without denyOne", async () => {
    expect(await guard({}, "one --agent connection list")).toBe("allow");
  });
  it("denies one and jos-approved when denyOne is set", async () => {
    expect(await guard({ denyOne: true }, "one --agent connection list")).toBe("deny");
    expect(await guard({ denyOne: true }, "cd x && jos-approved run 1")).toBe("deny");
  });
  it("does not deny a mere mention of one", async () => {
    expect(await guard({ denyOne: true }, "grep -r 'one' lib")).toBe("allow");
  });
  it("denies denyCommands matches, case-insensitively", async () => {
    const denyCommands = ["\\bgit\\s+push\\b", "\\bcurl\\b"];
    expect(await guard({ denyCommands }, "GIT PUSH origin x")).toBe("deny");
    expect(await guard({ denyCommands }, "curl https://x")).toBe("deny");
    expect(await guard({ denyCommands }, "git status")).toBe("allow");
  });
  it("denies quoted command names with denyOne", async () => {
    expect(await guard({ denyOne: true }, '"one" --agent connection list')).toBe("deny");
    expect(await guard({ denyOne: true }, "'one' --agent connection list")).toBe("deny");
  });
  it("denies PowerShell call operator with denyOne", async () => {
    expect(await guard({ denyOne: true }, '& "one" --agent connection list')).toBe("deny");
  });
  it("denies commands with path and extension", async () => {
    expect(await guard({ denyOne: true }, "C:\\x\\one.cmd --agent x")).toBe("deny");
  });
  it("denies quoted paths with spaces", async () => {
    expect(await guard({ denyOne: true }, '"C:\\Program Files\\x\\one.cmd" x')).toBe("deny");
  });
  it("allows log commands and echo arguments", async () => {
    expect(await guard({ denyOne: true }, "git log --oneline")).toBe("allow");
    expect(await guard({ denyOne: true }, 'echo someone')).toBe("allow");
  });
  it("denies invalid denyCommands pattern with error", async () => {
    const result = await guard({ denyCommands: ["("] }, "echo test");
    expect(result).toBe("deny");
  });
  it("does not hang on commands with many slashes (regex backtracking regression)", async () => {
    // Regression test: ensure catastrophic backtracking doesn't occur
    // Input with 200 slashes followed by non-matching command should complete quickly
    const longSlashCommand = "a/".repeat(200) + "X";
    const startTime = Date.now();
    const result = await guard({ denyOne: true }, longSlashCommand);
    const duration = Date.now() - startTime;
    expect(result).toBe("allow");
    expect(duration).toBeLessThan(5000); // Must complete in under 5 seconds
  });
});

describe("claude-guard confineReads", () => {
  const outside = path.join(os.tmpdir(), "elsewhere", "secret.txt");
  it("leaves HQ policies unchanged: reads outside the workspace are allowed without confineReads", async () => {
    expect(await guardTool({}, "Read", { file_path: outside })).toBe("allow");
    expect(await guardTool({}, "Grep", { pattern: "x", path: "C:/" })).toBe("allow");
  });
  it("denies Read, Grep, Glob and NotebookRead paths outside the workspace", async () => {
    const p = { confineReads: true };
    expect(await guardTool(p, "Read", { file_path: outside })).toBe("deny");
    expect(await guardTool(p, "Read", { file_path: "../x.txt" })).toBe("deny");
    expect(await guardTool(p, "Grep", { pattern: "x", path: path.dirname(dir) })).toBe("deny");
    expect(await guardTool(p, "Glob", { pattern: "*.ts", path: "C:/Users" })).toBe("deny");
    expect(await guardTool(p, "Glob", { pattern: "C:/Users/**/*.txt" })).toBe("deny");
    expect(await guardTool(p, "Glob", { pattern: "../../**" })).toBe("deny");
    expect(await guardTool(p, "NotebookRead", { notebook_path: outside })).toBe("deny");
  });
  it("allows reads inside the workspace, and Glob/Grep without a path", async () => {
    const p = { confineReads: true };
    expect(await guardTool(p, "Read", { file_path: path.join(dir, "jos-hq", "x.ts") })).toBe("allow");
    expect(await guardTool(p, "Read", { file_path: "jos-hq/x.ts" })).toBe("allow");
    expect(await guardTool(p, "Grep", { pattern: "x" })).toBe("allow");
    expect(await guardTool(p, "Glob", { pattern: "jos-hq/**/*.ts" })).toBe("allow");
    expect(await guardTool(p, "Grep", { pattern: "x", path: "jos-hq/lib" })).toBe("allow");
  });
});

describe("claude-guard denyWriteGlobs", () => {
  const globs = [".git", "node_modules", "package.json", "package-lock.json", ".npmrc", ".gitattributes", ".gitmodules", "tsconfig*.json", "*.config.*"];
  it("leaves HQ policies unchanged without denyWriteGlobs", async () => {
    expect(await guardTool({}, "Write", { file_path: "jos-hq/package.json" })).toBe("allow");
  });
  it.each([
    ".git",
    ".git/config",
    "jos-hq/node_modules/x/index.js",
    "jos-hq/package.json",
    "jos-hq/PACKAGE-LOCK.JSON",
    "jos-hq/.npmrc",
    ".gitattributes",
    "jos-hq/.gitmodules",
    "jos-hq/tsconfig.json",
    "jos-hq/tsconfig.e2e.json",
    "jos-hq/vitest.config.mts",
    "jos-hq/playwright.config.ts",
    "jos-hq/next.config.ts",
    "jos-hq/postcss.config.mjs",
  ])("denies writing %s", async (rel) => {
    expect(await guardTool({ denyWriteGlobs: globs }, "Write", { file_path: rel })).toBe("deny");
    expect(await guardTool({ denyWriteGlobs: globs }, "Edit", { file_path: path.join(dir, rel) })).toBe("deny");
  });
  it.each(["jos-hq/lib/server/x.ts", "jos-hq/tests/unit/config.test.ts", "jos-hq/lib/package.ts", "jos-hq/tsconfig.ts", "jos-hq/.gitignore"])("allows writing %s", async (rel) => {
    expect(await guardTool({ denyWriteGlobs: globs }, "Write", { file_path: rel })).toBe("allow");
  });
  it("root patterns (/name) match only the whole relative path", async () => {
    const g = ["/.gitignore", ".claude", "claude*.md", "agents.md", ".mcp.json"];
    for (const rel of [".gitignore", ".claude/settings.json", "jos-hq/.claude/settings.local.json", "jos-hq/lib/CLAUDE.md", "jos-hq/CLAUDE.local.md", "jos-hq/x/AGENTS.md", "jos-hq/.mcp.json"]) {
      expect(await guardTool({ denyWriteGlobs: g }, "Write", { file_path: rel }), rel).toBe("deny");
    }
    for (const rel of ["jos-hq/.gitignore", "jos-hq/lib/claude.ts", "jos-hq/docs/agents.txt"]) {
      expect(await guardTool({ denyWriteGlobs: g }, "Write", { file_path: rel }), rel).toBe("allow");
    }
  });
});

describe("claude-guard NTFS stream and trailing-dot spellings", () => {
  const globs = ["package.json", "claude*.md", ".npmrc"];
  it.each(["jos-hq/package.json::$DATA", "jos-hq/sub/CLAUDE.md::$DATA", "jos-hq/.npmrc::$DATA", "jos-hq/lib/x.ts:evil", "jos-hq/package.json.", "jos-hq/package.json ", "jos-hq/lib./x.ts"])(
    "denies %j under an agent policy",
    async (rel) => {
      expect(await guardTool({ denyWriteGlobs: globs }, "Write", { file_path: rel })).toBe("deny");
      expect(await guardTool({ onlyCommands: ["jos-check"] }, "Edit", { file_path: path.join(dir, rel) })).toBe("deny");
    },
  );
  it("leaves HQ policies unchanged", async () => {
    expect(await guardTool({}, "Write", { file_path: "jos-hq/lib/x.ts." })).toBe("allow");
  });
});

describe("write-deny pattern validation", () => {
  it.each(["/", "//", "/*.json", "/a\\b", "a/b", "a\\b"])("rejects %j (and the guard fails closed)", async (p) => {
    expect(() => validatePattern(p)).toThrow();
    expect(() => writeDenied("jos-hq/x.ts", [p])).toThrow();
    expect(await guardTool({ denyWriteGlobs: [p] }, "Write", { file_path: "jos-hq/x.ts" })).toBe("deny");
  });
  it.each(["/.gitignore", "/jos-hq/.npmrc", "tsconfig*.json", ".claude"])("accepts %j", (p) => {
    expect(() => validatePattern(p)).not.toThrow();
  });
  it("hasAmbiguousSegment", () => {
    expect(hasAmbiguousSegment("a/b.ts")).toBe(false);
    expect(hasAmbiguousSegment("a/b.ts::$DATA")).toBe(true);
    expect(hasAmbiguousSegment("a./b")).toBe(true);
    expect(hasAmbiguousSegment("a/b ")).toBe(true);
  });
});

describe("writeDenied", () => {
  it("matches segment globs at any depth and root patterns only at the root, case-insensitively", () => {
    expect(writeDenied("jos-hq/tsconfig.e2e.json", ["tsconfig*.json"])).toBe(true);
    expect(writeDenied(".GITIGNORE", ["/.gitignore"])).toBe(true);
    expect(writeDenied("jos-hq/.gitignore", ["/.gitignore"])).toBe(false);
    expect(writeDenied("jos-hq/scripts/public/README.md", ["/jos-hq/scripts/public/"])).toBe(true);
    expect(writeDenied("JOS-HQ/Scripts/Public", ["/jos-hq/scripts/public/"])).toBe(true);
    expect(writeDenied("jos-hq/scripts/publicity.md", ["/jos-hq/scripts/public/"])).toBe(false);
    expect(writeDenied("jos-hq/public/x.png", ["/jos-hq/scripts/public/"])).toBe(false);
    expect(writeDenied("jos-hq/scripts/public/x", ["/jos-hq/scripts/public"])).toBe(false);
    expect(writeDenied("jos-hq\\lib\\x.ts", ["x.ts"])).toBe(true);
    expect(writeDenied("jos-hq/lib/x.ts", ["", 3 as unknown as string])).toBe(false);
  });
});

const bash = (p: Record<string, unknown>, command: string) => guardTool(p, "Bash", { command });

describe("onlyCommandsAllows", () => {
  const names = ["jos-check"];
  it.each(["jos-check test jos-hq/tests/unit/a.test.ts", "jos-check typecheck", "  jos-check status  ", "jos-check log -n 5", "jos-check diff --stat", "jos-check"])("allows %s", (c) => {
    expect(onlyCommandsAllows(c, names)).toBe(true);
  });
  it.each([
    "jos-check test x; rm -rf .",
    "jos-check $(x)",
    "jos-check `whoami`",
    "jos-check test `x`",
    "jos-check status\ngit push",
    "jos-check status\r\nx",
    "jos-check status && x",
    "jos-check status | x",
    "jos-check status > x",
    "jos-check status < x",
    "jos-check 'x'",
    'jos-check "x"',
    "jos-check (x)",
    "jos-check  status",
    "jos-check\tstatus",
    "jos-checkx status",
    "xjos-check status",
    "./jos-check status",
    "git status",
    "npx vitest",
    "",
  ])("denies %j", (c) => {
    expect(onlyCommandsAllows(c, names)).toBe(false);
  });
  it("refuses a malformed name list (fails closed)", () => {
    expect(onlyCommandsAllows("jos-check status", ["jos.*"])).toBe(false);
    expect(onlyCommandsAllows("jos-check status", "jos-check" as unknown as string[])).toBe(false);
    expect(onlyCommandsAllows("jos-check status", [])).toBe(false);
  });
  it("runs in linear time on adversarial 10,000-character input", () => {
    const inputs = [
      "jos-check " + "a ".repeat(5000) + "$",
      "jos-check " + "a".repeat(10_000) + ";",
      "jos-check" + " a".repeat(4999) + " $",
      "jos-check " + "-".repeat(10_000) + "`",
      " ".repeat(10_000),
      "jos-check " + "a/".repeat(5000) + "\nx",
    ];
    for (const s of inputs) {
      const t0 = performance.now();
      expect(onlyCommandsAllows(s, names)).toBe(false);
      expect(performance.now() - t0, JSON.stringify(s.slice(0, 20))).toBeLessThan(50);
    }
  });
});

describe("claude-guard onlyCommands", () => {
  const p = { onlyCommands: ["jos-check"] };
  it("allows the named command with plain arguments, in Bash and PowerShell", async () => {
    expect(await bash(p, "jos-check test jos-hq/tests/unit/a.test.ts")).toBe("allow");
    expect(await guardTool(p, "PowerShell", { command: "jos-check typecheck" })).toBe("allow");
  });
  it.each(["jos-check test x; rm", "jos-check $(x)", "jos-check `x`", "jos-check status\ngit push", "git status", "npx vitest"])("denies %j", async (c) => {
    expect(await bash(p, c)).toBe("deny");
    expect(await guardTool(p, "PowerShell", { command: c })).toBe("deny");
  });
  it("is checked before denyCommands, and denyCommands still applies after it", async () => {
    expect(await bash({ ...p, denyCommands: ["status"] }, "jos-check status")).toBe("deny");
  });
  it("leaves HQ policies unchanged when the field is absent", async () => {
    expect(await bash({}, "git status && npx vitest run")).toBe("allow");
  });
});

describe("claude-guard realpath boundary", () => {
  const through = path.join(dir, "jos-hq", "jx", "secret.txt");
  it("denies a read through a junction to outside the workspace", async () => {
    const r = { confineReads: true };
    expect(await guardTool(r, "Read", { file_path: through })).toBe("deny");
    expect(await guardTool(r, "Read", { file_path: "jos-hq/jx/secret.txt" })).toBe("deny");
    expect(await guardTool(r, "Read", { file_path: "jos-hq/jx/not-there/x.txt" })).toBe("deny");
    expect(await guardTool(r, "Grep", { pattern: "shh", path: "jos-hq/jx" })).toBe("deny");
    expect(await guardTool(r, "Glob", { pattern: "jos-hq/jx/**/*.txt" })).toBe("deny");
    expect(await guardTool(r, "Glob", { pattern: "*.txt", path: "jos-hq/jx" })).toBe("deny");
  });
  it("still allows normal reads inside the workspace, existing or not, and plain globs", async () => {
    const r = { confineReads: true };
    expect(await guardTool(r, "Read", { file_path: "jos-hq/lib/x.ts" })).toBe("allow");
    expect(await guardTool(r, "Read", { file_path: path.join(dir, "jos-hq", "lib", "new", "y.ts") })).toBe("allow");
    expect(await guardTool(r, "Glob", { pattern: "jos-hq/**/*.ts" })).toBe("allow");
    expect(await guardTool(r, "Grep", { pattern: "x" })).toBe("allow");
  });
  it("denies a write through a junction when denyWriteGlobs or onlyCommands is set", async () => {
    for (const w of [{ denyWriteGlobs: [".git"] }, { onlyCommands: ["jos-check"] }]) {
      expect(await guardTool(w, "Write", { file_path: "jos-hq/jx/new.txt" })).toBe("deny");
      expect(await guardTool(w, "Edit", { file_path: through })).toBe("deny");
      expect(await guardTool(w, "Write", { file_path: "jos-hq/lib/new/y.ts" })).toBe("allow");
      expect(await guardTool(w, "Edit", { file_path: "jos-hq/lib/x.ts" })).toBe("allow");
    }
  });
  it("applies denyWriteGlobs to the resolved path too", async () => {
    fs.mkdirSync(path.join(dir, "jos-hq", "node_modules", "pkg"), { recursive: true });
    const alias = path.join(dir, "jos-hq", "nm-alias");
    fs.symlinkSync(path.join(dir, "jos-hq", "node_modules"), alias, "junction");
    try {
      expect(await guardTool({ denyWriteGlobs: ["node_modules"] }, "Write", { file_path: "jos-hq/nm-alias/pkg/index.js" })).toBe("deny");
    } finally {
      fs.unlinkSync(alias);
    }
  });
  it("leaves HQ policies unchanged: no realpath check without the fields", async () => {
    expect(await guardTool({}, "Read", { file_path: through })).toBe("allow");
    expect(await guardTool({}, "Write", { file_path: "jos-hq/jx/new.txt" })).toBe("allow");
  });
});
