// The executor-side enforcement, exercised as real processes: the HQ One gateway (`one`) and the
// approved-action runner (`jos-approved`), against a stub One CLI and a stub HQ endpoint.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actionPayloadHash } from "../../gateway/lib/canonical.mjs";

const app = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-gw-"));
const ws = path.join(tmp, "JOS", "One");
const elsewhere = path.join(tmp, "elsewhere");
const oneLog = path.join(tmp, "one.log");
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(elsewhere, { recursive: true });

const state = { verified: true, consumed: new Set<string>(), events: [] as unknown[], results: [] as unknown[] };
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.headers["x-jos-gateway-token"] !== "nonce-1") return send(401, { error: "bad nonce" });
      const b = body ? JSON.parse(body) : {};
      if (req.url?.startsWith("/api/internal/gateway/verified")) return send(200, { verified: state.verified, reason: state.verified ? undefined : "launch not verified (test)" });
      if (req.url === "/api/internal/gateway/event") {
        state.events.push(b);
        return send(200, { recorded: true });
      }
      if (req.url === "/api/internal/gateway/consume") {
        const k = `${b.approvalId}:${b.index}`;
        if (state.consumed.has(k)) return send(409, { error: "action already executing; it will not run again" });
        state.consumed.add(k);
        return send(200, { claimed: true });
      }
      if (req.url === "/api/internal/gateway/consume-result") {
        state.results.push(b);
        return send(200, { recorded: true });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
});
afterAll(() => server?.close());
beforeEach(() => {
  fs.writeFileSync(oneLog, "");
  state.verified = true;
  state.events = [];
  state.results = [];
});

const approved = { index: 1, approvalId: "apr_1", kind: "one_action", title: "Send the MSA", platform: "gmail", actionId: "act_send", connectionKey: "live::gmail::default::k1", connectionName: "Main Operator", target: "devin@x", data: { to: "devin@x", subject: "MSA" }, pathVars: null, queryParams: null, flowKey: null, flowInputs: null };

function writePolicy(phase: "plan" | "preview" | "execute", extra: Record<string, unknown> = {}) {
  const file = path.join(tmp, `policy-${phase}.json`);
  const a = { ...approved, payloadHash: actionPayloadHash({ kind: "one_action", platform: "gmail", actionId: "act_send", connectionKey: "live::gmail::default::k1", data: approved.data, pathVars: null, queryParams: null }) };
  fs.writeFileSync(file, JSON.stringify({ version: 1, taskId: "jos_t", executionId: "exe_t", phase, mode: "auto", workspace: "One", workspaceRoot: ws, expectedProjectRoot: ws, expectedEmail: "one-operator@example.com", requiredModel: "claude-opus-5", requiredEffort: "medium", allowLocalWrites: phase !== "plan", allowedConnectionKeys: ["live::gmail::default::k1"], connections: [], approvedActions: phase === "execute" ? [a] : [], ...extra }));
  return file;
}

function run(script: string, args: string[], opts: { phase?: "plan" | "preview" | "execute"; cwd?: string; email?: string; env?: Record<string, string | undefined> } = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    JOS_HQ_POLICY_FILE: writePolicy(opts.phase ?? "preview"),
    JOS_HQ_EXECUTION_ID: "exe_t",
    JOS_HQ_SERVER: `http://127.0.0.1:${port}`,
    JOS_HQ_GATEWAY_NONCE: "nonce-1",
    JOS_HQ_REAL_ONE_CLI: path.join(__dirname, "fixtures", "fake-one.mjs"),
    JOS_HQ_NODE: process.execPath,
    FAKE_ONE_LOG: oneLog,
    FAKE_PROJECT_ROOT: ws,
    FAKE_EMAIL: opts.email ?? "one-operator@example.com",
    ...(opts.env ?? {}),
  };
  // Async spawn: the stub HQ server lives in this process and must keep answering meanwhile.
  return new Promise<{ code: number | null; stdout: string; stderr: string; executed: string }>((resolve) => {
    const child = spawn(process.execPath, [path.join(app, "gateway", script), ...args], { cwd: opts.cwd ?? ws, env: env as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr, executed: fs.readFileSync(oneLog, "utf8") }));
  });
}

const read = ["--agent", "actions", "execute", "gmail", "act_read", "live::gmail::default::k1", "--path-vars", '{"userId":"me"}'];
const write = ["--agent", "actions", "execute", "gmail", "act_send", "live::gmail::default::k1", "-d", '{"to":"devin@x","subject":"MSA"}'];

describe("approved Flow terminal results", () => {
  it.each(["success", "failed", "missing"])("classifies %s instead of the first JSON event", async (status) => {
    const action = { ...approved, approvalId: `flow-${status}`, kind: "one_flow", flowKey: "review", flowInputs: {}, payloadHash: "test" };
    const policy = writePolicy("execute", { approvedActions: [action] });
    const env = { JOS_HQ_POLICY_FILE: policy, FAKE_FLOW_STATUS: status };
    const r = await run("jos-approved.mjs", ["run", "1"], { env });
    expect(r.code).toBe(status === "success" ? 0 : 1);
    expect(state.results).toContainEqual(expect.objectContaining({ outcome: status === "success" ? "succeeded" : status === "failed" ? "failed" : "ambiguous" }));
    const repeated = await run("jos-approved.mjs", ["run", "1"], { env });
    expect(repeated.code).toBe(1);
    expect(repeated.executed.match(/FLOW review/g)).toHaveLength(1);
  });
});

describe("HQ One gateway — PREVIEW phase", () => {
  it("runs a read after classifying it with a dry-run, and reports it as connection use", async () => {
    const r = await run("one-gateway.mjs", read);
    expect(r.code).toBe(0);
    expect(r.executed).toContain("EXECUTED act_read");
    expect(state.events.some((e) => (e as { category?: string }).category === "read")).toBe(true);
  });

  it("refuses an external write and never executes it", async () => {
    const r = await run("one-gateway.mjs", write);
    expect(r.code).toBe(1);
    expect(r.executed).not.toContain("EXECUTED");
    expect(JSON.parse(r.stdout.trim().split("\n").pop()!).error).toMatch(/PREVIEW phase/);
    expect(state.events.some((e) => (e as { decision?: string }).decision === "blocked")).toBe(true);
  });

  it("allows the same write as a --dry-run, and records its payload hash", async () => {
    const r = await run("one-gateway.mjs", [...write, "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.executed).not.toContain("EXECUTED");
    expect(state.events.some((e) => typeof (e as { payloadHash?: string }).payloadHash === "string")).toBe(true);
  });

  it("blocks `one` outside the workspace, where it would resolve another account", async () => {
    const r = await run("one-gateway.mjs", read, { cwd: elsewhere });
    expect(r.code).toBe(1);
    expect(r.executed).toBe("");
    expect(r.stdout).toMatch(/must run from the One workspace/);
  });

  it("blocks platform calls until HQ has verified the launch", async () => {
    state.verified = false;
    const r = await run("one-gateway.mjs", read);
    expect(r.code).toBe(1);
    expect(r.executed).toBe("");
    expect(r.stdout).toMatch(/not verified/);
  });

  it("blocks forbidden and unknown commands, and commands without --agent", async () => {
    expect((await run("one-gateway.mjs", ["--agent", "connection", "delete", "live::gmail::default::k1"])).stdout).toMatch(/irreversible/);
    expect((await run("one-gateway.mjs", ["--agent", "flow", "execute", "welcome"])).stdout).toMatch(/flow executions are side effects/);
    expect((await run("one-gateway.mjs", ["actions", "search", "gmail", "x"])).stdout).toMatch(/--agent/);
    expect((await run("one-gateway.mjs", ["--agent", "frobnicate"])).stdout).toMatch(/fail closed/);
    expect(fs.readFileSync(oneLog, "utf8")).toBe("");
  });

  it("refuses connections that are not this workspace's", async () => {
    const r = await run("one-gateway.mjs", ["--agent", "actions", "execute", "gmail", "act_read", "live::gmail::default::OTHER"]);
    expect(r.code).toBe(1);
    expect(r.executed).toBe("");
  });

  it("fails closed without the HQ environment", async () => {
    const r = await run("one-gateway.mjs", read, { env: { JOS_HQ_GATEWAY_NONCE: undefined } });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/not running under a J\/OS HQ dispatch/);
  });
});

describe("HQ One gateway — PLAN phase (read-only)", () => {
  it("runs a read", async () => {
    const r = await run("one-gateway.mjs", read, { phase: "plan" });
    expect(r.code).toBe(0);
    expect(r.executed).toContain("EXECUTED act_read");
  });

  it("refuses an external write, says planning is read-only, and never executes it", async () => {
    const r = await run("one-gateway.mjs", write, { phase: "plan" });
    expect(r.code).toBe(1);
    expect(r.executed).not.toContain("EXECUTED");
    expect(JSON.parse(r.stdout.trim().split("\n").pop()!).error).toMatch(/PLAN phase: planning is read-only/);
  });

  it("refuses flow runs and local One writes", async () => {
    expect((await run("one-gateway.mjs", ["--agent", "flow", "execute", "welcome"], { phase: "plan" })).stdout).toMatch(/planning is read-only/);
    expect((await run("one-gateway.mjs", ["--agent", "flow", "create", "draft-flow"], { phase: "plan" })).stdout).toMatch(/planning is read-only/);
    expect(fs.readFileSync(oneLog, "utf8")).toBe("");
  });

  it("allows a flow dry-run", async () => {
    const r = await run("one-gateway.mjs", ["--agent", "flow", "execute", "welcome", "--dry-run"], { phase: "plan" });
    expect(r.code).toBe(0);
  });

  it("records which action a knowledge lookup was for", async () => {
    const r = await run("one-gateway.mjs", ["--agent", "actions", "knowledge", "gmail", "conn_mod_def::gmail::send"], { phase: "plan" });
    expect(r.code).toBe(0);
    expect(state.events).toContainEqual(expect.objectContaining({ args: expect.objectContaining({ command: "actions", subcommand: "knowledge", platform: "gmail", actionId: "conn_mod_def::gmail::send" }) }));
  });
});

describe("EXECUTE phase — only approved actions, exactly once", () => {
  it("still refuses a direct external write", async () => {
    const r = await run("one-gateway.mjs", write, { phase: "execute" });
    expect(r.code).toBe(1);
    expect(r.executed).toBe("");
    expect(r.stdout).toMatch(/jos-approved run/);
  });

  it("jos-approved runs the approved payload once and refuses a second run", async () => {
    state.consumed.clear();
    const first = await run("jos-approved.mjs", ["run", "1"], { phase: "execute" });
    expect(first.code).toBe(0);
    expect(first.executed.trim()).toBe('EXECUTED act_send {"to":"devin@x","subject":"MSA"}');
    expect(state.results.at(-1)).toMatchObject({ approvalId: "apr_1", index: 1, outcome: "succeeded" });
    fs.writeFileSync(oneLog, "");
    const second = await run("jos-approved.mjs", ["run", "1"], { phase: "execute" });
    expect(second.code).toBe(1);
    expect(second.executed).toBe("");
    expect(second.stdout).toMatch(/will not run again|Do not retry/);
  });

  it("re-checks identity at the moment of the side effect and blocks a mismatch", async () => {
    state.consumed.clear();
    const r = await run("jos-approved.mjs", ["run", "1"], { phase: "execute", email: "studio-owner@example.com" });
    expect(r.code).toBe(1);
    expect(r.executed).toBe("");
    expect(r.stdout).toMatch(/identity mismatch/);
  });

  it("blocks an approved write when the One CLI falls back to the global config, even with the right projectRoot", async () => {
    state.consumed.clear();
    const r = await run("jos-approved.mjs", ["run", "1"], { phase: "execute", env: { FAKE_CONFIG_SCOPE: "global" } });
    expect(r.code).toBe(1);
    expect(r.executed).toBe("");
    expect(r.stdout).toMatch(/global config/);
    expect(state.results.at(-1)).toMatchObject({ outcome: "blocked" });
  });

  it("has nothing approved in PREVIEW", async () => {
    const r = await run("jos-approved.mjs", ["run", "1"], { phase: "preview" });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/PREVIEW/);
  });
});
