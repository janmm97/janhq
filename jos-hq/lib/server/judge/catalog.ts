// The tool catalog: what each platform is for (reference/tool-catalog.json), joined with the LIVE
// connection list. Connection keys never leave HQ; Jev sees names, platforms and purposes only.
import fs from "node:fs";
import path from "node:path";
import { hqRoot } from "../env";
import type { ConnectionInfo } from "../one/discovery";

export interface CatalogEntry { purpose: string; not_for: string; side_effects: string }
export interface Tool { name: string; platform: string; key: string; state: string; purpose: string | null }

export function toolCatalog(): Record<string, CatalogEntry> {
  try {
    return JSON.parse(fs.readFileSync(path.join(hqRoot(), "reference", "tool-catalog.json"), "utf8")) as Record<string, CatalogEntry>;
  } catch {
    return {};
  }
}

/** Operational connections as tools, one per connection name (first wins). */
export function toolsFor(conns: ConnectionInfo[]): Tool[] {
  const cat = toolCatalog();
  const seen = new Set<string>();
  const out: Tool[] = [];
  for (const c of conns) {
    if (c.state !== "operational" || seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({ name: c.name, platform: c.platform, key: c.key, state: c.state, purpose: cat[c.platform]?.purpose ?? null });
  }
  return out;
}

export function toolLine(t: Tool): string {
  return `${t.platform}: ${t.purpose ?? "(no description yet)"}`;
}

export function undescribedPlatforms(conns: ConnectionInfo[]): string[] {
  const cat = toolCatalog();
  return [...new Set(conns.map((c) => c.platform))].filter((p) => !cat[p]).sort();
}
