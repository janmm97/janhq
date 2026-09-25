// Log-first reuse (Tasks/Planner-Memory-Spec-2026-09-24.md, Part 2) and per-agent history (3.6).
// Deterministic and lexical on purpose: no model call decides whether a task is a repeat.
import fs from "node:fs";
import path from "node:path";
import { josRoot, logFileFor, type WorkspaceId } from "./env";
import { detectEntities } from "./routing";
import { redactSecrets } from "./util/redact";

export interface LogEntry {
  file: string;
  /** Position in its file; files are newest first, so a lower index is newer. */
  index: number;
  date: string | null;
  title: string;
  taskId: string | null;
  status: string;
  asked: string;
  outcome: string;
  artifacts: string;
  learned: string;
}

const HEADING = /^## (?:(\d{4}-\d{2}-\d{2})\s*·\s*)?(.*?)(?:\s*<!-- jos:run=([^\s>]+) -->)?\s*$/;
const BULLET = /^- \*\*([^*]+):\*\*\s?(.*)$/;
const STATUSES = ["in progress", "done", "blocked", "abandoned", "partial"];

export function parseLogEntries(text: string, file: string): LogEntry[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: LogEntry[] = [];
  let head: RegExpMatchArray | null = null;
  let body: string[] = [];
  const flush = () => {
    if (!head) return;
    const fields: Record<string, string> = {};
    let label: string | null = null;
    for (const l of body) {
      const m = l.match(BULLET);
      if (m) {
        // The first bullet of a label wins; a later one (a Reconciled note, say) never overwrites it.
        const k = m[1].trim().toLowerCase();
        label = k in fields ? null : k;
        if (label) fields[label] = m[2].trim();
      } else if (label && /^\s{2,}\S/.test(l)) {
        fields[label] = `${fields[label]} ${l.trim()}`.trim();
      } else {
        label = null;
      }
    }
    const rawStatus = (fields.status ?? "").toLowerCase();
    out.push({
      file,
      index: out.length,
      date: head[1] ?? null,
      title: (head[2] ?? "").trim(),
      taskId: head[3] ?? null,
      status: STATUSES.find((st) => rawStatus.startsWith(st)) ?? rawStatus.split(/[\s—(]/)[0] ?? "",
      asked: fields.asked ?? "",
      outcome: fields.outcome ?? "",
      artifacts: fields.artifacts ?? "",
      learned: fields.learned ?? "",
    });
    head = null;
    body = [];
  };
  for (const l of lines) {
    if (l.startsWith("## ")) {
      flush();
      head = l.match(HEADING);
    } else if (l.trim() === "---") {
      flush();
    } else if (head) {
      body.push(l);
    }
  }
  flush();
  return out;
}

export function readEntries(files: string[]): LogEntry[] {
  return files.flatMap((f) => {
    try {
      return parseLogEntries(fs.readFileSync(f, "utf8"), f);
    } catch {
      return [];
    }
  });
}

export function logSources(ws: WorkspaceId, agentLog: string | null): string[] {
  return [path.join(josRoot(), logFileFor(ws)), path.join(josRoot(), logFileFor("none")), ...(agentLog ? [agentLog] : [])];
}

/** The operator's words from an Asked line, without the context HQ appends. */
export function cleanAsked(asked: string): string {
  return asked
    .replace(/\s*\(continues "[^"]*", HQ task [^)]*\)\s*$/, "")
    .replace(/\s*Earlier in this conversation \(for context only\):[\s\S]*$/, "")
    .trim();
}

const STOP = new Set(
  "a an and are as at be but by can could do does for from get go have i if in into is it its just make me my now of on or our please so that the their them then there these this to up us use using via was we what when which will with would you your one each every also".split(" "),
);

export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

const URL_RE = /https?:\/\/[^\s)"'>]+/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Names, emails, URLs, numbers and quoted phrases: two requests must agree on all of them to match. */
export function identifiers(text: string): Set<string> {
  const ids = new Set<string>();
  const e = detectEntities(text);
  for (const n of [...e.one, ...e.studio]) ids.add(`name:${n.toLowerCase()}`);
  for (const m of text.matchAll(EMAIL_RE)) ids.add(`email:${m[0].toLowerCase()}`);
  for (const m of text.matchAll(URL_RE)) ids.add(`url:${m[0].toLowerCase().replace(/[.,;]+$/, "")}`);
  const bare = text.replace(URL_RE, " ").replace(EMAIL_RE, " ");
  for (const m of bare.matchAll(/\b\d[\d,.:/-]*\d\b|\b\d\b/g)) ids.add(`num:${m[0].replace(/,/g, "")}`);
  for (const m of text.matchAll(/"([^"]{2,80})"|“([^”]{2,80})”/g)) ids.add(`quote:${(m[1] ?? m[2]).toLowerCase().trim()}`);
  return ids;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

export const MATCH_THRESHOLD = 0.75;
export const MIN_CONTENT_WORDS = 4;

export interface Match {
  entry: LogEntry;
  score: number;
}

/** Negative when `a` is newer than `b`. */
function newer(a: LogEntry, b: LogEntry): number {
  const d = (b.date ?? "").localeCompare(a.date ?? "");
  if (d) return d;
  return a.file === b.file ? a.index - b.index : 0;
}

/** Close matches, best score first and newer first on ties. */
export function findMatches(request: string, entries: LogEntry[], excludeTaskId: string | null): Match[] {
  const words = contentWords(request);
  if (words.size < MIN_CONTENT_WORDS) return [];
  const ids = identifiers(request);
  const out: Match[] = [];
  for (const e of entries) {
    if (excludeTaskId && e.taskId === excludeTaskId) continue;
    const asked = cleanAsked(e.asked);
    const w = contentWords(asked);
    if (w.size < MIN_CONTENT_WORDS) continue;
    const score = jaccard(words, w);
    if (score < MATCH_THRESHOLD || !sameSet(ids, identifiers(asked))) continue;
    out.push({ entry: e, score });
  }
  return out.sort((a, b) => b.score - a.score || newer(a.entry, b.entry));
}

export type MemoryDecision = { kind: "reuse"; match: Match; lessons: Match[] } | { kind: "plan"; lessons: Match[] };

/** The newest close match decides: done → reuse; anything else → plan with the lessons. */
export function decide(matches: Match[]): MemoryDecision {
  if (!matches.length) return { kind: "plan", lessons: [] };
  const newest = [...matches].sort((a, b) => newer(a.entry, b.entry))[0];
  const lessons = matches.filter((m) => m.entry.status !== "done").slice(0, 2);
  return newest.entry.status === "done" ? { kind: "reuse", match: newest, lessons } : { kind: "plan", lessons };
}

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function renderEntry(e: LogEntry): string {
  return [
    `- ${e.date ?? "undated"} · ${e.title} [${e.status || "unknown"}]${e.taskId ? ` (task ${e.taskId})` : ""} — ${path.basename(e.file)}`,
    `  Asked: ${clip(cleanAsked(e.asked), 300)}`,
    e.outcome ? `  Outcome: ${clip(e.outcome, 600)}` : "",
    e.artifacts && e.artifacts !== "none" ? `  Artifacts: ${clip(e.artifacts, 300)}` : "",
    e.learned && e.learned !== "nothing beyond the outcome" ? `  Learned: ${clip(e.learned, 500)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderLessons(lessons: Match[]): string | null {
  return lessons.length ? redactSecrets(lessons.map((m) => renderEntry(m.entry)).join("\n")) : null;
}

/** An agent's LOGS.md, trimmed for a prompt: unfinished work first, then the newest, then related entries. */
export function agentHistory(logsFile: string, request: string, excludeTaskId: string | null, budget = 6000): string | null {
  // Newest first by date, whatever order a hand edit left the file in.
  const entries = readEntries([logsFile])
    .filter((e) => e.taskId !== excludeTaskId)
    .sort(newer);
  if (!entries.length) return null;
  const unfinished = entries.filter((e) => !["done", "abandoned"].includes(e.status));
  const recent = entries.slice(0, 5).filter((e) => !unfinished.includes(e));
  const words = contentWords(request);
  const related = entries
    .filter((e) => !unfinished.includes(e) && !recent.includes(e))
    .map((e) => ({ e, s: jaccard(words, contentWords(cleanAsked(e.asked))) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => x.e);
  let text = "";
  outer: for (const [title, group] of [
    ["Unfinished (open, blocked or partial)", unfinished],
    ["Most recent", recent],
    ["Related older entries", related],
  ] as const) {
    if (!group.length) continue;
    const head = `${text ? "\n\n" : ""}${title}:`;
    if (text.length + head.length > budget) break;
    text += head;
    for (const e of group) {
      const block = `\n${renderEntry(e)}`;
      if (text.length + block.length > budget) break outer;
      text += block;
    }
  }
  text += `\n\nOlder entries: ${logsFile} (read it if you need more; do not write it).`;
  return redactSecrets(text.trim());
}
