import fs from "node:fs";
import path from "node:path";

export type WorkspaceId = "One" | "Studio";
export const WORKSPACES: WorkspaceId[] = ["One", "Studio"];

export interface RuntimePolicy {
  adapter: "claude-code" | "codex";
  runtimeLabel: string;
  model: string;
  modelLabel: string;
  effort: string;
  claudeBin?: string;
  codexBin?: string;
  minCodexVersion?: string;
}
/** The executor's pin; most of HQ only ever deals with the executor. */
export type ExecutorPolicy = RuntimePolicy;
export type RuntimeRole = "planner" | "executor";

export interface WorkspaceConfig {
  dir: string;
  expectedEmail: string;
  expectedOrg: string | null;
  log: string;
  executor: ExecutorPolicy;
  /** The planning session's pin. It uses the executor's harness and binary settings; only these differ. */
  planner: Pick<RuntimePolicy, "model" | "modelLabel" | "effort">;
}

export interface HqConfig {
  port: number;
  logTimezoneLabel: string;
  root: { expectedEmail: string; expectedOrg: string | null; log: string };
  workspaces: Record<WorkspaceId, WorkspaceConfig>;
  /** Where Submit issue files a failed task's report, through the root's GitHub connection. Absent: the button is off. */
  issues?: { owner: string; repo: string };
  limits: { planTimeoutMs: number; previewTimeoutMs: number; executeTimeoutMs: number; modelVerificationTtlHours: number };
  /** Test-only: extra directories scanned for sub-agent definitions (never set in production config). */
  agentDirsOverride?: string[];
}

function findUp(start: string, marker: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

let cachedHqRoot: string | null = null;
/** The jos-hq application directory. */
export function hqRoot(): string {
  if (cachedHqRoot) return cachedHqRoot;
  const fromEnv = process.env.JOS_HQ_APP_ROOT;
  const found = fromEnv ? path.resolve(fromEnv) : findUp(process.cwd(), "jos-hq.config.json");
  if (!found) throw new Error("Cannot locate jos-hq (no jos-hq.config.json above the working directory).");
  cachedHqRoot = found;
  return found;
}

/** The J/OS repository root (the Orchestrator directory). */
export function josRoot(): string {
  const root = process.env.JOS_HQ_JOS_ROOT ? path.resolve(process.env.JOS_HQ_JOS_ROOT) : path.dirname(hqRoot());
  return root;
}

let cachedConfig: HqConfig | null = null;
let cachedConfigPath: string | null = null;
export function configPath(): string {
  return process.env.JOS_HQ_CONFIG ? path.resolve(process.env.JOS_HQ_CONFIG) : path.join(hqRoot(), "jos-hq.config.json");
}

export function loadConfig(): HqConfig {
  const p = configPath();
  if (cachedConfig && cachedConfigPath === p) return cachedConfig;
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as HqConfig;
  cachedConfig = raw;
  cachedConfigPath = p;
  return raw;
}

export function workspaceRoot(ws: WorkspaceId): string {
  return path.join(josRoot(), loadConfig().workspaces[ws].dir);
}

export function isWorkspaceId(v: unknown): v is WorkspaceId {
  return v === "One" || v === "Studio";
}

export function dataDir(): string {
  const d = process.env.JOS_HQ_DATA_DIR ? path.resolve(process.env.JOS_HQ_DATA_DIR) : path.join(hqRoot(), "data");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function runsDir(): string {
  const d = path.join(dataDir(), "runs");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function uploadsDir(): string {
  const d = path.join(dataDir(), "uploads");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function gatewayDir(): string {
  return path.join(hqRoot(), "gateway");
}

export function serverPort(): number {
  const fromEnv = Number(process.env.JOS_HQ_PORT || process.env.PORT);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : loadConfig().port;
}

export function serverUrl(): string {
  return `http://127.0.0.1:${serverPort()}`;
}

export function logFileFor(route: WorkspaceId | "none"): string {
  const cfg = loadConfig();
  return route === "none" ? cfg.root.log : cfg.workspaces[route].log;
}

/** The pin for a workspace's planner or executor. A planner inherits its executor's harness settings. */
export function rolePolicy(ws: WorkspaceId, role: RuntimeRole): RuntimePolicy {
  const w = loadConfig().workspaces[ws];
  return role === "planner" ? { ...w.executor, ...w.planner } : w.executor;
}

export function phaseRole(phase: "plan" | "preview" | "execute"): RuntimeRole {
  return phase === "plan" ? "planner" : "executor";
}
