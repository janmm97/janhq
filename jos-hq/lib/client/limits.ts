// Question 2 as toggles (Tasks/HQ-Redesign-Spec-2026-09-25.md, 3.5). Each chosen connection gets a row of
// verbs, each "may" or "never", written into SOP.md as lines of one exact shape:
//   - gmail · "Main Support": read, draft
// Edit reads a line of that shape back for a chosen connection; every other line stays, word for word, in
// the free text. Limits are instructions the agent follows; HQ enforces only the connection list.

export type Verdict = "may" | "never" | null;
export interface LimitConnection {
  platform: string;
  name: string;
}
export interface LimitRow extends LimitConnection {
  verbs: Array<{ verb: string; verdict: Verdict }>;
}
export interface Limits {
  rows: LimitRow[];
  mayFree: string;
  neverFree: string;
}

const VERBS: Record<string, string[]> = {
  gmail: ["read", "draft", "send", "delete"],
  notion: ["read", "create and edit", "delete"],
  slack: ["read", "post", "delete"],
  stripe: ["read", "create", "refund or charge"],
  "google-drive": ["read", "create and edit", "share", "delete"],
  "google-calendar": ["read", "create and edit", "invite or cancel"],
  exa: ["use (paid)"],
  tavily: ["use (paid)"],
  firecrawl: ["use (paid)"],
  "open-router": ["use (paid)"],
};

export function verbsFor(platform: string): string[] {
  return VERBS[platform] ?? ["read", "write", "delete"];
}

/** A connection just chosen: its first verb may, the rest never. */
export function newLimitRow(c: LimitConnection): LimitRow {
  return { platform: c.platform, name: c.name, verbs: verbsFor(c.platform).map((verb, i) => ({ verb, verdict: i === 0 ? "may" : "never" })) };
}

/** A connection an older SOP chose with no lines: nothing set, so nothing is written until it is touched. */
export function blankLimitRow(c: LimitConnection): LimitRow {
  return { platform: c.platform, name: c.name, verbs: verbsFor(c.platform).map((verb) => ({ verb, verdict: null })) };
}

/** Flips one verb: may becomes never, never becomes may, and an unset verb becomes may. */
export function flip(row: LimitRow, verb: string): LimitRow {
  return { ...row, verbs: row.verbs.map((v) => (v.verb === verb ? { ...v, verdict: v.verdict === "may" ? "never" : "may" } : v)) };
}

function section(rows: LimitRow[], verdict: "may" | "never", free: string): string {
  const lines = rows
    .map((r) => ({ r, verbs: r.verbs.filter((v) => v.verdict === verdict).map((v) => v.verb) }))
    .filter((x) => x.verbs.length > 0)
    .map((x) => `- ${x.r.platform} · "${x.r.name}": ${x.verbs.join(", ")}`);
  return [lines.join("\n"), free.trim()].filter(Boolean).join("\n\n");
}

/** The two SOP sections as HQ writes them: the toggles' lines, then the free text. */
export function limitsToText(l: Limits): { mayDo: string; mustNever: string } {
  return { mayDo: section(l.rows, "may", l.mayFree), mustNever: section(l.rows, "never", l.neverFree) };
}

const LINE = /^- ([a-z0-9-]+) · "(.*)": (.+)$/;
const rowKey = (c: LimitConnection) => `${c.platform}\u0000${c.name}`;

function readSection(text: string, chosen: LimitConnection[], verdict: "may" | "never", into: Map<string, Map<string, Verdict>>): string {
  const free: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const m = LINE.exec(raw);
    const c = m ? chosen.find((x) => x.platform === m[1] && x.name === m[2]) : undefined;
    const verbs = m ? m[3].split(", ") : [];
    // Owned only once per section, and only with this platform's own verbs, each named once.
    if (!c || seen.has(rowKey(c)) || !verbs.every((v) => verbsFor(c.platform).includes(v)) || new Set(verbs).size !== verbs.length) {
      free.push(raw);
      continue;
    }
    seen.add(rowKey(c));
    const row = into.get(rowKey(c)) ?? new Map<string, Verdict>();
    for (const v of verbs) row.set(v, verdict);
    into.set(rowKey(c), row);
  }
  return free.join("\n").trim();
}

/** Reads the two sections back: lines of the exact shape set a chosen connection's toggles; the rest is free text. */
export function textToLimits(text: { mayDo: string; mustNever: string }, chosen: LimitConnection[]): Limits {
  const set = new Map<string, Map<string, Verdict>>();
  const mayFree = readSection(text.mayDo, chosen, "may", set);
  const neverFree = readSection(text.mustNever, chosen, "never", set);
  const rows = chosen.map((c) => {
    const got = set.get(rowKey(c));
    return got ? { platform: c.platform, name: c.name, verbs: verbsFor(c.platform).map((verb) => ({ verb, verdict: got.get(verb) ?? null })) } : blankLimitRow(c);
  });
  return { rows, mayFree, neverFree };
}

/** True when the agent is told at least one thing it must never do, by a toggle or in words. */
export function hasNever(l: Limits): boolean {
  return !!l.neverFree.trim() || l.rows.some((r) => r.verbs.some((v) => v.verdict === "never"));
}
