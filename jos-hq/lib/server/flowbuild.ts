// "+ New Workflow" chats. Every task sent in one builds a One Flow (CLAUDE.md §8), whatever its
// message says: on 2026-09-23 the draft "Build a One Flow that " was not in the sent text, and the
// executor carried the process out once instead. The purpose therefore lives on the chat, and a task
// is verified only when HQ itself sees the flow in the workspace's live `flow list`.
import fs from "node:fs";
import path from "node:path";
import type { WorkspaceId } from "./env";
import { get } from "./db";
import type { FlowInfo } from "./one/discovery";

export function chatBuildsFlow(chatId: string | null): boolean {
  if (!chatId) return false;
  return get<{ purpose: string | null }>("SELECT purpose FROM chats WHERE id = ?", [chatId])?.purpose === "workflow";
}

export interface FlowBuildCheck {
  /** Flow keys that were not in the workspace when the task was dispatched. */
  created: string[];
  /** Existing flows whose definition file changed during the task. */
  updated: string[];
  problems: string[];
}

/** `since` is when the task began; `before` the keys listed at PREVIEW dispatch (null if that listing failed). */
export function checkFlowBuild(input: { workspace: WorkspaceId; workspaceRoot: string; before: string[] | null; since: string; after: { flows: FlowInfo[] | null; error: string | null } }): FlowBuildCheck {
  const { flows, error } = input.after;
  if (!flows) return { created: [], updated: [], problems: [`HQ could not list the flows in JOS/${input.workspace} to confirm the build (${error ?? "flow list failed"})`] };
  const before = new Set(input.before ?? []);
  const since = Date.parse(input.since);
  const created = flows.filter((f) => !before.has(f.key)).map((f) => f.key);
  const updated = flows.filter((f) => before.has(f.key) && modifiedSince(input.workspaceRoot, f.key, since)).map((f) => f.key);
  const problems = created.length || updated.length ? [] : [`HQ found no new or changed One Flow in JOS/${input.workspace} (live flow list); this chat's deliverable is a saved flow`];
  return { created, updated, problems };
}

function modifiedSince(root: string, key: string, since: number): boolean {
  // Folder layout first, then the legacy single file (the One skill's references/flows.md).
  for (const f of [path.join(root, ".one", "flows", key, "flow.json"), path.join(root, ".one", "flows", `${key}.flow.json`)]) {
    try {
      return fs.statSync(f).mtimeMs >= since;
    } catch {
      /* not this layout */
    }
  }
  return false;
}
