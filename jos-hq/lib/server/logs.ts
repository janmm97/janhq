// Two-phase J/OS logging (CLAUDE.md §14). HQ is the single serialized writer for entries it opens:
//   phase 1 — the moment the destination is known, insert a newest-first entry whose heading carries a
//             stable anchor `<!-- jos:run=<task id> -->`;
//   phase 2 — after evaluation, edit THAT entry in place (Status, Outcome, Artifacts, Learned, Closed).
// Writes are serialized per file, atomic (temp file + rename), and re-read before commit so a
// concurrent edit by a root session is merged rather than clobbered. Secrets are redacted.
import fs from "node:fs";
import path from "node:path";
import { josRoot } from "./env";
import { isAgentLogFile } from "./agent-files";
import { logDate, logTimestamp } from "./util/time";
import { redactSecrets } from "./util/redact";
import { samePath } from "../../gateway/lib/paths.mjs";

export type LogStatus = "done" | "blocked" | "abandoned" | "partial";

const queues = new Map<string, Promise<unknown>>();
function serialize<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = queues.get(file) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(
    file,
    next.catch(() => undefined),
  );
  return next;
}

const CENTRAL = ["ONEMEMORY.md", "STUDIOMEMORY.md", "JOSMEMORY.md"];

/** The three central logs by name, or an agent's LOGS.md by absolute path inside the agent folders. */
export function logPath(fileName: string): string {
  const base = path.basename(fileName);
  if (CENTRAL.includes(base) && (fileName === base || samePath(path.dirname(path.resolve(fileName)), josRoot()))) return path.join(josRoot(), base);
  if (path.isAbsolute(fileName) && isAgentLogFile(fileName)) return path.resolve(fileName);
  throw new Error(`not a J/OS log: ${fileName}`);
}

/** How a log is named in its entries and results: a central log by its name, an agent log by its path. */
function shownName(file: string): string {
  return CENTRAL.includes(path.basename(file)) && samePath(path.dirname(file), josRoot()) ? path.basename(file) : file;
}

export function anchor(taskId: string): string {
  return `<!-- jos:run=${taskId} -->`;
}

function oneLine(s: string, max = 600): string {
  return redactSecrets(s).replace(/\s+/g, " ").trim().slice(0, max);
}

/** Wrap a "- **Label:** text" bullet at ~90 columns with two-space continuation, like the logs. */
export function bullet(label: string, text: string): string {
  const words = `- **${label}:** ${oneLine(text, 2000)}`.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > 90) {
      lines.push(cur);
      cur = "  " + w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.join("\n");
}

function atomicRewrite(file: string, transform: (current: string) => string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = fs.readFileSync(file, "utf8");
    const nl = before.includes("\r\n") ? "\r\n" : "\n";
    const updated = transform(before.replace(/\r\n/g, "\n")).replace(/\n/g, nl);
    const tmp = `${file}.jos-hq-${process.pid}-${Date.now()}.tmp`;
    fs.writeFileSync(tmp, updated, "utf8");
    // Re-read: if someone else wrote meanwhile, redo the transform on their version.
    const now = fs.readFileSync(file, "utf8");
    if (now !== before) {
      fs.unlinkSync(tmp);
      continue;
    }
    fs.renameSync(tmp, file);
    return;
  }
  throw new Error(`Markdown log update failed: ${path.basename(file)} kept changing under concurrent edits`);
}

export interface OpenEntryInput {
  taskId: string;
  file: string;
  title: string;
  asked: string;
  /** Central logs carry a Route bullet; an agent log names its central log instead (extra). */
  route?: string;
  /** Bullets after Asked/Route and before Opened, e.g. the cross-link between central and agent log. */
  extra?: Array<{ label: string; text: string }>;
  at?: Date;
}

export function openLogEntry(input: OpenEntryInput): Promise<{ file: string; openedAt: string }> {
  const file = logPath(input.file);
  const openedAt = logTimestamp(input.at);
  return serialize(file, () => {
    atomicRewrite(file, (text) => {
      if (text.includes(anchor(input.taskId))) return text; // idempotent
      const heading = `## ${logDate(input.at)} · ${oneLine(input.title, 90)} ${anchor(input.taskId)}`;
      const entry = [
        heading,
        "",
        bullet("Status", "in progress"),
        bullet("Asked", input.asked),
        ...(input.route ? [bullet("Route", input.route)] : []),
        ...(input.extra ?? []).map((x) => bullet(x.label, x.text)),
        bullet("Opened", openedAt),
        "",
      ].join("\n");
      const lines = text.split("\n");
      const idx = lines.findIndex((l) => l.startsWith("## "));
      if (idx === -1) return `${text.replace(/\s*$/, "")}\n\n${entry}`;
      lines.splice(idx, 0, entry);
      return lines.join("\n");
    });
    return { file: shownName(file), openedAt };
  });
}

function entryBounds(lines: string[], taskId: string): { start: number; end: number } | null {
  const start = lines.findIndex((l) => l.startsWith("## ") && l.includes(anchor(taskId)));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ") || lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Index just past the entry's leading bullet list (bullets plus their indented continuations). */
function endOfBullets(lines: string[], start: number, end: number): number {
  let i = start + 1;
  while (i < end && lines[i].trim() === "") i++;
  let last = i;
  for (; i < end; i++) {
    const l = lines[i];
    if (l.startsWith("- ") || (l.startsWith("  ") && l.trim() !== "")) last = i + 1;
    else if (l.trim() === "") break;
    else break;
  }
  return last;
}

export function appendLogNote(taskId: string, fileName: string, label: string, text: string): Promise<void> {
  const file = logPath(fileName);
  return serialize(file, () => {
    atomicRewrite(file, (content) => {
      const lines = content.split("\n");
      const b = entryBounds(lines, taskId);
      if (!b) throw new Error(`Markdown log update failed: no entry anchored ${taskId} in ${path.basename(file)}`);
      const at = endOfBullets(lines, b.start, b.end);
      lines.splice(at, 0, ...bullet(label, text).split("\n"));
      return lines.join("\n");
    });
  });
}

export interface CloseEntryInput {
  taskId: string;
  file: string;
  status: LogStatus;
  outcome: string;
  artifacts: string;
  learned: string;
  /** Bullets before Closed (an agent log's Actions and Open); a null text is left out. */
  extra?: Array<{ label: string; text: string | null }>;
  at?: Date;
}

export function closeLogEntry(input: CloseEntryInput): Promise<{ closedAt: string; alreadyClosed: boolean }> {
  const file = logPath(input.file);
  const closedAt = logTimestamp(input.at);
  return serialize(file, () => {
    let alreadyClosed = false;
    atomicRewrite(file, (content) => {
      const lines = content.split("\n");
      const b = entryBounds(lines, input.taskId);
      if (!b) throw new Error(`Markdown log update failed: no entry anchored ${input.taskId} in ${path.basename(file)}`);
      const body = lines.slice(b.start, b.end);
      if (body.some((l) => l.startsWith("- **Closed:**"))) {
        // Close-out is edited once; a later reconciliation is recorded as its own bullet.
        alreadyClosed = true;
        const at = endOfBullets(lines, b.start, b.end);
        lines.splice(at, 0, ...bullet("Reconciled", `${input.status} — ${input.outcome} (${closedAt})`).split("\n"));
        return lines.join("\n");
      }
      // Replace the first Status bullet (with its continuation lines).
      for (let i = b.start + 1; i < b.end; i++) {
        if (lines[i].startsWith("- **Status:**")) {
          let j = i + 1;
          while (j < b.end && lines[j].startsWith("  ") && lines[j].trim() !== "") j++;
          lines.splice(i, j - i, ...bullet("Status", input.status).split("\n"));
          break;
        }
      }
      const b2 = entryBounds(lines, input.taskId)!;
      const at = endOfBullets(lines, b2.start, b2.end);
      const add = [
        ...bullet("Outcome", input.outcome).split("\n"),
        ...bullet("Artifacts", input.artifacts || "none").split("\n"),
        ...bullet("Learned", input.learned || "nothing beyond the outcome").split("\n"),
        ...(input.extra ?? []).filter((x) => x.text).flatMap((x) => bullet(x.label, x.text!).split("\n")),
        ...bullet("Closed", closedAt).split("\n"),
      ];
      lines.splice(at, 0, ...add);
      return lines.join("\n");
    });
    return { closedAt, alreadyClosed };
  });
}

/** Health probe: the three logs exist and are writable (checked without writing). */
export function logsWritable(): { ok: boolean; detail: string } {
  const problems: string[] = [];
  for (const f of ["ONEMEMORY.md", "STUDIOMEMORY.md", "JOSMEMORY.md"]) {
    const p = path.join(/*turbopackIgnore: true*/ josRoot(), f);
    try {
      fs.accessSync(p, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
      problems.push(`${f} missing or not writable`);
    }
  }
  return problems.length ? { ok: false, detail: problems.join("; ") } : { ok: true, detail: "ONEMEMORY.md, STUDIOMEMORY.md, JOSMEMORY.md writable" };
}
