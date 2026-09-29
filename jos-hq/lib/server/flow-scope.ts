// An agent's connection scope applied to a One Flow run (Tasks/Planner-Memory-Spec-2026-09-24.md, 3.4). A flow
// runs its own actions inside the One CLI, where the gateway cannot see them, so before the run can be approved
// HQ reads the flow's definition and places every action step's connection. A step HQ cannot place inside the
// agent's connections is a problem, and a proposal with a problem cannot be approved by anyone, Auto included.
//
// This checks what the flow says, which is what catches mistakes and drift. It is not a sandbox: a `code.module`
// step has full Node APIs and could call One on its own, like the executor's own shell (CLAUDE.md 6a). Bash
// steps cannot run at all, because jos-approved never passes `--allow-bash`.
import fs from "node:fs";
import path from "node:path";
import type { ConnectionInfo } from "./one/discovery";

export interface FlowScopeCheck {
  workspaceRoot: string;
  flowKey: string;
  inputs: Record<string, unknown>;
  scopeKeys: string[];
  connections: ConnectionInfo[];
}

type Json = Record<string, unknown>;
type Lookup = (name: string) => unknown;

const FLOW_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const INPUT_RE = /^\$\.input\.([A-Za-z0-9_]+)$/;
// The step types of the One Flow reference (skill references/flows.md, "Step Types").
const KNOWN_TYPES = new Set(["action", "transform", "code", "condition", "loop", "parallel", "file-read", "file-write", "while", "flow", "paginate", "bash"]);
const MAX_DEPTH = 5;

const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const isSelector = (v: unknown): v is string => typeof v === "string" && (v.startsWith("$.") || v.includes("{{"));

/** A flow's definition from the workspace, in either layout One writes; null when it cannot be read. */
export function readFlowDefinition(workspaceRoot: string, key: string): Json | null {
  if (!FLOW_KEY_RE.test(key) || key.includes("..")) return null;
  for (const f of [path.join(/*turbopackIgnore: true*/ workspaceRoot, ".one", "flows", key, "flow.json"), path.join(/*turbopackIgnore: true*/ workspaceRoot, ".one", "flows", `${key}.flow.json`)]) {
    try {
      const def = obj(JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ f, "utf8")));
      if (def) return def;
    } catch {
      /* not this layout */
    }
  }
  return null;
}

/** Every reason HQ cannot show that this flow run stays inside the agent's connections; empty when it can. */
export function flowScopeProblems(c: FlowScopeCheck): string[] {
  const def = readFlowDefinition(c.workspaceRoot, c.flowKey);
  if (!def) return [`HQ could not read flow ${c.flowKey}'s definition, so it cannot check the run against this agent's allowed connections`];
  const scope = new Set(c.scopeKeys);
  const problems: string[] = [];

  // Only a whole `$.input.x` selector can be resolved before the run; anything else is decided at run time.
  const resolve = (v: unknown, input: Lookup): { ok: true; value: unknown } | { ok: false } => {
    if (!isSelector(v)) return { ok: true, value: v };
    const m = INPUT_RE.exec(v);
    const value = m ? input(m[1]) : undefined;
    return value === undefined || value === null || value === "" ? { ok: false } : { ok: true, value };
  };
  const nameOf = (key: unknown) => {
    const found = c.connections.find((x) => x.key === key);
    return found ? `"${found.name}"` : String(key);
  };
  // A connection the engine picks when the flow runs must be one of the agent's, whichever it picks.
  const byPlatform = (platform: string, noel: string): string | null => {
    const all = c.connections.filter((x) => x.platform === platform);
    if (!all.length) return `step "${noel}" needs a ${platform} connection, and this workspace has none`;
    const outside = all.filter((x) => !scope.has(x.key));
    if (!outside.length) return null;
    if (outside.length === all.length) return `step "${noel}" uses a ${platform} connection, and none of this agent's allowed connections is ${platform}`;
    return `step "${noel}" uses a ${platform} connection chosen when the flow runs, and ${outside.map((x) => `"${x.name}"`).join(", ")} ${outside.length > 1 ? "are" : "is"} outside this agent's allowed connections; pass the agent's own ${platform} connection key as a flow input instead`;
  };

  const placeAction = (a: Json, noel: string, def: Json, input: Lookup): string | null => {
    const p = resolve(a.platform, input);
    if (!p.ok || typeof p.value !== "string") return `step "${noel}" takes its platform from ${String(a.platform)}, which HQ cannot resolve before the run`;
    if (a.connectionKey !== undefined) {
      const k = resolve(a.connectionKey, input);
      if (k.ok) return typeof k.value === "string" && scope.has(k.value) ? null : `step "${noel}" uses connection ${nameOf(k.value)}, which is outside this agent's allowed connections`;
      // An input with a connection hint auto-resolves to that platform's connection when the run starts.
      const m = INPUT_RE.exec(String(a.connectionKey));
      const hint = m ? obj(obj(obj(def.inputs)?.[m[1]])?.connection)?.platform : undefined;
      if (typeof hint === "string") return byPlatform(hint, noel);
      return `step "${noel}" takes its connection from ${String(a.connectionKey)}, which HQ cannot resolve before the run; pass the connection key as a flow input`;
    }
    const conn = obj(a.connection);
    if (conn) {
      const cp = conn.platform === undefined ? p : resolve(conn.platform, input);
      if (!cp.ok || typeof cp.value !== "string") return `step "${noel}" takes its connection's platform from ${String(conn.platform)}, which HQ cannot resolve before the run`;
      return byPlatform(cp.value, noel);
    }
    return `step "${noel}" names no connection (neither connection nor connectionKey)`;
  };

  const walk = (steps: unknown, def: Json, input: Lookup, stack: string[]): void => {
    if (!Array.isArray(steps)) return;
    for (const s of steps) {
      const step = obj(s);
      if (!step) continue;
      const noel = typeof step.id === "string" ? step.id : "(unnamed)";
      const type = step.type;
      if (typeof type !== "string" || !KNOWN_TYPES.has(type)) {
        problems.push(`step "${noel}" has a step type HQ does not know (${String(type)}), so HQ cannot check its connections`);
        continue;
      }
      const cfg = obj(step[type]);
      const note = (p: string | null) => p && problems.push(p);
      if (type === "action") note(cfg ? placeAction(cfg, noel, def, input) : `step "${noel}" has no action`);
      else if (type === "paginate") note(obj(cfg?.action) ? placeAction(obj(cfg!.action)!, noel, def, input) : `step "${noel}" has no action`);
      else if (type === "loop" || type === "parallel" || type === "while") walk(cfg?.steps, def, input, stack);
      else if (type === "condition") {
        walk(cfg?.then, def, input, stack);
        walk(cfg?.else, def, input, stack);
      } else if (type === "flow") subflow(cfg, noel, input, stack);
    }
  };

  const subflow = (cfg: Json | null, noel: string, input: Lookup, stack: string[]): void => {
    const k = resolve(cfg?.key, input);
    if (!k.ok || typeof k.value !== "string") {
      problems.push(`step "${noel}" runs a sub-flow chosen at run time (${String(cfg?.key)}), so HQ cannot check its connections`);
      return;
    }
    const key = k.value;
    if (stack.includes(key) || stack.length >= MAX_DEPTH) {
      problems.push(`step "${noel}" runs sub-flow ${key} ${stack.includes(key) ? "inside itself" : `more than ${MAX_DEPTH} levels deep`}, so HQ cannot check where it ends`);
      return;
    }
    const child = readFlowDefinition(c.workspaceRoot, key);
    if (!child) {
      problems.push(`step "${noel}" runs sub-flow ${key}, whose definition HQ could not read`);
      return;
    }
    // The sub-flow sees what its caller passes, resolved against the caller's own inputs, or its defaults.
    const bound = obj(cfg?.inputs) ?? {};
    const childInput: Lookup = (name) => {
      if (bound[name] !== undefined) {
        const r = resolve(bound[name], input);
        return r.ok ? r.value : undefined;
      }
      return obj(obj(child.inputs)?.[name])?.default;
    };
    walk(child.steps, child, childInput, [...stack, key]);
  };

  const topInput: Lookup = (name) => (c.inputs[name] !== undefined ? c.inputs[name] : obj(obj(def.inputs)?.[name])?.default);
  walk(def.steps, def, topInput, [c.flowKey]);
  return [...new Set(problems)];
}
