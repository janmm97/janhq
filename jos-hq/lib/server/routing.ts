// J/OS routing (CLAUDE.md §2), implemented deterministically in the order the contract's steps give:
//   1. explicit user selection (UI selector, or an explicit phrase such as "use Studio to ...")
//   2. named entities, then named flows (live `flow list` per workspace)
//   3. topic signals (weaker than names; a platform topic counts only if the live connection split
//      makes it exclusive)
//   4. live connection lookup (fresh `connection list` from JOS/One and JOS/Studio, never the root)
//   5. ask, with the evidence found
// Routing stops at the first step that yields a single safe answer. There is no capability-fit or
// "recently used" tiebreaker. Matching is case-insensitive and semantic, never naive substring:
// "one" and "Studio" are ordinary English/numbers most of the time and only count in entity context.
import type { WorkspaceId } from "./env";
import type { ConnectionInfo, FlowInfo } from "./one/discovery";

export type RouteSelection = "auto" | WorkspaceId;
export type RouteStep = "explicit" | "entity" | "flow" | "topic" | "connection" | "conversation";

export interface RoutingSignal {
  step: RouteStep | "platform";
  label: string;
  workspace: WorkspaceId | "both" | null;
  detail?: string;
}

export interface RouteDecision {
  kind: "routed" | "clarify";
  workspace?: WorkspaceId;
  step?: RouteStep;
  reason: string;
  signals: RoutingSignal[];
  question?: string;
  options?: Array<{ value: WorkspaceId | "none"; label: string }>;
  warnings: string[];
  impliedPlatforms: string[];
}

export const ONE_NAMES = ["Riley", "Owen", "Devin", "Maxwell", "Max", "Arjun", "Felix", "Rowan", "Priya", "Miles", "Harper", "Noel", "Elias", "Acme"];
export const STUDIO_NAMES = ["Blake", "Hugo", "HBPG", "NWP"];

function nameRe(name: string): RegExp {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${esc}(?:['’]s|s['’])?(?![A-Za-z0-9])`, "i");
}

// "One" and "Studio" are an English word and a number far more often than they are an organization, so
// they count only in entity context: possessive, a following business noun, or a preceding
// preposition not followed by a numeral-ish word. "ONE" in capitals and "withone" always count.
const PREP = new Set(["at", "for", "from", "to", "with", "via", "inside", "within", "under", "on", "by"]);
const ONE_SUFFIX = new Set([
  "systems", "org", "organization", "team", "account", "workspace", "executor", "inc", "company", "side", "business",
  "brand", "website", "domain", "mailbox", "mailboxes", "support", "slack", "stripe", "notion", "gmail", "customer",
  "customers", "hq", "engineering", "ops", "finance", "sales", "marketing", "legal", "hiring", "roster", "contract",
  "contracts", "msa", "jan", "people", "staff", "employees", "founders", "board",
]);
const ONE_NOT_AFTER = new Set(["of", "more", "day", "time", "thing", "another", "or", "last", "big", "small", "single", "page", "week", "month", "year", "second", "minute", "hour", "point", "way", "by"]);
const STUDIO_SUFFIX = new Set([
  "publishing", "team", "side", "account", "workspace", "executor", "business", "org", "organization", "drive", "gmail",
  "calendar", "notion", "openrouter", "exa", "tavily", "firecrawl", "books", "book", "authors", "author", "titles", "title",
]);
const STUDIO_NOT_AFTER = new Set(["percent", "emails", "email", "messages", "items", "rows", "records", "files", "pages", "people", "users", "dollars", "usd", "times", "units", "k", "m", "and", "of"]);

interface Tok {
  raw: string;
  base: string;
  possessive: boolean;
}
function tokens(text: string): Tok[] {
  return (text.match(/[^\s,;:!?()"“”[\]{}]+/g) ?? []).map((raw) => {
    const possessive = /['’]s$/i.test(raw);
    const base = raw.replace(/['’]s$/i, "").replace(/[.]+$/, "");
    return { raw, base, possessive };
  });
}
const plain = (t?: Tok) => (t ? t.base.toLowerCase().replace(/[^a-z0-9]/g, "") : "");

function mentionsOneOrg(text: string): boolean {
  if (/\bwithone(?:\.ai)?\b/i.test(text)) return true;
  const ts = tokens(text);
  return ts.some((t, k) => {
    if (t.base === "ONE") return true;
    if (t.base !== "One") return false;
    const next = plain(ts[k + 1]);
    if (t.possessive || ONE_SUFFIX.has(next)) return true;
    return PREP.has(plain(ts[k - 1])) && !ONE_NOT_AFTER.has(next);
  });
}

function mentionsStudioOrg(text: string): boolean {
  const ts = tokens(text);
  return ts.some((t, k) => {
    if (t.base !== "Studio") return false; // "$226", "226.5", "1226" are numbers, not Studio Publishing
    const next = plain(ts[k + 1]);
    if (t.possessive || STUDIO_SUFFIX.has(next)) return true;
    return PREP.has(plain(ts[k - 1])) && !STUDIO_NOT_AFTER.has(next) && !/^\d/.test(next);
  });
}

const EXPLICIT: Array<{ re: RegExp; ws: (m: RegExpMatchArray) => WorkspaceId | null }> = [
  {
    re: /^\s*(?:please\s+)?(?:use|have|ask|let|get|tell)\s+(?:the\s+)?(One|Studio)(?:\s+(?:executor|workspace|agent|side))?\s+(?:to|for)\b/i,
    ws: (m) => (m[1] === "Studio" ? "Studio" : m[1] === "One" || /executor|workspace|agent|side/i.test(m[0]) ? "One" : null),
  },
  {
    re: /\b(?:route|send|delegate|dispatch|hand|give|assign)\s+(?:this|it|the task)\s+(?:over\s+)?to\s+(?:the\s+)?(One|Studio)(?:\s+(?:executor|workspace|side))?\b/i,
    ws: (m) => (m[1] === "Studio" ? "Studio" : "One"),
  },
  { re: /\b(?:in|on|from|via|through)\s+the\s+(One|Studio)\s+(?:executor|workspace)\b/i, ws: (m) => (m[1] === "Studio" ? "Studio" : "One") },
];

interface Topic {
  label: string;
  re: RegExp;
  workspace: WorkspaceId;
  platform?: string;
}
// CLAUDE.md §2 step 2, as decided by Jan on 2026-09-23: tool names (Gmail, Notion, Google Sheets) are
// not topic signals. A tool routes only through the live connection lookup, when exactly one account
// has it. The `platform` field stays for any future tool-bound topic: it counts only then.
const TOPICS: Topic[] = [
  { label: "scorecard", re: /\bscore\s?cards?\b/i, workspace: "Studio" },
  { label: "KPIs", re: /\bKPIs?\b/i, workspace: "Studio" },
  { label: "Apps Script", re: /\bapps?\s+script\b/i, workspace: "Studio" },
  { label: "metrics", re: /\bmetrics?\b/i, workspace: "Studio" },
  { label: "conditional formatting", re: /\bconditional\s+formatting\b/i, workspace: "Studio" },
  { label: "One Systems", re: /\bOne\s+Systems\b/i, workspace: "One" },
  { label: "SOC 2", re: /\bSOC[\s-]?2\b/i, workspace: "One" },
  { label: "Scrut", re: /\bScrut\b/i, workspace: "One" },
  { label: "contracts", re: /\bcontracts?\b/i, workspace: "One" },
  { label: "MSA", re: /\bMSAs?\b/, workspace: "One" },
  { label: "hiring", re: /\bhiring\b|\bhire\b/i, workspace: "One" },
  { label: "team roster", re: /\bteam\s+roster\b/i, workspace: "One" },
  { label: "customer support", re: /\bcustomer\s+support\b/i, workspace: "One" },
];

export const PLATFORM_TERMS: Array<{ platform: string; label: string; re: RegExp }> = [
  { platform: "slack", label: "Slack", re: /\bslack\b/i },
  { platform: "stripe", label: "Stripe", re: /\bstripe\b|\b(?:refund|invoice|payout|payment intent)s?\b|\bcharge (?:the|a|their|his|her)\b/i },
  { platform: "google-drive", label: "Google Drive", re: /\bgoogle\s+drive\b|\bg-?drive\b|\bdrive\s+(?:folder|file|doc)s?\b|\bin\s+(?:the\s+)?drive\b/i },
  { platform: "google-calendar", label: "Google Calendar", re: /\bgoogle\s+calendar\b|\bgcal\b|\bcalendar\b|\b(?:meeting|event)\s+invites?\b|\bschedule\s+(?:a|the|an)\s+(?:meeting|call|event)\b/i },
  { platform: "gmail", label: "Gmail", re: /\bgmail\b|\be-?mail(?:s|ed|ing)?\b|\binbox\b|\bmailbox(?:es)?\b/i },
  { platform: "notion", label: "Notion", re: /\bnotion\b/i },
  { platform: "firecrawl", label: "Firecrawl", re: /\bfirecrawl\b|\bscrape\b/i },
  { platform: "tavily", label: "Tavily", re: /\btavily\b/i },
  { platform: "exa", label: "Exa", re: /\bexa\b/i },
  { platform: "open-router", label: "OpenRouter", re: /\bopen\s?router\b/i },
];

const NEGATED = /\b(?:do\s+not|don['’]?t|never|no|not|without|avoid|skip|except|nor)\b(?:\s+[\w'’-]+){0,4}\s*$/i;

/** True when `re` matches somewhere in `text` outside a negated clause ("do not read any mailbox"). */
export function mentionsAffirmatively(text: string, re: RegExp): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    const clause = before.split(/[.;:!?\n]|,\s*(?:and|but|then)\b/).pop() ?? "";
    if (!NEGATED.test(clause)) return true;
    if (m[0].length === 0) g.lastIndex++;
  }
  return false;
}

export function impliedPlatforms(text: string): string[] {
  return PLATFORM_TERMS.filter((p) => mentionsAffirmatively(text, p.re)).map((p) => p.platform);
}

const MAIL_INTENT: RegExp[] = [
  // "Gmail" counts as the mail noun too: "Send this from Gmail" names no mailbox, so it must ask.
  /\b(?:send|draft|reply|respond|forward|write|compose|read|summari[sz]e|check|search|find|list|archive|label|triage|clean\s+up|go\s+through)\b[^.;\n]{0,60}\b(?:e-?mails?|g-?mail|inbox|mail(?:box)?|messages?|drafts?|threads?)\b/i,
  /\b[Ee]-?[Mm]ail\s+(?:[A-Z][a-z]+|him|her|them|the\s+(?:team|client|customer))\b/,
  /\bunread\b/i,
];

export function detectEntities(text: string): { one: string[]; studio: string[] } {
  const one = ONE_NAMES.filter((n) => nameRe(n).test(text));
  if (mentionsOneOrg(text)) one.push("One");
  const studio = STUDIO_NAMES.filter((n) => nameRe(n).test(text));
  if (/\bNorthwind/i.test(text)) studio.push("Northwind Partners");
  if (/\bStudio\s*Publishing\b/i.test(text)) studio.push("Studio Publishing");
  else if (mentionsStudioOrg(text)) studio.push("Studio");
  // "Max" also matches inside "Maxwell"'s alternatives; keep the longer name only.
  const uniq = (xs: string[]) => [...new Set(xs)].filter((x, _, arr) => !(x === "Max" && arr.includes("Maxwell")));
  return { one: uniq(one), studio: uniq(studio) };
}

export function detectExplicit(text: string): WorkspaceId | null {
  for (const e of EXPLICIT) {
    const m = text.match(e.re);
    if (m) {
      const ws = e.ws(m);
      if (ws) return ws;
    }
  }
  return null;
}

function owners(platform: string, conns: Record<WorkspaceId, ConnectionInfo[] | null>): WorkspaceId[] {
  return (["One", "Studio"] as WorkspaceId[]).filter((ws) => (conns[ws] ?? []).some((c) => c.platform === platform && c.state === "operational"));
}

function flowHits(text: string, flows: FlowInfo[]): FlowInfo[] {
  const lower = text.toLowerCase();
  return flows.filter((f) => {
    const cands = [f.key, f.name].filter((s) => s && s.length >= 3).map((s) => s.toLowerCase());
    return cands.some((c) => {
      const i = lower.indexOf(c);
      if (i < 0) return false;
      const before = i === 0 ? " " : lower[i - 1];
      const after = i + c.length >= lower.length ? " " : lower[i + c.length];
      return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
    });
  });
}

const CLARIFY_OPTIONS: RouteDecision["options"] = [
  { value: "One", label: "One" },
  { value: "Studio", label: "Studio" },
  { value: "none", label: "Neither — Orchestrator only" },
];

export interface RoutingInputs {
  text: string;
  selection: RouteSelection;
  /** Live flow lists per workspace (null = discovery failed). */
  flows: () => Promise<Record<WorkspaceId, FlowInfo[] | null>>;
  /** FRESH live connection lists per workspace, run from JOS/One and JOS/Studio. */
  connections: () => Promise<Record<WorkspaceId, ConnectionInfo[] | null>>;
}

export async function routeRequest(input: RoutingInputs): Promise<RouteDecision> {
  const { text, selection } = input;
  const signals: RoutingSignal[] = [];
  const warnings: string[] = [];
  const implied = impliedPlatforms(text);

  // 1. Explicit selection wins outright, even over named entities.
  if (selection === "One" || selection === "Studio") {
    return { kind: "routed", workspace: selection, step: "explicit", reason: "Explicit user selection", signals: [{ step: "explicit", label: "Route selector", workspace: selection }], warnings, impliedPlatforms: implied };
  }
  const phrase = detectExplicit(text);
  if (phrase) {
    return { kind: "routed", workspace: phrase, step: "explicit", reason: `Explicit user selection ("${text.match(/\b(use|route|send|delegate|dispatch|hand|give|assign|in|on|via|through|have|ask|let|get|tell)\b[^.?!]*/i)?.[0]?.slice(0, 60) ?? phrase}")`, signals: [{ step: "explicit", label: "Explicit phrase", workspace: phrase }], warnings, impliedPlatforms: implied };
  }

  // 2a. Named entities (decisive; override topics).
  const ent = detectEntities(text);
  for (const n of ent.one) signals.push({ step: "entity", label: n, workspace: "One" });
  for (const n of ent.studio) signals.push({ step: "entity", label: n, workspace: "Studio" });
  if (ent.one.length && ent.studio.length) {
    return {
      kind: "clarify",
      reason: `Names from both businesses: ${ent.one.join(", ")} (One) and ${ent.studio.join(", ")} (Studio). The primary resource and the executor that can finish the whole objective are not determinable from the request alone.`,
      question: `This mentions ${ent.one.join(", ")} (One) and ${ent.studio.join(", ")} (Studio). Which business owns the primary resource and should run this end to end?`,
      options: CLARIFY_OPTIONS,
      signals,
      warnings,
      impliedPlatforms: implied,
    };
  }
  if (ent.one.length || ent.studio.length) {
    const ws: WorkspaceId = ent.one.length ? "One" : "Studio";
    const names = ent.one.length ? ent.one : ent.studio;
    return { kind: "routed", workspace: ws, step: "entity", reason: `Named entity: ${names.join(", ")}`, signals, warnings, impliedPlatforms: implied };
  }

  // 2b. Named flows (a flow's workspace is a filesystem fact, resolved live).
  const flows = await input.flows();
  const flowMatches: Array<{ ws: WorkspaceId; flow: FlowInfo }> = [];
  for (const ws of ["One", "Studio"] as WorkspaceId[]) {
    if (flows[ws] === null) warnings.push(`Flow discovery failed for ${ws}; named-flow routing could not be checked there.`);
    for (const f of flowHits(text, flows[ws] ?? [])) flowMatches.push({ ws, flow: f });
  }
  const flowWs = [...new Set(flowMatches.map((m) => m.ws))];
  for (const m of flowMatches) signals.push({ step: "flow", label: m.flow.name || m.flow.key, workspace: m.ws, detail: m.flow.key });
  if (flowWs.length === 1) {
    return { kind: "routed", workspace: flowWs[0], step: "flow", reason: `Named flow: ${flowMatches[0].flow.name || flowMatches[0].flow.key} (exists only in ${flowWs[0]})`, signals, warnings, impliedPlatforms: implied };
  }

  // Connection lists are needed from here on (topic platform checks and step 4). Always fresh.
  let connsCache: Record<WorkspaceId, ConnectionInfo[] | null> | null = null;
  const conns = async () => (connsCache ??= await input.connections());

  // 3. Topic signals.
  const topicHits = TOPICS.filter((t) => t.re.test(text));
  const decisive: Topic[] = [];
  for (const t of topicHits) {
    if (t.platform) {
      const own = owners(t.platform, await conns());
      if (own.length === 1 && own[0] === t.workspace) {
        decisive.push(t);
        signals.push({ step: "topic", label: t.label, workspace: t.workspace, detail: `${t.platform} is connected only in ${t.workspace}` });
      } else {
        signals.push({
          step: "topic",
          label: t.label,
          workspace: own.length === 2 ? "both" : null,
          detail: own.length === 2 ? `${t.platform} exists in both workspaces — not decisive` : own.length === 0 ? `no live ${t.platform} connection in either workspace — not decisive` : `${t.platform} is connected only in ${own[0]}`,
        });
        if (own.length === 0) warnings.push(`Topic "${t.label}" implies ${t.platform}, which neither executor has connected.`);
      }
    } else {
      decisive.push(t);
      signals.push({ step: "topic", label: t.label, workspace: t.workspace });
    }
  }
  const topicWs = [...new Set(decisive.map((t) => t.workspace))];
  if (topicWs.length === 1) {
    return { kind: "routed", workspace: topicWs[0], step: "topic", reason: `Topic signal: ${decisive.map((t) => t.label).join(", ")} (${topicWs[0]})`, signals, warnings, impliedPlatforms: implied };
  }
  if (topicWs.length > 1) warnings.push(`Topic signals point at both workspaces (${decisive.map((t) => `${t.label}→${t.workspace}`).join(", ")}).`);

  // 4. Live connection lookup.
  const live = await conns();
  for (const ws of ["One", "Studio"] as WorkspaceId[]) if (live[ws] === null) warnings.push(`Connection discovery failed for ${ws}.`);
  if (implied.length) {
    let candidate: WorkspaceId[] = ["One", "Studio"];
    const details: string[] = [];
    let discriminating = false;
    let missing = false;
    for (const p of implied) {
      const own = owners(p, live);
      signals.push({ step: "platform", label: PLATFORM_TERMS.find((x) => x.platform === p)?.label ?? p, workspace: own.length === 2 ? "both" : own[0] ?? null, detail: own.length ? `live in ${own.join(" + ")}` : "not connected in either workspace" });
      if (own.length === 0) missing = true;
      if (own.length === 1) discriminating = true;
      candidate = candidate.filter((ws) => own.includes(ws));
      details.push(`${p}: ${own.length ? own.join(" + ") : "none"}`);
    }
    if (missing) {
      const miss = implied.filter((p) => owners(p, live).length === 0);
      return {
        kind: "clarify",
        reason: `The request needs ${miss.join(", ")}, which neither executor currently has connected (live lookup: ${details.join("; ")}).`,
        question: `This needs ${miss.join(", ")}, which neither One nor Studio has connected right now. Which business should handle it (the executor will report what it cannot reach), or should it wait until the connection is added?`,
        options: CLARIFY_OPTIONS,
        signals,
        warnings,
        impliedPlatforms: implied,
      };
    }
    if (candidate.length === 1 && discriminating) {
      const disc = implied.filter((p) => owners(p, live).length === 1);
      const labels = disc.map((p) => PLATFORM_TERMS.find((x) => x.platform === p)?.label ?? p);
      return { kind: "routed", workspace: candidate[0], step: "connection", reason: `${labels.join(" and ")} ${labels.length > 1 ? "are" : "is"} currently available only in ${candidate[0]}`, signals, warnings, impliedPlatforms: implied };
    }
    if (candidate.length === 0) {
      return {
        kind: "clarify",
        reason: `The platforms involved live in different workspaces (${details.join("; ")}); no single executor can finish this without fragmentation.`,
        question: `This needs ${details.join(", ")} — no single executor has all of them. Which business owns the primary objective? That executor will be told what it cannot reach.`,
        options: CLARIFY_OPTIONS,
        signals,
        warnings,
        impliedPlatforms: implied,
      };
    }
    const shared = implied.map((p) => PLATFORM_TERMS.find((x) => x.platform === p)?.label ?? p);
    return {
      kind: "clarify",
      reason: `No named entity, named flow or decisive topic signal; ${shared.join(", ")} ${shared.length > 1 ? "exist" : "exists"} in both executor environments, so the connection lookup does not settle ownership.`,
      question: `This mentions ${shared.join(" and ")}, and both One and Studio currently have ${shared.length > 1 ? "them" : "it"}. Which business should handle it?`,
      options: CLARIFY_OPTIONS,
      signals,
      warnings,
      impliedPlatforms: implied,
    };
  }

  // 5. Ask.
  return {
    kind: "clarify",
    reason: "No explicit selection, named entity, named flow, topic signal or connection-specific platform identifies the business.",
    question: "Nothing in this request identifies which business it belongs to. Should One or Studio handle it?",
    options: CLARIFY_OPTIONS,
    signals,
    warnings,
    impliedPlatforms: implied,
  };
}

/**
 * A chat message that continues a conversation ("please proceed") is routed by that conversation's
 * business when the message itself carries no signal for either one. Only an undecided ask qualifies:
 * no signals at all, or platforms both executors have. Names from both businesses, conflicting
 * topics, or a platform neither has connected still ask, because those are real ambiguities.
 */
export function continuesConversation(decision: RouteDecision, conversationRoute: WorkspaceId | null | undefined): conversationRoute is WorkspaceId {
  return decision.kind === "clarify" && !!conversationRoute && decision.signals.every((s) => s.workspace === "both");
}

/**
 * One holds several Gmail mailboxes; which one sends is intent, so HQ asks when the request implies
 * Gmail and names none of them (CLAUDE.md §2 step 3). Mailbox names come from the live connection list.
 */
export function mailboxQuestion(text: string, workspace: WorkspaceId, conns: ConnectionInfo[] | null): { question: string; options: string[] } | null {
  if (!impliedPlatforms(text).includes("gmail")) return null;
  // Only when the request actually does something with mail; the bare word is not intent.
  if (!MAIL_INTENT.some((re) => mentionsAffirmatively(text, re))) return null;
  const boxes = (conns ?? []).filter((c) => c.platform === "gmail" && c.state === "operational").map((c) => c.name);
  if (boxes.length <= 1) return null;
  const lower = text.toLowerCase();
  if (boxes.some((b) => lower.includes(b.toLowerCase()))) return null;
  const list = boxes.length === 2 ? boxes.join(" or ") : `${boxes.slice(0, -1).join(", ")}, or ${boxes[boxes.length - 1]}`;
  return { question: `Which ${workspace} mailbox should handle this: ${list}?`, options: boxes };
}
