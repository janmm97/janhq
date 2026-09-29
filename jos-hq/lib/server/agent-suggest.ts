// Suggestions for New agent (Tasks/HQ-Redesign-Spec-2026-09-25.md, 3.3 and 3.4). Word-based and read-only:
// they only pre-tick, the operator's ticks are the answer, and HQ never guesses between several
// connections of one platform; it asks which one.
import { AGENT_NAME_RE, agentKeyFor } from "./agent-files";
import { PLATFORM_TERMS, impliedPlatforms, mentionsAffirmatively } from "./routing";
import type { WorkspaceId } from "./env";

export interface SuggestConnection {
  platform: string;
  name: string;
  state: string;
}

export interface AgentSuggestion {
  name: { input: string; suggested: string; key: string; valid: boolean; free: boolean };
  connections: SuggestConnection[];
  picks: Array<{ platform: string; name: string; reason: "named" | "only"; why: string }>;
  ask: Array<{ platform: string; label: string; question: string; options: SuggestConnection[] }>;
  missing: string[];
  discoveryError: string | null;
}

/** What POST /api/agents/suggest answers: the suggestion plus the workspace's planner pin, for the test print. */
export type AgentSuggestResponse = AgentSuggestion & { planner: { modelLabel: string; effort: string } };

const STOP = new Set(
  "a an the and or of to for in on with from into by at it its is are be this that these those my our their his her all any each every then so as up out about over via per me us you your we i".split(" "),
);

/** The purpose's first three content words: "Triage the Main Support inbox…" → "triage main support". */
export function suggestName(purpose: string): string {
  return purpose
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .slice(0, 3)
    .join(" ");
}

function nameRe(name: string): RegExp {
  return new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
}

export function suggestFrom(input: { workspace: WorkspaceId; purpose: string; name: string }, connections: SuggestConnection[], discoveryError: string | null, taken: (key: string) => boolean): AgentSuggestion {
  // A connection without a name is never offered: SOP.md's "## Allowed connections" names each one as
  // `- platform · "name"`, and a nameless connection could never be written there or matched back.
  const conns = connections.filter((c) => typeof c.name === "string" && c.name.trim()).map((c) => ({ platform: c.platform, name: c.name, state: c.state }));
  const picks: AgentSuggestion["picks"] = [];
  for (const c of conns) {
    if (c.name.trim() && mentionsAffirmatively(input.purpose, nameRe(c.name))) picks.push({ platform: c.platform, name: c.name, reason: "named", why: `"${c.name}" is named in the purpose` });
  }
  const ask: AgentSuggestion["ask"] = [];
  const missing: string[] = [];
  for (const p of impliedPlatforms(input.purpose)) {
    if (picks.some((x) => x.platform === p)) continue;
    const label = PLATFORM_TERMS.find((t) => t.platform === p)?.label ?? p;
    const of = conns.filter((c) => c.platform === p);
    if (of.length === 1) picks.push({ platform: p, name: of[0].name, reason: "only", why: `the purpose implies ${label}, and ${input.workspace} has one ${label} connection` });
    else if (of.length > 1) ask.push({ platform: p, label, question: `Which one? ${input.workspace} has ${of.length} ${label} connections.`, options: of });
    else if (!discoveryError) missing.push(label);
  }
  const suggested = suggestName(input.purpose);
  const key = agentKeyFor(input.workspace, input.name.trim() || suggested);
  return { name: { input: input.name, suggested, key, valid: AGENT_NAME_RE.test(key), free: !taken(key) }, connections: conns, picks, ask, missing, discoveryError };
}
