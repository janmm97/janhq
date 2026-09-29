// D4 (spec §6): drop connections Jev is confident are irrelevant from the planner and PREVIEW prompts.
// Never dropped: anything named in the request, the `keep` list (route, mailbox, fast path), platforms
// Jev thinks may be needed, and non-operational connections. HQ's own checks always use the full list.
import type { ConnectionInfo } from "../one/discovery";
import type { Gate } from "./gates";
import type { UnderstandResult } from "./understand";

export function trimConnections(conns: ConnectionInfo[], o: { u: UnderstandResult | null; g: Gate; request: string; keep: string[] }): { kept: ConnectionInfo[]; dropped: string[] } {
  if (!o.u || !o.g.live || o.g.threshold === null) return { kept: conns, dropped: [] };
  const t = o.g.threshold;
  const lower = o.request.toLowerCase();
  const kept: ConnectionInfo[] = [];
  const dropped: string[] = [];
  for (const c of conns) {
    const rel = o.u.relevance[c.name];
    const protectedConn = c.state !== "operational" || o.keep.includes(c.name) || lower.includes(c.name.toLowerCase()) || (o.u.platforms[c.platform] ?? 0) >= 0.5 || rel === undefined;
    if (!protectedConn && 1 - rel >= t) dropped.push(c.name);
    else kept.push(c);
  }
  return { kept, dropped };
}
