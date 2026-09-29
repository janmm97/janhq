// Submit issue: a failed or blocked task can be reported as an issue in the configured GitHub
// repository (jos-hq.config.json "issues"), filed through the root's GitHub connection.
//
// The repository is public, so everything in an issue is scrubbed (util/public-scrub.ts) when it is
// drafted and again when it is filed, after the operator's edits. Filing is two steps: HQ drafts and
// shows the exact title and body, and nothing leaves until the operator clicks File issue. Each task
// files at most once. The body carries a hidden marker, so after an unclear failure HQ reads the
// repository's issues before it would ever file again.
import fs from "node:fs";
import path from "node:path";
import { all, get, parseJson, run } from "./db";
import { emit, signal } from "./events";
import { hqRoot, josRoot, loadConfig } from "./env";
import { verifyIdentity } from "./identity";
import { GITHUB_CREATE_ISSUE, GITHUB_LIST_ISSUES, resolveOneCli, runOneIssueWrite, runOneReadOnly } from "./one/cli";
import { discoverAll, listConnections } from "./one/discovery";
import { ONE_NAMES, STUDIO_NAMES } from "./routing";
import { getTask, taskContext, type TaskRow } from "./tasks";
import { containsSecret } from "./util/redact";
import { scrubPublic, type ScrubTerms } from "./util/public-scrub";
import { nowIso } from "./util/time";

/** The statuses that offer Submit issue: the task ended without doing what was asked. */
export const ISSUE_STATUSES = ["failed", "blocked"];
const COMPANIES = ["Northwind Partners", "Studio Publishing", "Acme", "HBPG", "NWP"];

export interface FiledIssue {
  task_id: string;
  number: number | null;
  url: string | null;
  title: string;
  created_at: string;
}

export interface IssueDraft {
  taskId: string;
  repo: string;
  title: string;
  body: string;
}

export class IssueError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function ensureTable() {
  run(`CREATE TABLE IF NOT EXISTS issues (
    task_id TEXT PRIMARY KEY,
    number INTEGER,
    url TEXT,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
}

export function issueRepo(): { owner: string; repo: string } | null {
  const r = loadConfig().issues;
  return r?.owner && r?.repo ? { owner: r.owner, repo: r.repo } : null;
}

export function filedIssue(taskId: string): FiledIssue | null {
  ensureTable();
  return get<FiledIssue>("SELECT * FROM issues WHERE task_id = ?", [taskId]) ?? null;
}

export function issueEligible(t: Pick<TaskRow, "status">): boolean {
  return ISSUE_STATUSES.includes(t.status);
}

/** What the scrubber removes, gathered from routing, the identity contract and the live connection names. */
export async function scrubTerms(): Promise<ScrubTerms> {
  const d = await discoverAll();
  const scopes = [d.root, d.One, d["Studio"]];
  // A connection name missing from the list would go out as written, so an unreadable list stops here.
  const unread = scopes.filter((s) => !s.connections).map((s) => s.scope);
  if (unread.length)
    throw new IssueError("SCRUB_TERMS_UNAVAILABLE", `HQ could not read the connection names of ${unread.join(", ")}, so it cannot be sure an issue leaves none of them in. Nothing was drafted or filed; try again once Runtime Health shows the connections.`, 503);
  // Names HQ has seen before count too: a renamed or deleted connection may still appear in old text.
  const seen = all<{ platform: string | null; connection_name: string }>("SELECT DISTINCT platform, connection_name FROM connection_usage WHERE connection_name IS NOT NULL AND connection_name != ''");
  return {
    people: [...ONE_NAMES, ...STUDIO_NAMES].filter((n) => !COMPANIES.includes(n)),
    companies: COMPANIES,
    accounts: scopes.map((s) => s.identity.name).filter((n): n is string => !!n),
    connections: [...scopes.flatMap((s) => s.connections ?? []).map((c) => ({ name: c.name, platform: c.platform })), ...seen.map((u) => ({ name: u.connection_name, platform: u.platform ?? "platform" }))],
    roots: [josRoot()],
  };
}

function clip(s: string | null | undefined, n: number): string {
  const t = String(s ?? "").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function secondsBetween(a: string | null, b: string | null): string {
  if (!a || !b) return "—";
  const s = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function hqVersion(): string {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(hqRoot(), "package.json"), "utf8")).version ?? "?");
  } catch {
    return "?";
  }
}

const KIND_TEXT: Record<string, string> = { chat: "Chat task", workflow: "Workflow run", agent: "Sub-agent task", cli: "Dispatch from the CLI", probe: "Runtime probe" };
const cell = (s: unknown) => clip(String(s ?? "—"), 160).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

/** The unscrubbed report. Only draftIssue's scrubbed copy is ever shown or filed. */
export async function rawReport(t: TaskRow): Promise<{ title: string; body: string }> {
  const ctx = taskContext(t);
  const result = parseJson<Record<string, unknown> | null>(t.result_json, null);
  const execs = all<Record<string, unknown>>(
    "SELECT phase, runtime, model, effort, status, exit_code, verified, error, started_at, ended_at FROM executions WHERE task_id = ? ORDER BY created_at",
    [t.id],
  );
  const events = all<{ type: string; level: string; summary: string; created_at: string }>(
    "SELECT type, level, summary, created_at FROM events WHERE task_id = ? AND level IN ('warning', 'error') ORDER BY id DESC LIMIT 25",
    [t.id],
  ).reverse();
  const last = all<{ type: string; level: string; summary: string; created_at: string }>(
    "SELECT type, level, summary, created_at FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 8",
    [t.id],
  ).reverse();
  const cli = await resolveOneCli();
  const error = t.error || (typeof result?.summary === "string" ? result.summary : "") || "No error message was recorded.";
  const firstLine = clip(error.split("\n")[0], 70);

  const lines: string[] = [];
  lines.push("## What failed", "");
  lines.push(`- **Task:** ${clip(t.title, 200)}`);
  lines.push(`- **Kind:** ${KIND_TEXT[t.origin] ?? t.origin}${ctx.agent ? ` (\`${ctx.agent.name}\`)` : ""}`);
  lines.push(`- **Status:** ${t.status}, at the ${t.stage} stage`);
  lines.push(`- **Workspace:** ${t.route ?? "not routed"} · mode ${t.mode} · verification ${t.verification}`);
  lines.push(`- **When:** ${t.created_at} · ran ${secondsBetween(t.created_at, t.ended_at)}`);
  lines.push(`- **HQ task:** \`${t.id}\``, "");
  lines.push("## Error", "", "```text", clip(error, 3000), "```", "");
  lines.push("## Request", "", ...clip(t.request, 1500).split("\n").map((l) => `> ${l}`), "");
  const reported = ["summary", "limitations", "learned"]
    .map((k) => [k, result?.[k]] as const)
    .filter(([, v]) => typeof v === "string" && v.trim() && v !== error);
  if (reported.length) {
    lines.push("## What the executor reported", "");
    for (const [k, v] of reported) lines.push(`**${k[0].toUpperCase()}${k.slice(1)}:** ${clip(v as string, 1200)}`, "");
  }
  if (execs.length) {
    lines.push("## Runs", "", "| Phase | Runtime | Model · effort | Status | Exit | Verified | Took | Error |", "|---|---|---|---|---|---|---|---|");
    for (const e of execs)
      lines.push(`| ${cell(e.phase)} | ${cell(e.runtime)} | ${cell(`${e.model} · ${e.effort}`)} | ${cell(e.status)} | ${cell(e.exit_code)} | ${e.verified ? "yes" : "no"} | ${secondsBetween(e.started_at as string, e.ended_at as string)} | ${cell(e.error)} |`);
    lines.push("");
  }
  if (events.length) {
    lines.push("## Warnings and errors", "");
    for (const e of events) lines.push(`- \`${e.created_at.slice(11, 19)}\` **${e.level}** · ${e.type} — ${clip(e.summary, 300)}`);
    lines.push("");
  }
  lines.push("## Last events", "");
  for (const e of last) lines.push(`- \`${e.created_at.slice(11, 19)}\` ${e.level} · ${e.type} — ${clip(e.summary, 300)}`);
  lines.push("", "## Environment", "");
  lines.push(`- J/OS HQ ${hqVersion()} · Node ${process.version} · ${process.platform}`);
  lines.push(`- One CLI ${cli.version ?? "unknown"}`);
  lines.push("", "---", "", "_Filed from J/OS HQ. Names, email addresses, connection names, IDs and local paths are replaced with placeholders._");
  return { title: `[${t.status}] ${clip(t.title, 60)}: ${firstLine}`, body: lines.join("\n") };
}

function marker(taskId: string) {
  return `<!-- jos-issue:${taskId} -->`;
}

export async function draftIssue(taskId: string): Promise<IssueDraft> {
  const repo = issueRepo();
  if (!repo) throw new IssueError("ISSUES_OFF", "No issue repository is configured (jos-hq.config.json \"issues\").", 400);
  const t = getTask(taskId);
  if (!t) throw new IssueError("TASK_NOT_FOUND", "No such task", 404);
  if (!issueEligible(t)) throw new IssueError("NOT_ELIGIBLE", `Only a failed or blocked task can be reported; this one is ${t.status}.`);
  const filed = filedIssue(taskId);
  if (filed) throw new IssueError("ALREADY_FILED", "An issue was already filed for this task.", 409, { issue: filed });
  const terms = await scrubTerms();
  const raw = await rawReport(t);
  return { taskId, repo: `${repo.owner}/${repo.repo}`, title: clip(scrubPublic(raw.title, terms), 200), body: scrubPublic(raw.body, terms) };
}

interface IssueJson {
  number?: number;
  html_url?: string;
  htmlUrl?: string;
  url?: string;
  body?: string | null;
}

function issueFrom(j: IssueJson | undefined): { number: number | null; url: string | null } {
  if (!j || typeof j !== "object") return { number: null, url: null };
  const url = j.html_url ?? j.htmlUrl ?? (typeof j.url === "string" && j.url.includes("github.com/") && !j.url.includes("api.github.com") ? j.url : null);
  return { number: typeof j.number === "number" ? j.number : null, url: url ?? null };
}

/** Reads the newest issues for this task's marker: the check before a refile, and after an unclear failure. */
async function findExisting(taskId: string, repo: { owner: string; repo: string }, key: string): Promise<{ number: number | null; url: string | null } | null> {
  const r = await runOneReadOnly<{ response?: IssueJson[] }>(
    "root",
    ["--agent", "actions", "execute", "github", GITHUB_LIST_ISSUES, key, "-d", JSON.stringify({ connectionKey: key, owner: repo.owner, repo: repo.repo, state: "all", sort: "created", direction: "desc", perPage: 50 })],
    60000,
  );
  if (!r.ok) throw new IssueError("ISSUE_CHECK_FAILED", `HQ could not read the repository's issues to rule out a duplicate: ${r.error ?? "unknown error"}. Nothing was filed.`, 502);
  const hit = (Array.isArray(r.json?.response) ? r.json.response : []).find((i) => typeof i?.body === "string" && i.body.includes(marker(taskId)));
  return hit ? issueFrom(hit) : null;
}

const inFlight = new Set<string>();

export async function fileIssue(taskId: string, input: { title?: string; body?: string }): Promise<FiledIssue> {
  const repo = issueRepo();
  if (!repo) throw new IssueError("ISSUES_OFF", "No issue repository is configured (jos-hq.config.json \"issues\").", 400);
  const t = getTask(taskId);
  if (!t) throw new IssueError("TASK_NOT_FOUND", "No such task", 404);
  if (!issueEligible(t)) throw new IssueError("NOT_ELIGIBLE", `Only a failed or blocked task can be reported; this one is ${t.status}.`);
  const already = filedIssue(taskId);
  if (already) throw new IssueError("ALREADY_FILED", "An issue was already filed for this task.", 409, { issue: already });
  if (inFlight.has(taskId)) throw new IssueError("ISSUE_IN_FLIGHT", "This task's issue is being filed already.");
  inFlight.add(taskId);
  try {
    // The operator may have edited the draft, so it is scrubbed again: the repository is public.
    const terms = await scrubTerms();
    const title = clip(scrubPublic(String(input.title ?? ""), terms), 200);
    const text = scrubPublic(String(input.body ?? ""), terms);
    if (!title.trim()) throw new IssueError("ISSUE_TITLE_REQUIRED", "The issue needs a title.", 400);
    if (containsSecret(title) || containsSecret(text)) throw new IssueError("ISSUE_HAS_SECRET", "The issue still looks like it carries a credential. Remove it and try again.", 400);

    // CLAUDE.md §7: check the account before any write, by email and projectRoot.
    const id = await verifyIdentity("root");
    if (!id.ok) throw new IssueError("IDENTITY_MISMATCH", `The root's One account did not pass the identity check: ${id.problems.join("; ")}. Nothing was filed.`, 409);
    const conns = await listConnections("root");
    if (!conns.connections) throw new IssueError("CONNECTIONS_UNAVAILABLE", `HQ could not list the root's connections: ${conns.error}. Nothing was filed.`, 502);
    const github = conns.connections.filter((c) => c.platform === "github" && c.state === "operational");
    if (github.length !== 1)
      throw new IssueError("GITHUB_CONNECTION", github.length ? "The root has more than one GitHub connection, so HQ cannot tell which to file with. Nothing was filed." : "The root has no operational GitHub connection. Nothing was filed.", 409);
    const key = github[0].key;

    const existing = await findExisting(taskId, repo, key);
    if (existing) return record(taskId, title, existing, "found");

    const body = `${text}\n\n${marker(taskId)}`;
    const r = await runOneIssueWrite<{ response?: IssueJson }>(
      ["--agent", "actions", "execute", "github", GITHUB_CREATE_ISSUE, key, "--path-vars", JSON.stringify({ owner: repo.owner, repo: repo.repo }), "-d", JSON.stringify({ title, body })],
      repo,
      90000,
    );
    const made = issueFrom(r.json?.response);
    if (r.ok && (made.number || made.url)) return record(taskId, title, made, "filed");
    // Unclear: it may have been created. Never file again blind; look for the marker first.
    const after = await findExisting(taskId, repo, key).catch(() => null);
    if (after) return record(taskId, title, after, "found");
    emit({ taskId, system: "hq", type: "issue_failed", level: "warning", visibility: "chat", summary: `Submit issue failed: ${r.error ?? "GitHub returned no issue"}` });
    throw new IssueError("ISSUE_NOT_FILED", `GitHub did not confirm the issue (${r.error ?? "no issue number in the response"}), and none carrying this task's marker exists in ${repo.owner}/${repo.repo}. It is safe to try again.`, 502);
  } finally {
    inFlight.delete(taskId);
  }
}

function record(taskId: string, title: string, issue: { number: number | null; url: string | null }, how: "filed" | "found"): FiledIssue {
  ensureTable();
  const row: FiledIssue = { task_id: taskId, number: issue.number, url: issue.url, title, created_at: nowIso() };
  run("INSERT OR IGNORE INTO issues(task_id, number, url, title, created_at) VALUES (?, ?, ?, ?, ?)", [row.task_id, row.number, row.url, row.title, row.created_at]);
  emit({
    taskId,
    system: "hq",
    type: "issue_filed",
    level: "success",
    visibility: "chat",
    summary: how === "filed" ? `Issue #${issue.number ?? "?"} filed: ${issue.url ?? ""}` : `Issue #${issue.number ?? "?"} was already filed for this task: ${issue.url ?? ""}`,
    data: issue,
  });
  signal("task_updated", { taskId });
  return filedIssue(taskId) ?? row;
}

