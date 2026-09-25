import type { ChildProcess } from "node:child_process";
import type { ExecutorPolicy, RuntimePolicy, WorkspaceId } from "../env";
import type { PlannerResult } from "./plan-schema";

export type Phase = "plan" | "preview" | "execute";
export type TaskMode = "auto" | "manual" | "edit" | "plan";

export interface BinaryCandidate {
  binary: string;
  version: string | null;
  source: string;
  eligible: boolean;
  reason: string;
}

export interface RuntimeResolution {
  ok: boolean;
  adapter: ExecutorPolicy["adapter"];
  binary: string | null;
  version: string | null;
  source: string | null;
  candidates: BinaryCandidate[];
  error?: string;
}

export interface LaunchSpec {
  executionId: string;
  taskId: string;
  workspace: WorkspaceId;
  workspaceRoot: string;
  phase: Phase;
  mode: TaskMode;
  prompt: string;
  runDir: string;
  policyPath: string;
  gatewayNonce: string;
  /** Absolute path of the real One CLI entry point (…/@withone/cli/bin/cli.js) the gateway wraps. */
  realOneCli: string;
  timeoutMs: number;
  extraReadDirs: string[];
}

/** Normalized stream events from either runtime. */
export interface ExecutorStreamEvent {
  kind: "started" | "text" | "tool" | "tool_result" | "subagent" | "result" | "error" | "usage" | "info";
  summary: string;
  data?: Record<string, unknown>;
}

export interface ExitInfo {
  code: number | null;
  timedOut: boolean;
  killed: boolean;
  structured: ExecutorResult | null;
  /** PLAN phase only: the coerced plan (structured stays null). */
  plan?: PlannerResult | null;
  resultText: string | null;
  error: string | null;
  durationMs: number;
}

export interface LaunchHandle {
  child: ChildProcess;
  pid: number | null;
  binary: string;
  version: string | null;
  args: string[];
  done: Promise<ExitInfo>;
}

export interface LaunchHooks {
  onEvent: (e: ExecutorStreamEvent) => void;
  onSession: (info: { sessionId?: string; model?: string; cwd?: string; transcriptPath?: string; permissionMode?: string }) => void;
  onRawLine?: (line: string) => void;
}

export interface ProposedAction {
  kind: "one_action" | "one_flow";
  title: string;
  platform: string;
  action_id: string;
  connection_key: string;
  connection_name: string;
  method: string;
  target: string;
  data_json: string;
  path_vars_json: string;
  query_params_json: string;
  flow_key: string;
  flow_inputs_json: string;
  side_effect: string;
  idempotent: boolean;
  expected_calls: number;
  estimated_cost: string;
  dry_run_ok: boolean;
}

export interface ExecutorResult {
  status: "completed" | "needs_approval" | "blocked" | "failed" | "partial";
  answer: string;
  summary: string;
  identity_check: { project_root: string; email: string; passed: boolean };
  proposed_actions: ProposedAction[];
  artifacts: Array<{ kind: string; id: string; path: string; description: string }>;
  verification: { performed: boolean; passed: boolean; method: string; evidence: string };
  limitations: string[];
  learned: string[];
  needs_user_input: string;
}

export interface ExecutorAdapter {
  readonly id: ExecutorPolicy["adapter"];
  readonly workspace: WorkspaceId;
  readonly policy: ExecutorPolicy;
  /** The pin a phase runs on: the planner's for PLAN, the executor's otherwise. */
  policyFor(phase: Phase): RuntimePolicy;
  checkAvailability(force?: boolean): Promise<RuntimeResolution>;
  verifyWorkspace(): { ok: boolean; root: string; problem?: string };
  launch(spec: LaunchSpec, hooks: LaunchHooks): Promise<LaunchHandle>;
}
