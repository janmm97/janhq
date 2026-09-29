// Codex session rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl).
// The rollout's `turn_context` records the model, reasoning effort, cwd and sandbox policy Codex
// actually used, which is the authoritative evidence for verifying a Studio launch.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function codexHome(): string {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
}

function dayDirs(): string[] {
  const out = new Set<string>();
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let back = 0; back <= 2; back++) {
    const d = new Date(Date.now() - back * 86400_000);
    out.add(path.join(codexHome(), "sessions", String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
    out.add(path.join(codexHome(), "sessions", String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())));
  }
  return [...out];
}

export function findRollout(threadId: string): string | null {
  if (!/^[0-9a-f-]{16,}$/i.test(threadId)) return null;
  for (const dir of dayDirs()) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const hit = names.find((n) => n.endsWith(`${threadId}.jsonl`));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

export interface RolloutContext {
  file: string;
  sessionMeta: { cwd?: string; cliVersion?: string; originator?: string; source?: string } | null;
  turnContexts: Array<{ cwd?: string; model?: string; effort?: string; approvalPolicy?: string; sandboxPolicy?: unknown }>;
}

export function readRolloutContext(file: string): RolloutContext {
  const ctx: RolloutContext = { file, sessionMeta: null, turnContexts: [] };
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return ctx;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: { type?: string; payload?: Record<string, unknown> };
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type === "session_meta" && r.payload) {
      ctx.sessionMeta = {
        cwd: r.payload.cwd as string,
        cliVersion: r.payload.cli_version as string,
        originator: r.payload.originator as string,
        source: r.payload.source as string,
      };
    } else if (r.type === "turn_context" && r.payload) {
      ctx.turnContexts.push({
        cwd: r.payload.cwd as string,
        model: r.payload.model as string,
        effort: r.payload.effort as string,
        approvalPolicy: r.payload.approval_policy as string,
        sandboxPolicy: r.payload.sandbox_policy,
      });
    }
  }
  return ctx;
}

/** Tail of the rollout for reconciliation after an HQ restart (no secrets: message text only). */
export function rolloutTail(file: string, maxItems = 20): string[] {
  try {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(-400);
    const out: string[] = [];
    for (const l of lines) {
      try {
        const r = JSON.parse(l);
        if (r.type === "event_msg" && r.payload?.type === "agent_message") out.push(String(r.payload.message ?? "").slice(0, 300));
        if (r.type === "event_msg" && r.payload?.type === "exec_command_end") out.push(`exec: exit ${r.payload.exit_code}`);
      } catch {
        /* skip */
      }
    }
    return out.slice(-maxItems);
  } catch {
    return [];
  }
}
