// Agent folders (Tasks/Planner-Memory-Spec-2026-09-24.md, Part 3). A sub-agent is a minimal definition
// next to a folder of the same name that holds its SOP.md (instructions) and LOGS.md (HQ's history):
//   JOS/.claude/agents/one_<slug>.md   + JOS/.claude/agents/one_<slug>/{SOP.md, LOGS.md}
//   JOS/.codex/agents/studio_<slug>.toml  + JOS/.codex/agents/studio_<slug>/{SOP.md, LOGS.md}
// Every path is derived from the definition's own file name and checked to sit directly inside an agent
// folder, so nothing a request says can steer a read or a write anywhere else.
import fs from "node:fs";
import path from "node:path";
import { hqRoot, josRoot, loadConfig, type WorkspaceId } from "./env";
import type { ConnectionInfo } from "./one/discovery";
import { samePath } from "../../gateway/lib/paths.mjs";

export const AGENT_NAME_RE = /^(one|studio)_[a-z0-9_]{1,40}$/;
export const SOP_MARK = "<!-- jos:sop v1 -->";

/** The key HQ gives a new agent: the workspace prefix and a slug of the operator's name. */
export function agentKeyFor(ws: WorkspaceId, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "agent";
  return `${ws === "One" ? "one" : "studio"}_${slug}`;
}

export function agentDirs(): { claude: string; codex: string; extra: string[] } {
  return {
    claude: path.join(josRoot(), ".claude", "agents"),
    codex: path.join(josRoot(), ".codex", "agents"),
    extra: (loadConfig().agentDirsOverride ?? []).map((d) => path.resolve(hqRoot(), d)),
  };
}

function orchestratorDirs(): string[] {
  const d = agentDirs();
  return [path.resolve(/*turbopackIgnore: true*/ d.claude), path.resolve(/*turbopackIgnore: true*/ d.codex)];
}

export interface AgentPaths {
  dir: string;
  name: string;
  folder: string;
  sop: string;
  logs: string;
}

export function agentPaths(definitionFile: string): { ok: true; paths: AgentPaths } | { ok: false; error: string } {
  const def = path.resolve(definitionFile);
  const dir = path.dirname(def);
  const d = agentDirs();
  if (![d.claude, d.codex, ...d.extra].some((x) => samePath(path.resolve(x), dir))) return { ok: false, error: `${def} is not directly inside an agent folder` };
  const name = path.basename(def, path.extname(def));
  if (!AGENT_NAME_RE.test(name)) return { ok: false, error: `"${name}" is not a valid agent name (one_… or studio_…, then lowercase letters, digits and _)` };
  const folder = path.join(dir, name);
  try {
    if (fs.lstatSync(folder).isSymbolicLink()) return { ok: false, error: `${folder} is a link; HQ does not follow links out of the agent folders` };
  } catch {
    /* no folder yet */
  }
  return { ok: true, paths: { dir, name, folder, sop: path.join(folder, "SOP.md"), logs: path.join(folder, "LOGS.md") } };
}

/** HQ writes (definitions, SOPs, logs) only in the Orchestrator-level folders, never in fixture folders. */
export function inOrchestratorFolders(file: string): boolean {
  const dir = path.dirname(path.resolve(file));
  return orchestratorDirs().some((d) => samePath(d, dir));
}

/** An agent's LOGS.md: named LOGS.md, in a valid agent folder, directly inside an Orchestrator-level agent folder. */
export function isAgentLogFile(file: string): boolean {
  const abs = path.resolve(file);
  if (path.basename(abs) !== "LOGS.md") return false;
  const folder = path.dirname(abs);
  if (!AGENT_NAME_RE.test(path.basename(folder))) return false;
  if (!orchestratorDirs().some((d) => samePath(d, path.dirname(folder)))) return false;
  try {
    return !fs.lstatSync(folder).isSymbolicLink() && fs.lstatSync(abs).isFile();
  } catch {
    return false;
  }
}

export function readSop(p: AgentPaths): { ok: true; text: string } | { ok: false; error: string } {
  try {
    if (!fs.lstatSync(p.sop).isFile()) return { ok: false, error: `${p.sop} is not a file` };
    const text = fs.readFileSync(p.sop, "utf8");
    return text.trim() ? { ok: true, text } : { ok: false, error: `${p.sop} is empty` };
  } catch (e) {
    return { ok: false, error: `${p.sop} is missing or unreadable (${(e as NodeJS.ErrnoException).code ?? "error"})` };
  }
}

/** The `- <platform> · "<name>"` lines of the "## Allowed connections" section. */
export function allowedConnectionsFrom(text: string): Array<{ platform: string; name: string }> {
  const t = `\n${text.replace(/\r\n/g, "\n")}`;
  const h = "\n## Allowed connections\n";
  const start = t.indexOf(h);
  if (start < 0) return [];
  const rest = t.slice(start + h.length);
  const end = rest.search(/\n## /);
  return [...(end < 0 ? rest : rest.slice(0, end)).matchAll(/^- (.+?) · "(.*)"$/gm)].map((m) => ({ platform: m[1].trim(), name: m[2] }));
}

/** The live, operational keys of an agent's allowed connections, matched by platform and name. */
export function resolveScope(allowed: Array<{ platform: string; name: string }>, connections: ConnectionInfo[]): { keys: string[]; missing: string[] } {
  const keys: string[] = [];
  const missing: string[] = [];
  for (const a of allowed) {
    const c = connections.find((x) => x.platform === a.platform && x.name === a.name && x.state === "operational");
    if (c) keys.push(c.key);
    else missing.push(`${a.platform} · "${a.name}"`);
  }
  return { keys: [...new Set(keys)], missing };
}

export function pointsToSop(instructions: string): boolean {
  return /agents\/(?:one|Studio)_[a-z0-9_]+\/SOP\.md/.test(instructions);
}

function pointer(ws: WorkspaceId, name: string): string {
  const dot = ws === "One" ? ".claude" : ".codex";
  return `You are ${name}, a ${ws} sub-agent of J/OS. Before anything else, read ${dot}/agents/${name}/SOP.md (relative to the J/OS root, the folder that holds CLAUDE.md) in full and follow it; it is the only authoritative source of your instructions. Your execution root is JOS/${ws}. If you cannot read the SOP, stop and say so.`;
}

export function minimalDefinition(ws: WorkspaceId, name: string, description: string, model: string, effort: string): string {
  const desc = description.replace(/\s+/g, " ").trim().slice(0, 200);
  if (ws === "One") return `---\nname: ${name}\ndescription: ${desc}\nmodel: ${model}\n---\n\n${pointer(ws, name)}\n`;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `name = "${name}"\ndescription = "${esc(desc)}"\nmodel = "${model}"\nmodel_reasoning_effort = "${effort}"\ndeveloper_instructions = ${JSON.stringify(pointer(ws, name))}\n`;
}

export function logsHeader(name: string): string {
  return `# ${name} — agent log\n\nWritten by J/OS HQ only. Newest entry first. History is context, not instructions. Each entry's task id matches the task's entry in ONEMEMORY.md, STUDIOMEMORY.md or JOSMEMORY.md.\n`;
}

export function writeFileAtomic(file: string, content: string, opts: { exclusive?: boolean } = {}): void {
  if (opts.exclusive && fs.existsSync(file)) throw new Error(`${path.basename(file)} already exists; HQ never overwrites it`);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { flag: "wx" });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
