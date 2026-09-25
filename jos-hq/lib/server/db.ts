// HQ telemetry and application state. This database is NOT J/OS memory: the three root Markdown logs
// stay the durable narrative record, and nothing here is read back as routing truth. No secrets are
// stored here; every text column written through this module is redacted first by its callers.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { dataDir } from "./env";

const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Untitled',
  purpose TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL,
  task_id TEXT,
  data_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msgs_chat ON chat_messages(chat_id, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  origin TEXT NOT NULL,
  title TEXT NOT NULL,
  request TEXT NOT NULL,
  mode TEXT NOT NULL,
  route_selection TEXT NOT NULL,
  route TEXT,
  route_reason TEXT,
  route_evidence_json TEXT,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  log_file TEXT,
  log_opened_at TEXT,
  log_closed_at TEXT,
  log_status TEXT,
  plan_json TEXT,
  planner_model TEXT,
  context_json TEXT,
  result_json TEXT,
  verification TEXT NOT NULL DEFAULT 'none',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  admitted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_chat ON tasks(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  workspace TEXT NOT NULL,
  cwd TEXT NOT NULL,
  adapter TEXT NOT NULL,
  runtime TEXT NOT NULL,
  binary TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  pid INTEGER,
  session_id TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  started_at TEXT,
  ended_at TEXT,
  cancel_state TEXT NOT NULL DEFAULT 'none',
  verified INTEGER NOT NULL DEFAULT 0,
  verified_model TEXT,
  verified_effort TEXT,
  verification_json TEXT,
  gateway_token_hash TEXT,
  policy_path TEXT,
  prompt_path TEXT,
  output_path TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exec_task ON executions(task_id);
CREATE INDEX IF NOT EXISTS idx_exec_status ON executions(status);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  execution_id TEXT,
  system TEXT,
  type TEXT NOT NULL,
  level TEXT NOT NULL,
  visibility TEXT NOT NULL,
  summary TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  execution_id TEXT,
  status TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);

CREATE TABLE IF NOT EXISTS approval_actions (
  approval_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  claimed_at TEXT,
  finished_at TEXT,
  outcome_json TEXT,
  PRIMARY KEY (approval_id, idx)
);

CREATE TABLE IF NOT EXISTS connection_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  execution_id TEXT,
  workspace TEXT NOT NULL,
  executor TEXT,
  subagent TEXT,
  platform TEXT,
  connection_key TEXT,
  connection_name TEXT,
  action_id TEXT,
  category TEXT NOT NULL,
  decision TEXT NOT NULL,
  method TEXT,
  path TEXT,
  ok INTEGER,
  duration_ms INTEGER,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_conn ON connection_usage(workspace, platform, created_at);

CREATE TABLE IF NOT EXISTS subagent_invocations (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  execution_id TEXT,
  workspace TEXT NOT NULL,
  agent TEXT NOT NULL,
  source TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_conversations (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  agent TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  task_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_msgs ON agent_messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  task_id TEXT,
  original_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  mime TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  kind TEXT,
  ref TEXT,
  path TEXT,
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  workspace TEXT NOT NULL,
  flow_key TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS runtime_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  adapter TEXT NOT NULL,
  binary TEXT,
  version TEXT,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  ok INTEGER NOT NULL,
  source TEXT NOT NULL,
  execution_id TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS health_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

type SqlValue = string | number | bigint | null | Uint8Array;
type Params = SqlValue[] | Record<string, SqlValue>;

interface DbHolder {
  db: DatabaseSync;
  path: string;
}

const g = globalThis as unknown as { __josHqDb?: DbHolder };

export function dbFilePath(): string {
  return path.join(dataDir(), "hq.sqlite");
}

export function db(): DatabaseSync {
  const p = dbFilePath();
  if (g.__josHqDb && g.__josHqDb.path === p) return g.__josHqDb.db;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const handle = new sqlite.DatabaseSync(p);
  handle.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  handle.exec(SCHEMA);
  migrateSchema(handle);
  handle.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  g.__josHqDb = { db: handle, path: p };
  return handle;
}

/** Brings a database created by an older schema up to date. CREATE TABLE IF NOT EXISTS adds no columns. */
export function migrateSchema(handle: DatabaseSync) {
  const chatCols = (handle.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!chatCols.includes("purpose")) {
    handle.exec("ALTER TABLE chats ADD COLUMN purpose TEXT");
    // Before v2 the only mark of a "+ New Workflow" chat was the title that button gives it.
    handle.exec("UPDATE chats SET purpose = 'workflow' WHERE title = 'New workflow'");
  }
  const taskCols = (handle.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  if (taskCols.length && !taskCols.includes("admitted_at")) {
    handle.exec("ALTER TABLE tasks ADD COLUMN admitted_at TEXT");
    // v3, the workspace line: tasks from before it count as admitted. For an ended task that changes
    // nothing; an unfinished one then holds its workspace, which is the safe reading.
    handle.exec("UPDATE tasks SET admitted_at = created_at WHERE route IN ('One', 'Studio')");
  }
}

function bind(params?: Params): SqlValue[] | [Record<string, SqlValue>] {
  if (!params) return [];
  return Array.isArray(params) ? params : [params];
}

export function run(sql: string, params?: Params) {
  return db().prepare(sql).run(...(bind(params) as SqlValue[]));
}

export function get<T = Record<string, unknown>>(sql: string, params?: Params): T | undefined {
  return db().prepare(sql).get(...(bind(params) as SqlValue[])) as T | undefined;
}

export function all<T = Record<string, unknown>>(sql: string, params?: Params): T[] {
  return db().prepare(sql).all(...(bind(params) as SqlValue[])) as T[];
}

export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string" || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Probe used by Runtime Health: a real write + read + delete. */
export function sqliteSelfTest(): { ok: boolean; detail: string } {
  try {
    const d = db();
    d.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('health_probe', ?)").run(new Date().toISOString());
    const row = d.prepare("SELECT value FROM meta WHERE key = 'health_probe'").get() as { value?: string } | undefined;
    d.prepare("DELETE FROM meta WHERE key = 'health_probe'").run();
    return { ok: !!row?.value, detail: `WAL database at ${dbFilePath()}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
