// Scrubbing for text that leaves HQ for a public place: an issue in a public GitHub repository.
// redact.ts removes credentials; this goes further and removes who and what HQ works for: people,
// client companies, account names, email addresses, the names Jan gave each connection, connection
// keys, IDs and local user paths. Tools keep their names (Gmail, Notion, the One CLI); only the name
// a connection was given is replaced, by its platform ("[gmail connection]").
//
// Placeholders use square brackets, not angle brackets: GitHub renders <person> as an HTML tag and
// hides it.
import { redactSecrets } from "./redact";

export interface ScrubTerms {
  /** People's names, matched whole-word and case-insensitively, possessives included. */
  people: string[];
  /** Client and company names. */
  companies: string[];
  /** One account holders' full names; each part of four letters or more is matched too. */
  accounts: string[];
  /** Connection display names with their platform. */
  connections: Array<{ name: string; platform: string }>;
  /** Absolute directories to show relative to their last segment (the JOS root, say). */
  roots?: string[];
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordRe(term: string): RegExp {
  // Spaces in a term match any run of whitespace, so "Northwind" still matches.
  const body = esc(term.trim()).replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![A-Za-z0-9])${body}(?:['’]s|s['’])?(?![A-Za-z0-9])`, "gi");
}

function byLength(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter((s) => s.length >= 2))].sort((a, b) => b.length - a.length);
}

export function scrubPublic(input: string, terms: ScrubTerms): string {
  let out = redactSecrets(String(input ?? ""));

  // Connection keys first: they carry the platform, which the placeholder keeps.
  out = out.replace(/\b(?:live|test)::([a-z0-9-]+)::[A-Za-z0-9_-]+::[A-Za-z0-9]+\b/g, (_m, platform: string) => `[${platform} connection]`);

  // Connection names before people and companies, since a name like "Main Support" holds other terms.
  const conns = [...terms.connections].filter((c) => c.name?.trim()).sort((a, b) => b.name.length - a.name.length);
  for (const c of conns) out = out.replace(wordRe(c.name), `[${c.platform} connection]`);

  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");

  for (const root of terms.roots ?? []) {
    const last = root.split(/[\\/]/).filter(Boolean).pop() ?? "";
    const slashes = esc(root).replace(/(?:\\\\|\/)+/g, "[\\\\/]+");
    out = out.replace(new RegExp(slashes, "gi"), last);
  }
  // Any remaining home directory: C:\Users\name\, /c/Users/name/, /home/name/, /Users/name/.
  out = out.replace(/\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+/gi, "~");
  out = out.replace(/(?<![\w.])\/(?:[a-z]\/)?(?:Users|home)\/[^/\s"'`]+/g, "~");

  for (const c of byLength(terms.companies)) out = out.replace(wordRe(c), "[company]");
  const accountParts = terms.accounts.flatMap((a) => [a, ...a.split(/\s+/).filter((p) => p.length >= 4)]);
  for (const a of byLength(accountParts)) out = out.replace(wordRe(a), "[account holder]");
  for (const p of byLength(terms.people)) out = out.replace(wordRe(p), "[person]");

  out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]");

  // The second workspace is named for a client. As an identifier prefix (studio_agent, STUDIOMEMORY) it
  // becomes "wsb"; standing alone it becomes "Workspace B". Money and decimals ($226, 226.5) stay.
  // Case-insensitive so the rule survives the public export, which renames this workspace to a word.
  out = out.replace(/(?<![\w$.])Studio(?=_|[A-Z])/gi, "wsb");
  out = out.replace(/(?<![\w$.])Studio(?![\w.])/g, "Workspace B");
  return out;
}
