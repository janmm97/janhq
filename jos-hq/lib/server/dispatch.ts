// The exclusive dispatch authority. This module is the ONLY code in J/OS that starts an executor.
// It enforces, in code:
//   - the working-directory allow-list: an executor runs in JOS/One or JOS/Studio and nowhere else; the
//     directory is derived from the route, never accepted from a caller;
//   - executor-origin rejection: a request from inside an executor session is refused;
//   - the exact runtime policy: One = Claude Code Opus 5 (medium), Studio = GPT 6 Sol (medium), with no
//     fallback; an unavailable runtime blocks dispatch;
//   - the identity gate: projectRoot + email from the executor's own cwd must match, or dispatch blocks;
//   - launch verification: model, effort and cwd are read back from the runtime's own evidence, and a
//     mismatch kills the process before its first One call can run;
//   - process accounting: every launch has a row, a pid, a final state, and restart reconciliation.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { isWorkspaceId, josRoot, loadConfig, phaseRole, rolePolicy, runsDir, workspaceRoot, type RuntimePolicy, type RuntimeRole, type WorkspaceId } from "./env";
import { all, get, json, parseJson, run } from "./db";
import { emit } from "./events";
import { newId, newToken } from "./util/ids";
import { nowIso } from "./util/time";
import { redactDeep, redactSecrets } from "./util/redact";
import { verifyIdentity, type IdentityVerdict } from "./identity";
import { resolveOneCli } from "./one/cli";
import { listConnections } from "./one/discovery";
import { isPidAlive, killTree, processImageName } from "./proc";
import { ClaudeOneExecutorAdapter, claudePermissions } from "./executors/claude";
import { CodexStudioExecutorAdapter } from "./executors/codex";
import { findRollout, readRolloutContext } from "./executors/rollout";
import type { ExecutorAdapter, ExecutorStreamEvent, ExitInfo, Phase, TaskMode } from "./executors/types";
import { isWithin, samePath } from "../../gateway/lib/paths.mjs";

export class DispatchError extends Error {
  constructor(
    public code:
      | "INVALID_WORKSPACE"
      | "EXECUTOR_ORIGIN"
      | "RUNTIME_UNAVAILABLE"
      | "WORKSPACE_INVALID"
      | "IDENTITY_MISMATCH"
      | "ONE_CLI_UNAVAILABLE"
      | "MODEL_UNVERIFIED"
      | "LAUNCH_FAILED"
      | "WORKSPACE_BUSY"
      | "AGENT_INVALID",
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface ApprovedAction {
  index: number;
  approvalId: string;
  kind: "one_action" | "one_flow";
  title: string;
  platform: string;
  actionId: string | null;
  connectionKey: string | null;
  connectionName: string | null;
  target: string | null;
  data: unknown;
  pathVars: unknown;
  queryParams: unknown;
  flowKey: string | null;
  flowInputs: Record<string, unknown> | null;
  payloadHash: string;
}

export interface DispatchOrigin {
  kind: "hq" | "cli";
  /** Working directory the request came from (CLI clients send theirs). */
  cwd?: string | null;
  /** Set when the requester carries an executor's environment. */
  executorExecutionId?: string | null;
}

export interface DispatchRequest {
  taskId: string;
  workspace: string;
  phase: Phase;
  mode: TaskMode;
  prompt: string;
  approvedActions?: ApprovedAction[];
  extraReadDirs?: string[];
  origin: DispatchOrigin;
  /** An agent task's allowed connection keys; the gateway refuses every other connection. Null: the whole workspace. */
  allowedConnectionKeys?: string[] | null;
}

interface Verification {
  model?: string;
  effort?: string;
  cwd?: string;
  permissionMode?: string;
  ok: boolean | null;
  reason?: string;
  mainModels: Set<string>;
}

interface LiveExecution {
  id: string;
  taskId: string;
  workspace: WorkspaceId;
  phase: Phase;
  adapter: ExecutorAdapter;
  /** The pin this execution must run on: the planner's for PLAN, the executor's otherwise. */
  policy: RuntimePolicy;
  child: ChildProcess | null;
  pid: number | null;
  sessionId: string | null;
  nonceHash: string;
  verify: Verification;
  cancelRequested: boolean;
  waiters: Array<() => void>;
  done: Promise<ExecutionOutcome>;
}

export interface ExecutionOutcome {
  executionId: string;
  status: "exited" | "failed" | "cancelled";
  exit: ExitInfo;
  verification: { ok: boolean | null; model?: string; effort?: string; cwd?: string; reason?: string; mainModels: string[] };
}

const g = globalThis as unknown as { __josLive?: Map<string, LiveExecution>; __josAdapters?: Record<WorkspaceId, ExecutorAdapter> };
function live(): Map<string, LiveExecution> {
  g.__josLive ??= new Map();
  return g.__josLive;
}

export function adapterFor(ws: WorkspaceId): ExecutorAdapter {
  g.__josAdapters ??= { One: new ClaudeOneExecutorAdapter(), "Studio": new CodexStudioExecutorAdapter() };
  return g.__josAdapters[ws];
}

/** The pin a phase runs on: the planner's for PLAN, the executor's otherwise. */
export function phasePolicy(ws: WorkspaceId, phase: Phase): RuntimePolicy {
  return rolePolicy(ws, phaseRole(phase));
}

export function phaseTimeoutMs(phase: Phase): number {
  const l = loadConfig().limits;
  return phase === "plan" ? l.planTimeoutMs : phase === "execute" ? l.executeTimeoutMs : l.previewTimeoutMs;
}

function hashNonce(nonce: string) {
  return createHash("sha256").update(nonce).digest("hex");
}

/** Pure validation of who may dispatch where. Exported for tests. */
export function validateDispatchTarget(req: Pick<DispatchRequest, "workspace" | "origin">): WorkspaceId {
  if (!isWorkspaceId(req.workspace)) {
    throw new DispatchError(
      "INVALID_WORKSPACE",
      `Refusing to dispatch to "${req.workspace}": executors run only in JOS/One or JOS/Studio. The root is the Orchestrator and never an executor.`,
    );
  }
  if (req.origin.executorExecutionId) {
    throw new DispatchError("EXECUTOR_ORIGIN", "Refusing dispatch from inside an executor session: executors execute; they do not become Orchestrators.");
  }
  if (req.origin.cwd) {
    for (const ws of ["One", "Studio"] as WorkspaceId[]) {
      if (isWithin(req.origin.cwd, workspaceRoot(ws))) {
        throw new DispatchError("EXECUTOR_ORIGIN", `Refusing dispatch requested from ${req.origin.cwd}: that is inside the ${ws} executor workspace.`);
      }
    }
    if (!isWithin(req.origin.cwd, josRoot())) {
      throw new DispatchError("EXECUTOR_ORIGIN", `Refusing dispatch requested from ${req.origin.cwd}: outside the J/OS root.`);
    }
  }
  return req.workspace;
}

function latestFailedVerification(ws: WorkspaceId, version: string | null, policy: RuntimePolicy) {
  const row = get<{ ok: number; detail_json: string; created_at: string; version: string | null }>(
    "SELECT ok, detail_json, created_at, version FROM runtime_verifications WHERE workspace = ? AND model = ? AND effort = ? ORDER BY id DESC LIMIT 1",
    [ws, policy.model, policy.effort],
  );
  if (row && !row.ok && row.version === version) return row;
  return null;
}

export function recordRuntimeVerification(input: { workspace: WorkspaceId; adapter: string; binary: string | null; version: string | null; model: string; effort: string; ok: boolean; source: string; executionId: string | null; detail: unknown }) {
  run(
    `INSERT INTO runtime_verifications(workspace, adapter, binary, version, model, effort, ok, source, execution_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.workspace, input.adapter, input.binary, input.version, input.model, input.effort, input.ok ? 1 : 0, input.source, input.executionId, json(input.detail), nowIso()],
  );
}

export interface DispatchResult {
  executionId: string;
  identity: IdentityVerdict;
  done: Promise<ExecutionOutcome>;
}

/**
 * The pinned runtime for `ws` must be installed and must not have failed its latest launch
 * verification. Throws the specific DispatchError otherwise; there is no fallback runtime.
 */
export async function assertRuntimeReady(ws: WorkspaceId, role: RuntimeRole = "executor") {
  const adapter = adapterFor(ws);
  const policy = rolePolicy(ws, role);
  const rt = await adapter.checkAvailability();
  if (!rt.ok) {
    // The resolver's own "<harness> unavailable:" lead-in is dropped so the message says it once.
    const cause = String(rt.error ?? "not found").replace(/^[\w .()-]{1,40} unavailable:\s*/i, "");
    throw new DispatchError("RUNTIME_UNAVAILABLE", `${policy.modelLabel} (${policy.effort}) unavailable: ${cause}`, { candidates: rt.candidates });
  }
  const failed = latestFailedVerification(ws, rt.version, policy);
  if (failed) {
    throw new DispatchError(
      "MODEL_UNVERIFIED",
      `${policy.modelLabel} (${policy.effort}) failed launch verification on ${rt.version} at ${failed.created_at}; dispatch stays blocked until Runtime Health re-verifies it.`,
      { detail: parseJson(failed.detail_json, null) },
    );
  }
  return rt;
}

export async function dispatch(req: DispatchRequest, onEvent?: (e: ExecutorStreamEvent) => void): Promise<DispatchResult> {
  const ws = validateDispatchTarget(req);
  const adapter = adapterFor(ws);
  const policy = phasePolicy(ws, req.phase);
  const system = ws;

  const oneCli = await resolveOneCli();
  if (!oneCli.ok || !oneCli.cliJs) throw new DispatchError("ONE_CLI_UNAVAILABLE", `One CLI unavailable: ${oneCli.error}`);

  const rt = await assertRuntimeReady(ws, phaseRole(req.phase));
  const wsCheck = adapter.verifyWorkspace();
  if (!wsCheck.ok) throw new DispatchError("WORKSPACE_INVALID", `${ws} workspace invalid: ${wsCheck.problem}`);

  const identity = await verifyIdentity(ws);
  emit({
    taskId: req.taskId,
    system,
    type: identity.ok ? "identity_verified" : "identity_mismatch",
    level: identity.ok ? "success" : "error",
    visibility: identity.ok ? "details" : "chat",
    summary: identity.ok
      ? `${ws} identity verified: ${identity.actual.email} · projectRoot ${identity.actual.projectRoot}`
      : `${ws} identity mismatch — dispatch blocked: ${identity.problems.join("; ")}`,
    data: identity,
  });
  if (!identity.ok) {
    throw new DispatchError("IDENTITY_MISMATCH", `${ws} identity mismatch: ${identity.problems.join("; ")}`, { identity });
  }

  const conns = await listConnections(ws);
  const connections = conns.connections ?? [];

  const executionId = newId("exe");
  const runDir = path.join(runsDir(), req.taskId, executionId);
  fs.mkdirSync(runDir, { recursive: true });
  const nonce = newToken();
  const perms = ws === "One" ? claudePermissions(req.mode, req.phase) : { allowLocalWrites: req.phase !== "plan" && (req.mode !== "manual" || req.phase === "execute") };
  const policyDoc = {
    version: 1,
    taskId: req.taskId,
    executionId,
    phase: req.phase,
    mode: req.mode,
    // Flows may contain many individually bounded calls. Their runner must share
    // the executor deadline, not terminate the whole batch after three minutes.
    executionDeadlineMs: Date.now() + phaseTimeoutMs(req.phase),
    workspace: ws,
    workspaceRoot: wsCheck.root,
    expectedProjectRoot: identity.expected.projectRoot,
    expectedEmail: identity.expected.email,
    requiredModel: policy.model,
    requiredEffort: policy.effort,
    allowLocalWrites: perms.allowLocalWrites,
    allowedConnectionKeys: req.allowedConnectionKeys ? connections.filter((c) => req.allowedConnectionKeys!.includes(c.key)).map((c) => c.key) : connections.map((c) => c.key),
    connections: connections.map((c) => ({ key: c.key, platform: c.platform, name: c.name })),
    approvedActions: req.phase === "execute" ? req.approvedActions ?? [] : [],
  };
  const policyPath = path.join(runDir, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(policyDoc, null, 2));
  const promptPath = path.join(runDir, "prompt.md");
  fs.writeFileSync(promptPath, redactSecrets(req.prompt));

  run(
    `INSERT INTO executions(id, task_id, phase, workspace, cwd, adapter, runtime, binary, model, effort, status, gateway_token_hash, policy_path, prompt_path, output_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?)`,
    [
      executionId,
      req.taskId,
      req.phase,
      ws,
      wsCheck.root,
      adapter.id,
      `${policy.runtimeLabel} ${rt.version ?? ""}`.trim(),
      rt.binary ?? "",
      policy.model,
      policy.effort,
      hashNonce(nonce),
      policyPath,
      promptPath,
      path.join(runDir, "stdout.jsonl"),
      nowIso(),
    ],
  );
  emit({
    taskId: req.taskId,
    executionId,
    system,
    type: "executor_starting",
    level: "info",
    visibility: "details",
    summary: `Starting ${ws} executor (${req.phase}) · ${policy.modelLabel} · effort ${policy.effort} · ${rt.source} ${rt.version} · cwd ${wsCheck.root}`,
    data: { binary: rt.binary, version: rt.version, source: rt.source, model: policy.model, effort: policy.effort, cwd: wsCheck.root, phase: req.phase, mode: req.mode },
  });

  const entry: LiveExecution = {
    id: executionId,
    taskId: req.taskId,
    workspace: ws,
    phase: req.phase,
    adapter,
    policy,
    child: null,
    pid: null,
    sessionId: null,
    nonceHash: hashNonce(nonce),
    verify: { ok: null, mainModels: new Set() },
    cancelRequested: false,
    waiters: [],
    done: Promise.resolve(null as unknown as ExecutionOutcome),
  };
  live().set(executionId, entry);

  let handle;
  try {
    handle = await adapter.launch(
      {
        executionId,
        taskId: req.taskId,
        workspace: ws,
        workspaceRoot: wsCheck.root,
        phase: req.phase,
        mode: req.mode,
        prompt: req.prompt,
        runDir,
        policyPath,
        gatewayNonce: nonce,
        realOneCli: oneCli.cliJs,
        timeoutMs: phaseTimeoutMs(req.phase),
        extraReadDirs: req.extraReadDirs ?? [],
      },
      {
        onEvent: (e) => {
          handleStreamEvent(entry, e);
          onEvent?.(e);
        },
        onSession: (s) => handleSession(entry, s),
      },
    );
  } catch (e) {
    live().delete(executionId);
    const msg = e instanceof Error ? e.message : String(e);
    run("UPDATE executions SET status = 'failed', error = ?, ended_at = ? WHERE id = ?", [msg, nowIso(), executionId]);
    throw new DispatchError("LAUNCH_FAILED", `Executor failed before launch: ${msg}`);
  }

  entry.child = handle.child;
  entry.pid = handle.pid;
  run("UPDATE executions SET pid = ?, status = 'running', started_at = ?, runtime = ? WHERE id = ?", [
    handle.pid,
    nowIso(),
    `${policy.runtimeLabel} ${handle.version ?? ""}`.trim(),
    executionId,
  ]);
  emit({
    taskId: req.taskId,
    executionId,
    system,
    type: "executor_started",
    level: "info",
    visibility: "chat",
    summary: `${ws} executor launched (pid ${handle.pid}) · ${policy.modelLabel} (${policy.effort}) · ${wsCheck.root}`,
    data: { pid: handle.pid, cwd: wsCheck.root, model: policy.model, effort: policy.effort, phase: req.phase },
  });

  if (adapter.id === "codex") void verifyCodexLaunch(entry);

  entry.done = handle.done.then((exit) => finalize(entry, exit, rt.binary, rt.version));
  return { executionId, identity, done: entry.done };
}

function handleSession(entry: LiveExecution, s: { sessionId?: string; model?: string; cwd?: string; permissionMode?: string }) {
  if (s.sessionId) {
    entry.sessionId = s.sessionId;
    run("UPDATE executions SET session_id = ? WHERE id = ?", [s.sessionId, entry.id]);
  }
  if (entry.adapter.id === "claude-code") {
    if (s.model) entry.verify.model = s.model;
    if (s.cwd) entry.verify.cwd = s.cwd;
    if (s.permissionMode) entry.verify.permissionMode = s.permissionMode;
    evaluateVerification(entry);
  }
}

function handleStreamEvent(entry: LiveExecution, e: ExecutorStreamEvent) {
  const system = entry.workspace;
  if (e.kind === "usage") {
    const m = e.data?.assistantModel;
    if (typeof m === "string" && m) {
      entry.verify.mainModels.add(m);
      if (m !== entry.policy.model) {
        emit({
          taskId: entry.taskId,
          executionId: entry.id,
          system,
          type: "model_substitution_detected",
          level: "warning",
          visibility: "chat",
          summary: `A ${e.data?.subagent ? "sub-agent" : "turn"} in this run answered on ${m}, not ${entry.policy.model}; this run cannot be Verified Complete.`,
          data: e.data,
        });
      }
    }
    if (!e.summary) return;
  }
  const typeMap: Record<ExecutorStreamEvent["kind"], string> = {
    started: "executor_session",
    text: "executor_output",
    tool: "executor_output",
    tool_result: "executor_output",
    subagent: "subagent_started",
    result: "executor_result",
    error: "executor_error",
    usage: "executor_usage",
    info: "executor_output",
  };
  emit({
    taskId: entry.taskId,
    executionId: entry.id,
    system,
    type: typeMap[e.kind],
    level: e.kind === "error" ? "error" : "info",
    visibility: e.kind === "subagent" ? "chat" : "details",
    summary: e.summary,
    data: { kind: e.kind, ...(e.data ?? {}) },
  });
  if (e.kind === "subagent") {
    run(
      "INSERT OR IGNORE INTO subagent_invocations(id, task_id, execution_id, workspace, agent, source, description, status, started_at) VALUES (?, ?, ?, ?, ?, 'executor-subagent', ?, 'running', ?)",
      [
        `${entry.id}:${String(e.data?.toolUseId ?? Date.now())}`,
        entry.taskId,
        entry.id,
        entry.workspace,
        String(e.data?.subagentType ?? "sub-agent"),
        String(e.data?.description ?? e.summary).slice(0, 300),
        nowIso(),
      ],
    );
  }
}

function evaluateVerification(entry: LiveExecution) {
  const v = entry.verify;
  if (v.ok !== null) return;
  const p = entry.policy;
  const root = workspaceRoot(entry.workspace);
  const problems: string[] = [];
  if (v.model && v.model !== p.model) problems.push(`model is ${v.model}, required ${p.model}`);
  if (v.cwd && !samePath(v.cwd, root)) problems.push(`cwd is ${v.cwd}, required ${root}`);
  if (v.effort && v.effort !== p.effort) problems.push(`effort is ${v.effort}, required ${p.effort}`);
  if (problems.length) {
    v.ok = false;
    v.reason = problems.join("; ");
  } else if (v.model && v.cwd && v.effort) {
    v.ok = true;
  } else {
    return; // still waiting for evidence
  }
  run("UPDATE executions SET verified = ?, verified_model = ?, verified_effort = ?, verification_json = ? WHERE id = ?", [
    v.ok ? 1 : 0,
    v.model ?? null,
    v.effort ?? null,
    json({ model: v.model, effort: v.effort, cwd: v.cwd, permissionMode: v.permissionMode, reason: v.reason ?? null }),
    entry.id,
  ]);
  emit({
    taskId: entry.taskId,
    executionId: entry.id,
    system: entry.workspace,
    type: v.ok ? "launch_verified" : "launch_verification_failed",
    level: v.ok ? "success" : "error",
    visibility: "chat",
    summary: v.ok
      ? `Launch verified: ${p.modelLabel} (${v.model}) · effort ${v.effort} · cwd ${v.cwd}`
      : `Launch verification failed — stopping the executor: ${v.reason}`,
    data: { model: v.model, effort: v.effort, cwd: v.cwd, reason: v.reason ?? null },
  });
  for (const w of entry.waiters.splice(0)) w();
  if (!v.ok) {
    entry.cancelRequested = true;
    if (entry.pid) void killTree(entry.pid);
  }
}

async function verifyCodexLaunch(entry: LiveExecution) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && entry.verify.ok === null) {
    if (entry.sessionId) {
      const file = findRollout(entry.sessionId);
      if (file) {
        const ctx = readRolloutContext(file);
        const tc = ctx.turnContexts[ctx.turnContexts.length - 1];
        if (tc) {
          entry.verify.model = tc.model;
          entry.verify.effort = tc.effort;
          entry.verify.cwd = tc.cwd;
          entry.verify.permissionMode = JSON.stringify(tc.sandboxPolicy ?? null);
          run("UPDATE executions SET verification_json = ? WHERE id = ?", [json({ rollout: file, cliVersion: ctx.sessionMeta?.cliVersion ?? null }), entry.id]);
          evaluateVerification(entry);
          return;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (entry.verify.ok === null) {
    entry.verify.ok = false;
    entry.verify.reason = "no Codex rollout turn_context found within 30 s; model and effort could not be verified";
    run("UPDATE executions SET verified = 0, verification_json = ? WHERE id = ?", [json({ reason: entry.verify.reason }), entry.id]);
    emit({ taskId: entry.taskId, executionId: entry.id, system: entry.workspace, type: "launch_verification_failed", level: "error", visibility: "chat", summary: `Launch verification failed — stopping the executor: ${entry.verify.reason}` });
    for (const w of entry.waiters.splice(0)) w();
    entry.cancelRequested = true;
    if (entry.pid) void killTree(entry.pid);
  }
}

async function finalize(entry: LiveExecution, exit: ExitInfo, binary: string | null, version: string | null): Promise<ExecutionOutcome> {
  live().delete(entry.id);
  for (const w of entry.waiters.splice(0)) w();
  const cancelled = entry.cancelRequested && entry.verify.ok !== false;
  const status: ExecutionOutcome["status"] = cancelled ? "cancelled" : exit.error ? "failed" : "exited";
  run(
    "UPDATE executions SET status = ?, exit_code = ?, ended_at = ?, cancel_state = CASE WHEN ? THEN 'killed' ELSE cancel_state END, result_json = ?, error = ? WHERE id = ?",
    [status, exit.code, nowIso(), entry.cancelRequested ? 1 : 0, json(redactDeep(exit.structured)), exit.error ? redactSecrets(exit.error) : null, entry.id],
  );
  // A launch whose model/effort evidence contradicts policy is a runtime verification failure.
  if (entry.verify.ok === true || entry.verify.ok === false) {
    recordRuntimeVerification({
      workspace: entry.workspace,
      adapter: entry.adapter.id,
      binary,
      version,
      model: entry.policy.model,
      effort: entry.policy.effort,
      ok: entry.verify.ok === true,
      source: "dispatch",
      executionId: entry.id,
      detail: { model: entry.verify.model, effort: entry.verify.effort, cwd: entry.verify.cwd, reason: entry.verify.reason ?? null, mainModels: [...entry.verify.mainModels] },
    });
  } else if (exit.error && /unavailable/i.test(exit.error)) {
    recordRuntimeVerification({ workspace: entry.workspace, adapter: entry.adapter.id, binary, version, model: entry.policy.model, effort: entry.policy.effort, ok: false, source: "dispatch", executionId: entry.id, detail: { reason: exit.error } });
  }
  run("UPDATE subagent_invocations SET status = 'ended', ended_at = ? WHERE execution_id = ? AND status = 'running'", [nowIso(), entry.id]);
  emit({
    taskId: entry.taskId,
    executionId: entry.id,
    system: entry.workspace,
    type: "executor_complete",
    level: status === "exited" ? "success" : status === "cancelled" ? "warning" : "error",
    visibility: "details",
    summary:
      status === "cancelled"
        ? `${entry.workspace} executor stopped (cancelled) after ${Math.round(exit.durationMs / 1000)} s`
        : status === "failed"
          ? `${entry.workspace} executor failed: ${exit.error}`
          : `${entry.workspace} executor exited (code ${exit.code}) after ${Math.round(exit.durationMs / 1000)} s`,
    data: { code: exit.code, durationMs: exit.durationMs, error: exit.error, structuredStatus: exit.structured?.status ?? null },
  });
  return {
    executionId: entry.id,
    status,
    exit,
    verification: { ok: entry.verify.ok, model: entry.verify.model, effort: entry.verify.effort, cwd: entry.verify.cwd, reason: entry.verify.reason, mainModels: [...entry.verify.mainModels] },
  };
}

// ---------------------------------------------------------------------------------------------
// Gateway / guard callbacks (authenticated by the per-execution nonce).

export function authenticateGateway(executionId: string | null, nonce: string | null): LiveExecution | null {
  if (!executionId || !nonce) return null;
  const e = live().get(executionId);
  if (!e) return null;
  return e.nonceHash === hashNonce(nonce) ? e : null;
}

/** Waits briefly for launch verification to complete. */
export async function awaitVerification(e: LiveExecution, timeoutMs = 12000): Promise<{ verified: boolean; reason?: string }> {
  if (e.verify.ok === null) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      e.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  if (e.cancelRequested) return { verified: false, reason: "execution is being cancelled" };
  if (e.verify.ok === true) return { verified: true };
  return { verified: false, reason: e.verify.reason ?? "launch verification still pending (model/effort evidence not yet observed)" };
}

export function observeGuard(e: LiveExecution, obs: { effort: string | null; permissionMode: string | null; cwd: string | null; tool: string; summary: string | null }): { deny?: string } {
  if (e.cancelRequested) return { deny: "this execution has been cancelled" };
  if (obs.effort && !e.verify.effort) {
    e.verify.effort = obs.effort;
    evaluateVerification(e);
  }
  if (e.verify.ok === false) return { deny: `launch verification failed: ${e.verify.reason}` };
  if (obs.effort && obs.effort !== e.policy.effort) return { deny: `effort ${obs.effort} != required ${e.policy.effort}` };
  return {};
}

// ---------------------------------------------------------------------------------------------
// Cancellation and status

export async function cancelExecution(executionId: string, reason: string): Promise<{ ok: boolean; detail: string }> {
  const e = live().get(executionId);
  if (!e) return { ok: false, detail: "execution is not running" };
  e.cancelRequested = true;
  run("UPDATE executions SET cancel_state = 'requested' WHERE id = ?", [executionId]);
  emit({ taskId: e.taskId, executionId, system: e.workspace, type: "executor_cancel_requested", level: "warning", visibility: "chat", summary: `Stopping ${e.workspace} executor (pid ${e.pid}): ${reason}` });
  for (const w of e.waiters.splice(0)) w();
  if (!e.pid) return { ok: false, detail: "no pid" };
  const k = await killTree(e.pid);
  if (!k.ok) {
    // Windows can refuse to end a sandboxed child ("The operation attempted is not supported"); say so.
    const refused = k.detail.split(/\r?\n/).filter((l) => /^ERROR:|could not be terminated|Reason:/i.test(l)).join(" ").slice(0, 400);
    emit({ taskId: e.taskId, executionId, system: e.workspace, type: "executor_kill_incomplete", level: "warning", visibility: "chat", summary: `Stop sent, but Windows did not end every process in the ${e.workspace} executor's tree: ${refused || k.detail.slice(0, 300)}. Such a child normally exits once its parent is gone; in the restart test on 2026-09-23 it had exited on its own within seconds.` });
  }
  return { ok: k.ok, detail: k.detail };
}

export function runningExecutions(): Array<{ id: string; taskId: string; workspace: WorkspaceId; phase: Phase; pid: number | null; verified: boolean | null }> {
  return [...live().values()].map((e) => ({ id: e.id, taskId: e.taskId, workspace: e.workspace, phase: e.phase, pid: e.pid, verified: e.verify.ok }));
}

export function isExecutionLive(executionId: string): boolean {
  return live().has(executionId);
}

/**
 * After an HQ restart nothing in memory survives. Any execution the database still shows as active
 * cannot be proven finished, so it is marked interrupted (process gone) or needs_reconciliation
 * (process still alive and orphaned). Nothing is ever marked complete by assumption.
 */
export async function reconcileAfterRestart(): Promise<number> {
  const rows = all<{ id: string; task_id: string; pid: number | null; adapter: string; workspace: string; phase: string }>(
    "SELECT id, task_id, pid, adapter, workspace, phase FROM executions WHERE status IN ('starting', 'running')",
  );
  let n = 0;
  for (const r of rows) {
    if (live().has(r.id)) continue;
    let alive = isPidAlive(r.pid);
    if (alive && r.pid) {
      const image = (await processImageName(r.pid))?.toLowerCase() ?? "";
      alive = image.includes("claude") || image.includes("codex");
    }
    const status = alive ? "needs_reconciliation" : "interrupted";
    run("UPDATE executions SET status = ?, ended_at = COALESCE(ended_at, ?), error = ? WHERE id = ?", [
      status,
      nowIso(),
      alive ? `HQ restarted while this executor was running; the process (pid ${r.pid}) is still alive and orphaned` : "HQ restarted while this executor was running; its final state was never observed",
      r.id,
    ]);
    emit({
      taskId: r.task_id,
      executionId: r.id,
      system: r.workspace as WorkspaceId,
      type: "execution_interrupted",
      level: "warning",
      visibility: "chat",
      summary: alive
        ? `HQ restarted: the ${r.workspace} executor (pid ${r.pid}) is still running without supervision — needs reconciliation`
        : `HQ restarted: the ${r.workspace} ${r.phase} execution was interrupted and its outcome is unknown`,
    });
    n++;
  }
  return n;
}

/**
 * An orphan left by a restart holds its workspace's line (queue.ts). Once its process has exited, or
 * its PID belongs to something other than an executor, it is settled as interrupted, exactly as
 * terminateOrphan does when it finds the process gone. Returns how many were settled.
 */
export async function settleDeadOrphans(): Promise<number> {
  const rows = all<{ id: string; pid: number | null }>("SELECT id, pid FROM executions WHERE status = 'needs_reconciliation'");
  let n = 0;
  for (const r of rows) {
    let alive = isPidAlive(r.pid);
    if (alive && r.pid) {
      const image = (await processImageName(r.pid))?.toLowerCase() ?? "";
      alive = image.includes("claude") || image.includes("codex");
    }
    if (alive) continue;
    run("UPDATE executions SET status = 'interrupted', error = COALESCE(error, '') || ? WHERE id = ? AND status = 'needs_reconciliation'", [
      " — its process has since exited (or its PID now belongs to another program)",
      r.id,
    ]);
    n++;
  }
  return n;
}

export async function terminateOrphan(executionId: string): Promise<{ ok: boolean; detail: string }> {
  const r = get<{ pid: number | null; status: string; task_id: string; workspace: string }>("SELECT pid, status, task_id, workspace FROM executions WHERE id = ?", [executionId]);
  if (!r || r.status !== "needs_reconciliation" || !r.pid) return { ok: false, detail: "no orphaned process recorded for this execution" };
  const image = (await processImageName(r.pid))?.toLowerCase() ?? "";
  if (!image.includes("claude") && !image.includes("codex")) {
    run("UPDATE executions SET status = 'interrupted' WHERE id = ?", [executionId]);
    return { ok: true, detail: "process already gone (pid reused or exited)" };
  }
  const k = await killTree(r.pid);
  run("UPDATE executions SET status = 'interrupted', cancel_state = 'killed' WHERE id = ?", [executionId]);
  emit({ taskId: r.task_id, executionId, system: r.workspace as WorkspaceId, type: "orphan_terminated", level: "warning", visibility: "chat", summary: `Orphaned executor pid ${r.pid} terminated by operator` });
  return k;
}
