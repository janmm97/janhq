// Sub-agent registry (CLAUDE.md §6b). Definitions live ONLY at the Orchestrator level, each next to a
// folder of the same name that holds its SOP.md and LOGS.md (lib/server/agent-files.ts):
//   JOS/.claude/agents/one_<name>.md  + one_<name>/{SOP.md, LOGS.md} — One sub-agents (Claude Code format)
//   JOS/.codex/agents/studio_<name>.toml + studio_<name>/{SOP.md, LOGS.md} — Studio sub-agents (Codex agent-role TOML)
// The filename prefix names the executor workspace. The SOP is the single source of an agent's
// instructions and HQ loads it into every prompt; the definition only points at it. LOGS.md is the
// agent's memory, written by HQ alone. A UI conversation is display, not memory.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir, loadConfig, type WorkspaceId } from "./env";
import { all, get, run, tx } from "./db";
import { busyTasks, type BusyTask } from "./tasks";
import { newId } from "./util/ids";
import { nowIso } from "./util/time";
import { redactSecrets } from "./util/redact";
import { signal } from "./events";
import { submitTask } from "./orchestrator";
import type { TaskMode } from "./executors/types";
import { agentDirs, agentKeyFor, agentPaths, allowedConnectionsFrom, inOrchestratorFolders, logsHeader, minimalDefinition, pointsToSop, readSop, SOP_MARK, writeFileAtomic } from "./agent-files";

export { agentDirs } from "./agent-files";

export interface AgentDefinition {
  key: string;
  name: string;
  workspace: WorkspaceId;
  harness: "claude" | "codex";
  file: string;
  description: string;
  /** The SOP's full text (SOP format), or the definition's inline instructions (old format). */
  instructions: string;
  model: string | null;
  /** Codex `model_reasoning_effort`; null for Claude definitions. */
  effort: string | null;
  connections: string[];
  /** The "## Allowed connections" lines HQ enforces, as platform and name. */
  allowedConnections: Array<{ platform: string; name: string }>;
  /** "sop": a minimal definition plus the SOP.md/LOGS.md folder; "legacy": instructions inside the definition. */
  format: "sop" | "legacy";
  sopFile: string | null;
  logsFile: string | null;
  /** Why the SOP cannot be used; a task for this agent is blocked until it can. */
  sopError: string | null;
}

function workspaceFromFile(file: string): WorkspaceId | null {
  const base = path.basename(file).toLowerCase();
  if (base.startsWith("one_")) return "One";
  if (base.startsWith("studio_")) return "Studio";
  return null;
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2] };
}

/** Minimal TOML reader for agent-role files: key = "value", key = """multi-line""", key = [..]. */
export function parseSimpleToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^([A-Za-z0-9_]+)\s*=\s*("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'[^']*'|\[[^\]]*\]|[^\r\n]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let v = m[2].trim();
    if (v.startsWith('"""') || v.startsWith("'''")) v = v.slice(3, -3).replace(/^\r?\n/, "");
    else if (v.startsWith('"')) v = JSON.parse(v);
    else if (v.startsWith("'")) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function connectionsFromText(text: string): string[] {
  const m = text.match(/^(?:##\s*)?(?:Allowed\s+)?connections\s*:?\s*\n((?:\s*[-*].+\n?)+)/im);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 30);
}

type RawDefinition = Pick<AgentDefinition, "key" | "name" | "workspace" | "harness" | "file" | "description" | "model" | "effort"> & { inline: string };

/** The agent's instructions: its SOP.md when it has a folder (or points to one), its inline text otherwise. */
function withInstructions(raw: RawDefinition): AgentDefinition {
  const { inline, ...base } = raw;
  const ap = agentPaths(base.file);
  if (!ap.ok) {
    // A definition that points to an SOP HQ cannot resolve safely must not run on its pointer text alone.
    if (pointsToSop(inline)) return { ...base, format: "sop", instructions: "", connections: [], allowedConnections: [], sopFile: null, logsFile: null, sopError: ap.error };
    return { ...base, format: "legacy", instructions: inline.trim(), connections: connectionsFromText(inline), allowedConnections: allowedConnectionsFrom(inline), sopFile: null, logsFile: null, sopError: null };
  }
  if (fs.existsSync(ap.paths.folder) || pointsToSop(inline)) {
    const sop = readSop(ap.paths);
    const text = sop.ok ? sop.text : "";
    return {
      ...base,
      format: "sop",
      instructions: text.trim(),
      connections: connectionsFromText(text),
      allowedConnections: allowedConnectionsFrom(text),
      sopFile: ap.paths.sop,
      logsFile: fs.existsSync(ap.paths.logs) ? ap.paths.logs : null,
      sopError: sop.ok ? null : sop.error,
    };
  }
  return { ...base, format: "legacy", instructions: inline.trim(), connections: connectionsFromText(inline), allowedConnections: allowedConnectionsFrom(inline), sopFile: null, logsFile: null, sopError: null };
}

export function listAgentDefinitions(): AgentDefinition[] {
  const dirs = agentDirs();
  const out: AgentDefinition[] = [];
  const scan = (dir: string, harness: "claude" | "codex") => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      const ws = workspaceFromFile(file);
      if (!ws) continue;
      try {
        if (harness === "claude" && n.endsWith(".md")) {
          const { meta, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
          const name = meta.name || n.replace(/\.md$/, "");
          out.push(withInstructions({ key: name, name, workspace: ws, harness, file, description: meta.description ?? "", model: meta.model ?? null, effort: null, inline: body }));
        } else if (harness === "codex" && n.endsWith(".toml")) {
          const t = parseSimpleToml(fs.readFileSync(file, "utf8"));
          const name = t.name || n.replace(/\.toml$/, "");
          out.push(withInstructions({ key: name, name, workspace: ws, harness, file, description: t.description ?? "", model: t.model ?? null, effort: t.model_reasoning_effort ?? null, inline: t.developer_instructions ?? "" }));
        }
      } catch {
        /* unreadable definition: skipped */
      }
    }
  };
  scan(dirs.claude, "claude");
  scan(dirs.codex, "codex");
  for (const d of dirs.extra) {
    scan(d, "claude");
    scan(d, "codex");
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function findAgent(ws: WorkspaceId, key: string): AgentDefinition | null {
  return listAgentDefinitions().find((a) => a.workspace === ws && a.key === key) ?? null;
}

/**
 * The agent's LOGS.md, recreated (header only) when its folder and SOP are there but the log is gone, so a
 * deleted log never silently stops the agent's record (spec 3.5). Only in the Orchestrator-level folders.
 */
export function ensureAgentLog(def: AgentDefinition): { file: string; recreated: boolean } | null {
  if (def.format !== "sop" || def.sopError || !inOrchestratorFolders(def.file)) return null;
  const ap = agentPaths(def.file);
  if (!ap.ok) return null;
  if (fs.existsSync(ap.paths.logs)) return { file: ap.paths.logs, recreated: false };
  try {
    writeFileAtomic(ap.paths.logs, logsHeader(ap.paths.name), { exclusive: true });
    return { file: ap.paths.logs, recreated: true };
  } catch {
    return fs.existsSync(ap.paths.logs) ? { file: ap.paths.logs, recreated: false } : null;
  }
}

export interface AgentRow extends AgentDefinition {
  status: "Working" | "Ready" | "Waiting" | "Blocked";
  lastActive: string | null;
  activeConversations: number;
  registeredAt: string | null;
}

/** When the definition file was created (its birth time where the file system keeps one). */
function registeredAt(file: string): string | null {
  try {
    const s = fs.statSync(file);
    return (s.birthtimeMs > 0 ? s.birthtime : s.mtime).toISOString();
  } catch {
    return null;
  }
}

export function listAgentsView(ws: WorkspaceId): AgentRow[] {
  return listAgentDefinitions()
    .filter((a) => a.workspace === ws)
    .map((a) => {
      const tasks = all<{ status: string; created_at: string }>(
        `SELECT t.status, t.created_at FROM tasks t WHERE t.origin = 'agent' AND json_extract(t.context_json, '$.agent.workspace') = ? AND json_extract(t.context_json, '$.agent.name') = ? ORDER BY t.created_at DESC LIMIT 20`,
        [ws, a.key],
      );
      const active = tasks.find((t) => ["queued", "routing", "discovering", "planning", "dispatching", "executing", "verifying"].includes(t.status));
      const waiting = tasks.find((t) => ["needs_clarification", "awaiting_approval", "in_line"].includes(t.status));
      const convs = get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_conversations WHERE workspace = ? AND agent = ? AND status IN ('Active','Waiting')", [ws, a.key])?.n ?? 0;
      return { ...a, status: active ? "Working" : waiting ? "Waiting" : "Ready", lastActive: tasks[0]?.created_at ?? null, activeConversations: convs, registeredAt: registeredAt(a.file) };
    });
}

// ---- conversations ------------------------------------------------------------------------------

export interface ConversationRow {
  id: string;
  workspace: string;
  agent: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_message: string | null;
}

export function listConversations(ws: WorkspaceId, agent: string): ConversationRow[] {
  return all<ConversationRow>(
    `SELECT c.*, (SELECT content FROM agent_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
     FROM agent_conversations c WHERE c.workspace = ? AND c.agent = ? ORDER BY c.updated_at DESC`,
    [ws, agent],
  );
}

export function createConversation(ws: WorkspaceId, agent: string, title?: string): ConversationRow {
  if (!findAgent(ws, agent)) throw new Error(`No sub-agent ${agent} configured for ${ws}`);
  const id = newId("conv");
  const now = nowIso();
  run("INSERT INTO agent_conversations(id, workspace, agent, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'Active', ?, ?)", [id, ws, agent, redactSecrets(title || "New conversation").slice(0, 120), now, now]);
  signal("agents_updated", { workspace: ws, agent });
  return listConversations(ws, agent).find((c) => c.id === id)!;
}

export function conversationMessages(convId: string) {
  return all<{ id: string; role: string; content: string; task_id: string | null; created_at: string; task_status: string | null }>(
    "SELECT m.*, t.status AS task_status FROM agent_messages m LEFT JOIN tasks t ON t.id = m.task_id WHERE m.conversation_id = ? ORDER BY m.created_at ASC, m.rowid ASC",
    [convId],
  );
}

export function sendAgentMessage(convId: string, text: string, mode: TaskMode) {
  const conv = get<{ id: string; workspace: WorkspaceId; agent: string; title: string }>("SELECT * FROM agent_conversations WHERE id = ?", [convId]);
  if (!conv) throw new Error("Conversation not found");
  const agent = findAgent(conv.workspace, conv.agent);
  if (!agent) throw new Error(`No sub-agent ${conv.agent} configured for ${conv.workspace}`);
  const clean = redactSecrets(text).trim();
  if (!clean) throw new Error("Message is empty");
  // The prior thread travels as the task's conversation context, never inside the request: the request
  // stays the operator's own words (what the logs record and the repeat check compares).
  const history = conversationMessages(convId).slice(-6);
  const prior = history.map((m) => `${m.role === "user" ? "Operator" : agent.name}: ${m.content.slice(0, 400)}`);
  const conversation = prior.length ? { route: conv.workspace, lastTaskId: history.at(-1)?.task_id ?? "", lastTitle: conv.title, text: `Earlier in this conversation (for context only):\n${prior.join("\n")}` } : null;
  const task = submitTask({ chatId: null, text: clean, routeSelection: conv.workspace, mode, origin: "agent", agent: { workspace: conv.workspace, name: agent.key }, title: clean.slice(0, 60), conversation });
  run("UPDATE tasks SET context_json = json_set(COALESCE(context_json, '{}'), '$.agentConversationId', ?) WHERE id = ?", [convId, task.id]);
  run("INSERT INTO agent_messages(id, conversation_id, role, content, task_id, created_at) VALUES (?, ?, 'user', ?, ?, ?)", [newId("amsg"), convId, clean, task.id, nowIso()]);
  const title = conv.title === "New conversation" ? clean.slice(0, 60) : conv.title;
  run("UPDATE agent_conversations SET status = 'Active', title = ?, updated_at = ? WHERE id = ?", [title, nowIso(), convId]);
  signal("agents_updated", { workspace: conv.workspace, agent: conv.agent, conversationId: convId });
  return task;
}

/** Called when an agent task finishes: append the answer and update the conversation state. */
export function recordAgentTaskResult(convId: string, taskId: string, status: string, answer: string) {
  if (!get("SELECT 1 FROM agent_conversations WHERE id = ?", [convId])) return; // deleted with its agent
  run("INSERT INTO agent_messages(id, conversation_id, role, content, task_id, created_at) VALUES (?, ?, 'agent', ?, ?, ?)", [newId("amsg"), convId, redactSecrets(answer), taskId, nowIso()]);
  const state = status === "completed" || status === "unverified" || status === "planned" ? "Complete" : status === "awaiting_approval" || status === "needs_clarification" ? "Waiting" : status === "cancelled" || status === "rejected" ? "Paused" : "Failed";
  run("UPDATE agent_conversations SET status = ?, updated_at = ? WHERE id = ?", [state, nowIso(), convId]);
  signal("agents_updated", { conversationId: convId });
}

/** A line the operator sent without typing it (Execute this plan), so the thread shows what ran. */
export function recordAgentUserMessage(convId: string, content: string, taskId: string) {
  const conv = get<{ workspace: string; agent: string }>("SELECT workspace, agent FROM agent_conversations WHERE id = ?", [convId]);
  if (!conv) return; // deleted with its agent
  run("INSERT INTO agent_messages(id, conversation_id, role, content, task_id, created_at) VALUES (?, ?, 'user', ?, ?, ?)", [newId("amsg"), convId, redactSecrets(content), taskId, nowIso()]);
  run("UPDATE agent_conversations SET status = 'Active', updated_at = ? WHERE id = ?", [nowIso(), convId]);
  signal("agents_updated", { workspace: conv.workspace, agent: conv.agent, conversationId: convId });
}

// ---- building a new sub-agent (the two §6b questions, then HQ decides the guardrails) ----------------

export interface NewAgentAnswers {
  workspace: WorkspaceId;
  name: string;
  /** Question 1: which specific connections (live connection names). */
  connections: Array<{ platform: string; name: string }>;
  /** Question 2: how it should use them. */
  purpose: string;
  mayDo: string;
  mustNever: string;
}

/** The operator's answers to the two §6b questions; everything else in an SOP is HQ's. */
export type AgentAnswers = Omit<NewAgentAnswers, "workspace" | "name">;

/** A drafted agent: its minimal definition (`content`) and the SOP it points to. */
export interface AgentDraft {
  file: string;
  content: string;
  name: string;
  sopFile: string;
  sop: string;
  logsFile: string;
}

function agentIntro(ws: WorkspaceId, name: string): string {
  return `You are ${name}, a ${ws} sub-agent of J/OS. You run inside the ${ws} executor, rooted in JOS/${ws}/, and you execute; you never delegate or start other agent sessions.`;
}

/** The operator-owned sections, in the exact text HQ has always written, so answers read back unchanged. */
function operatorSections(ws: WorkspaceId, a: AgentAnswers): string {
  const connList = a.connections.map((c) => `- ${c.platform} · "${c.name}"`).join("\n") || "- (none)";
  return `## Purpose
${a.purpose.trim()}

## Allowed connections
${connList}
Use no other connection. Resolve each connection's key live with \`one --agent connection list\`, from JOS/${ws}/ only.

## What you may do with them
${a.mayDo.trim()}

## What you must never do
${a.mustNever.trim()}`;
}

function guardrailLines(ws: WorkspaceId): string {
  const cfg = loadConfig().workspaces[ws];
  return `- Identity first: before anything else run \`one --agent config path\` and \`one --agent whoami\`; projectRoot must end in \\JOS\\${ws} and the account must be ${cfg.expectedEmail}. If not, stop and report.
- One CLI only for every external service; no SDKs, direct HTTP, curl or web tools. Actions: search → knowledge → execute; never guess an action or parameter.
- Blast radius: anything that sends, publishes, deletes, charges, overwrites or changes permissions is dry-run first and proposed with its exact payload; it runs only after operator approval, through HQ's approved-action runner.
- Rate limits: paginate, batch, bounded concurrency, exponential backoff on 429, no tight loops; state expected call volume before loops.
- Cost: name paid surfaces (OpenRouter, Exa, Tavily, Firecrawl, Stripe) and estimate call counts; stop and ask if material.
- Idempotency: never blindly retry a non-idempotent action after an ambiguous result; verify whether it happened first.
- Secrets: never output keys, tokens, passwords or cookies; refer to connections by name.
- Verification: tool success is not objective success; read back the resulting state and report IDs.
- Think critically about the real runtime state: inspect before acting, adapt when reality contradicts the plan, and stop to verify rather than declaring success.`;
}

/** An old-format definition's inline instructions, as HQ wrote them before SOP.md (read back only for migration). */
function definitionBody(ws: WorkspaceId, name: string, a: AgentAnswers): string {
  return `${agentIntro(ws, name)}\n\n${operatorSections(ws, a)}\n\n## Guardrails (set by the J/OS Orchestrator)\n${guardrailLines(ws)}`;
}

function sopContent(ws: WorkspaceId, name: string, a: AgentAnswers): string {
  return `# ${name} — standard operating procedure
${SOP_MARK}
Written by J/OS HQ from the operator's answers. Change it through HQ's Agents page; HQ keeps the previous version in jos-hq/data/agent-history/.

${agentIntro(ws, name)}

${operatorSections(ws, a)}

## Guardrails (set by the J/OS Orchestrator)
${guardrailLines(ws)}

## How you work
- You are an operator, not a script. Work out what the objective needs from the real state, not from a fixed list of steps.
- Check your identity first (see Guardrails), then inspect: look up each action you need (\`one --agent actions search\`, then \`one --agent actions knowledge\`), and read the current state before you change anything.
- Resolve your own identifiers (IDs, folders, records, versions) with reads. Ask the operator only about intent, never about something you can look up.
- Stay inside your purpose and your allowed connections. When what you find contradicts the request or this SOP, stop and say so rather than guessing.
- Anything that sends, creates, updates, deletes, publishes, charges or changes permissions is proposed with its exact payload for approval; it runs only through HQ's approved-action runner.
- Workflows, automations and anything recurring are One Flows: create → validate → dry-run → fix → dry-run again.

## What you return
- A short, plain answer for the operator: what you did, what you found, and what is still open.
- The IDs, links and file paths of everything you created or changed.
- What a later run of this agent should know. Keep candidate, customer and other personal details out of your summary and lessons: HQ writes them to your LOGS.md.

## Verification
- Tool success is not objective success. After any change, read the resulting state back and compare it with what was asked.
- Report exactly what you verified and how. If you could not verify something, say so.
`;
}

export function draftAgentDefinition(a: NewAgentAnswers): AgentDraft {
  const name = agentKeyFor(a.workspace, a.name);
  const dirs = agentDirs();
  const file = a.workspace === "One" ? path.join(dirs.claude, `${name}.md`) : path.join(dirs.codex, `${name}.toml`);
  const cfg = loadConfig().workspaces[a.workspace].executor;
  const folder = path.join(path.dirname(file), name);
  return { file, name, content: minimalDefinition(a.workspace, name, a.purpose, cfg.model, cfg.effort), sopFile: path.join(folder, "SOP.md"), sop: sopContent(a.workspace, name, a), logsFile: path.join(folder, "LOGS.md") };
}

/** A key is taken when a definition with it is listed, or its file or folder is already on disk. */
export function agentNameTaken(ws: WorkspaceId, key: string): boolean {
  if (findAgent(ws, key)) return true;
  const dirs = agentDirs();
  const file = ws === "One" ? path.join(dirs.claude, `${key}.md`) : path.join(dirs.codex, `${key}.toml`);
  return fs.existsSync(file) || fs.existsSync(path.join(path.dirname(file), key));
}

function assertAnswered(a: AgentAnswers) {
  if (!a.connections.length) throw new Error("Question 1 is unanswered: choose the specific connections this agent may use.");
  if (!a.purpose.trim() || !a.mayDo.trim() || !a.mustNever.trim()) throw new Error("Question 2 is unanswered: describe what it is for, what it may do, and what it must never do.");
}

export function createAgentDefinition(a: NewAgentAnswers): { file: string; name: string } {
  assertAnswered(a);
  const d = draftAgentDefinition(a);
  const ap = agentPaths(d.file);
  if (!ap.ok) throw new Error(ap.error);
  if (fs.existsSync(d.file) || fs.existsSync(ap.paths.folder)) throw new Error(`${d.name} already exists; HQ never overwrites an agent definition or its folder.`);
  fs.mkdirSync(ap.paths.dir, { recursive: true });
  fs.mkdirSync(ap.paths.folder);
  try {
    // The folder first and the definition last: a definition never points to a missing SOP.
    writeFileAtomic(ap.paths.sop, d.sop, { exclusive: true });
    writeFileAtomic(ap.paths.logs, logsHeader(d.name), { exclusive: true });
    fs.writeFileSync(d.file, d.content, { flag: "wx" });
  } catch (e) {
    fs.rmSync(ap.paths.folder, { recursive: true, force: true });
    throw e;
  }
  signal("agents_updated", { workspace: a.workspace });
  return { file: d.file, name: d.name };
}

// ---- editing and deleting a sub-agent ----------------------------------------------------------------
// Edit re-asks the two questions and rewrites the SOP with HQ's current guardrails; the raw files are
// never edited from the UI and LOGS.md is never touched. Only agents in the Orchestrator-level folders
// are changed, and the previous version is kept in data/agent-history/ first (those folders are not in git).

export type AgentEditState = { hash: string } & ({ editable: true; answers: AgentAnswers } | { editable: false; reason: string });

const SECTION = {
  purpose: "\n## Purpose\n",
  connections: "\n## Allowed connections\n",
  mayDo: "\n## What you may do with them\n",
  mustNever: "\n## What you must never do\n",
  guardrails: "\n## Guardrails (set by the J/OS Orchestrator)\n",
};

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** HQ deletes only agents in the Orchestrator-level folders; test fixture folders are read-only. */
export function agentDeletable(def: AgentDefinition): boolean {
  return inOrchestratorFolders(def.file);
}

/** The operator-owned stretch of a definition's instructions: from its Purpose heading to its guardrails. */
function answerSpan(instructions: string): string | null {
  const text = `\n${instructions.replace(/\r\n/g, "\n")}`;
  const start = text.indexOf(SECTION.purpose);
  const end = start < 0 ? -1 : text.indexOf(SECTION.guardrails, start);
  return end < 0 ? null : text.slice(start, end);
}

function parseAnswers(span: string): AgentAnswers | null {
  // Headings are found in their fixed order, so an answer that contains its own "## " line still parses.
  const at: number[] = [];
  let from = 0;
  for (const h of [SECTION.purpose, SECTION.connections, SECTION.mayDo, SECTION.mustNever]) {
    const i = span.indexOf(h, from);
    if (i < 0) return null;
    at.push(i);
    from = i + h.length;
  }
  const between = (k: number, h: string) => span.slice(at[k] + h.length, k + 1 < at.length ? at[k + 1] : undefined).trim();
  const connections = [...between(1, SECTION.connections).matchAll(/^- (.+?) · "(.*)"$/gm)].map((m) => ({ platform: m[1], name: m[2] }));
  return { purpose: between(0, SECTION.purpose), connections, mayDo: between(2, SECTION.mayDo), mustNever: between(3, SECTION.mustNever) };
}

/** The answers HQ can read back from an old-format definition written by its New Agent form, or null. */
export function legacyAnswers(def: AgentDefinition): AgentAnswers | null {
  const legacy = def.harness === "codex" && /developer_instructions\s*=\s*"""/.test(fs.readFileSync(def.file, "utf8"));
  const span = answerSpan(def.instructions);
  const parsed = span === null ? null : parseAnswers(legacy ? span.replace(/\\"""/g, '"""') : span);
  if (!span || !parsed) return null;
  const rendered = definitionBody(def.workspace, def.key, parsed);
  return answerSpan(legacy ? rendered.replace(/"""/g, '\\"""') : rendered) === span ? parsed : null;
}

function stateHash(def: AgentDefinition): string {
  const defText = fs.readFileSync(def.file, "utf8");
  const sopText = def.format === "sop" && def.sopFile && !def.sopError ? fs.readFileSync(def.sopFile, "utf8") : "";
  return sha256(`${defText}\n\u0000\n${sopText}`);
}

export function agentEditState(def: AgentDefinition): AgentEditState {
  const hash = stateHash(def);
  const base = path.basename(def.file);
  if (!inOrchestratorFolders(def.file)) return { hash, editable: false, reason: `${base} is outside the Orchestrator-level agent folders, so HQ only reads it.` };
  if ((def.workspace === "One") !== (def.harness === "claude")) return { hash, editable: false, reason: `${base} is a ${def.harness === "claude" ? "Claude" : "Codex"} definition for ${def.workspace}, and HQ writes ${def.workspace} agents in the other format, so it only reads this one.` };
  if (def.format === "legacy") return { hash, editable: false, reason: `${base} is in the old format, with its instructions inside the definition. Migrate it first (Migrate on this page, or node jos-hq/bin/jos.mjs agents migrate).` };
  if (def.sopError) return { hash, editable: false, reason: def.sopError };
  const notHq = { hash, editable: false as const, reason: `${path.basename(def.sopFile!)} of ${def.key} was not written by HQ's New Agent form, so HQ cannot read your answers back from it. Edit the file directly, or delete the agent and create it again.` };
  const span = answerSpan(fs.readFileSync(def.sopFile!, "utf8"));
  const parsed = span === null ? null : parseAnswers(span);
  if (!span || !parsed) return notHq;
  // Only offer an edit when re-rendering the answers reproduces the file's own text exactly.
  if (answerSpan(sopContent(def.workspace, def.key, parsed)) !== span) return notHq;
  return { hash, editable: true, answers: parsed };
}

/** What an edit would write, for review before it is saved. */
export function draftAgentEdit(ws: WorkspaceId, key: string, a: AgentAnswers): AgentDraft {
  const def = findAgent(ws, key);
  if (!def) throw new Error(`No sub-agent ${key} configured for ${ws}`);
  const state = agentEditState(def);
  if (!state.editable) throw new Error(state.reason);
  const cfg = loadConfig().workspaces[ws].executor;
  return {
    file: def.file,
    name: def.key,
    content: minimalDefinition(ws, def.key, a.purpose, def.model ?? cfg.model, def.effort ?? cfg.effort),
    sopFile: def.sopFile!,
    sop: sopContent(ws, def.key, a),
    logsFile: def.logsFile ?? path.join(path.dirname(def.sopFile!), "LOGS.md"),
  };
}

function agentBusyTasks(ws: WorkspaceId, key: string): BusyTask[] {
  return busyTasks("origin = 'agent' AND json_extract(context_json, '$.agent.workspace') = ? AND json_extract(context_json, '$.agent.name') = ?", [ws, key]);
}

/** A copy of the definition (and, before an edit, its SOP) in data/agent-history/<name>.<time>.<kind>/. */
function archiveAgent(def: AgentDefinition, kind: "before-edit" | "deleted"): string {
  const dest = path.join(dataDir(), "agent-history", `${def.key}.${nowIso().replace(/[:.]/g, "-")}.${kind}`);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(def.file, path.join(dest, path.basename(def.file)), fs.constants.COPYFILE_EXCL);
  if (kind === "before-edit" && def.sopFile && fs.existsSync(def.sopFile)) fs.copyFileSync(def.sopFile, path.join(dest, "SOP.md"), fs.constants.COPYFILE_EXCL);
  return dest;
}

export type AgentChangeRefusal =
  | { reason: "not_found" }
  | { reason: "read_only"; message: string }
  | { reason: "busy"; tasks: BusyTask[] }
  | { reason: "changed" };

/**
 * Rewrites the SOP from new answers (and the definition when its description changes). `baseHash` is the
 * hash the form was opened with, so an edit made elsewhere in the meantime is refused rather than
 * overwritten. Refused while any of the agent's tasks is busy: the prompts re-read the SOP at every
 * phase, so an edit between an approved preview and its execute run would run instructions the operator
 * never approved.
 */
export function updateAgentDefinition(ws: WorkspaceId, key: string, a: AgentAnswers, baseHash: string): ({ updated: true; file: string; name: string; hash: string; archived: string }) | ({ updated: false } & AgentChangeRefusal) {
  assertAnswered(a);
  const def = findAgent(ws, key);
  if (!def) return { updated: false, reason: "not_found" };
  const state = agentEditState(def);
  if (!state.editable) return { updated: false, reason: "read_only", message: state.reason };
  if (state.hash !== baseHash) return { updated: false, reason: "changed" };
  const busy = agentBusyTasks(ws, def.key);
  if (busy.length) return { updated: false, reason: "busy", tasks: busy };
  const draft = draftAgentEdit(ws, def.key, a);
  const archived = archiveAgent(def, "before-edit");
  writeFileAtomic(def.sopFile!, draft.sop);
  if (fs.readFileSync(def.file, "utf8") !== draft.content) writeFileAtomic(def.file, draft.content);
  signal("agents_updated", { workspace: ws, agent: def.key });
  return { updated: true, file: def.file, name: def.key, hash: sha256(`${draft.content}\n\u0000\n${draft.sop}`), archived };
}

/**
 * Deletes the agent: its definition and whole folder (SOP.md and LOGS.md) move to data/agent-history/, so
 * its history survives and its name is free; its conversations and their messages go. Its tasks and their
 * telemetry stay, and the central logs are never touched.
 */
export function deleteAgentDefinition(ws: WorkspaceId, key: string): { deleted: true; conversations: number; archived: string } | ({ deleted: false } & AgentChangeRefusal) {
  const def = findAgent(ws, key);
  if (!def) return { deleted: false, reason: "not_found" };
  if (!agentDeletable(def)) return { deleted: false, reason: "read_only", message: `${path.basename(def.file)} is outside the Orchestrator-level agent folders, so HQ only reads it.` };
  const result = tx((): ReturnType<typeof deleteAgentDefinition> => {
    const busy = agentBusyTasks(ws, def.key);
    if (busy.length) return { deleted: false, reason: "busy", tasks: busy };
    const n = get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_conversations WHERE workspace = ? AND agent = ?", [ws, def.key])?.n ?? 0;
    run("DELETE FROM agent_messages WHERE conversation_id IN (SELECT id FROM agent_conversations WHERE workspace = ? AND agent = ?)", [ws, def.key]);
    run("DELETE FROM agent_conversations WHERE workspace = ? AND agent = ?", [ws, def.key]);
    // The files last: if they cannot be moved, the transaction rolls back and the agent stays whole.
    const archived = archiveAgent(def, "deleted");
    const folder = def.sopFile ? path.dirname(def.sopFile) : null;
    const movedFolder = folder && fs.existsSync(folder) ? path.join(archived, path.basename(folder)) : null;
    try {
      if (movedFolder) fs.renameSync(folder!, movedFolder);
      fs.unlinkSync(def.file);
    } catch (e) {
      if (movedFolder && fs.existsSync(movedFolder) && !fs.existsSync(folder!)) fs.renameSync(movedFolder, folder!);
      fs.rmSync(archived, { recursive: true, force: true });
      throw e;
    }
    return { deleted: true, conversations: n, archived };
  });
  if (result.deleted) signal("agents_updated", { workspace: ws, agent: def.key });
  return result;
}

// ---- migrating old-format agents (spec 3.8) -----------------------------------------------------------

export interface MigrationResult {
  workspace: WorkspaceId;
  name: string;
  status: "migrated" | "skipped" | "failed";
  detail: string;
}

/**
 * Moves old-format definitions (instructions inside the definition) to the SOP layout: the definition is
 * copied to data/agent-history/ first, its instructions become SOP.md word for word, LOGS.md starts empty,
 * and the definition is reduced to its minimal form with the same name, description, model and effort.
 * Safe to run again: migrated agents are skipped, an existing folder is never overwritten, and a failure
 * partway is undone. Keys do not change, so conversations stay attached; no log entry is invented.
 */
export function migrateAgentDefinitions(hooks: { beforeDefinitionRewrite?: (name: string) => void } = {}): MigrationResult[] {
  const out: MigrationResult[] = [];
  for (const def of listAgentDefinitions()) {
    const r = (status: MigrationResult["status"], detail: string) => out.push({ workspace: def.workspace, name: def.key, status, detail });
    if (!inOrchestratorFolders(def.file)) {
      r("skipped", "outside the Orchestrator-level agent folders; HQ only reads it");
      continue;
    }
    const ap = agentPaths(def.file);
    if (!ap.ok) {
      r("failed", ap.error);
      continue;
    }
    if (def.format === "sop") {
      r("skipped", fs.existsSync(ap.paths.sop) ? "already migrated" : "already has a folder; not overwritten");
      continue;
    }
    if (def.key !== ap.paths.name) {
      r("failed", `its name "${def.key}" differs from its file name ${ap.paths.name}; rename one to match first`);
      continue;
    }
    if (agentBusyTasks(def.workspace, def.key).length) {
      r("skipped", "a task of this agent is running, waiting or unreconciled");
      continue;
    }
    const original = fs.readFileSync(def.file, "utf8");
    // HQ's first TOML writer escaped """ inside a triple-quoted string; the SOP holds the text itself.
    const tripleQuoted = def.harness === "codex" && /developer_instructions\s*=\s*"""/.test(original);
    const body = tripleQuoted ? def.instructions.replace(/\\"""/g, '"""') : def.instructions;
    const archiveDir = path.join(dataDir(), "agent-history");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.copyFileSync(def.file, path.join(archiveDir, `${def.key}.${nowIso().replace(/[:.]/g, "-")}.before-migrate${path.extname(def.file)}`), fs.constants.COPYFILE_EXCL);
    try {
      fs.mkdirSync(ap.paths.folder);
    } catch (e) {
      r("failed", `cannot create ${ap.paths.folder}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    try {
      writeFileAtomic(ap.paths.sop, `# ${def.key} — standard operating procedure\n${SOP_MARK}\nMigrated by J/OS HQ on ${nowIso().slice(0, 10)} from the instructions that were inside ${path.basename(def.file)}, word for word.\n\n${body.trim()}\n`, { exclusive: true });
      writeFileAtomic(ap.paths.logs, logsHeader(def.key), { exclusive: true });
      hooks.beforeDefinitionRewrite?.(def.key);
      const cfg = loadConfig().workspaces[def.workspace].executor;
      writeFileAtomic(def.file, minimalDefinition(def.workspace, def.key, def.description, def.model ?? cfg.model, def.effort ?? cfg.effort));
      r("migrated", `${path.basename(def.file)} + ${def.key}/SOP.md + ${def.key}/LOGS.md`);
    } catch (e) {
      fs.rmSync(ap.paths.folder, { recursive: true, force: true });
      if (fs.readFileSync(def.file, "utf8") !== original) fs.writeFileSync(def.file, original);
      r("failed", e instanceof Error ? e.message : String(e));
    }
  }
  if (out.some((x) => x.status === "migrated")) signal("agents_updated", {});
  return out;
}
