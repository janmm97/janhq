// Connection-usage telemetry. Every row comes from a call the HQ One gateway (or jos-approved) actually
// observed; nothing is inferred from a connection merely existing. Payloads are never stored here.
import fs from "node:fs";
import { all, get, run } from "./db";
import { emit } from "./events";
import { nowIso } from "./util/time";
import type { WorkspaceId } from "./env";

interface PolicyConnections {
  connections?: Array<{ key: string; platform: string; name: string }>;
}
const policyCache = new Map<string, PolicyConnections>();

function connectionName(executionId: string, key: string | null): string | null {
  if (!key) return null;
  let p = policyCache.get(executionId);
  if (!p) {
    const row = get<{ policy_path: string }>("SELECT policy_path FROM executions WHERE id = ?", [executionId]);
    try {
      p = row ? (JSON.parse(fs.readFileSync(row.policy_path, "utf8")) as PolicyConnections) : {};
    } catch {
      p = {};
    }
    policyCache.set(executionId, p);
  }
  return p.connections?.find((c) => c.key === key)?.name ?? null;
}

export interface GatewayEvent {
  kind?: string;
  category?: string;
  decision?: string;
  ok?: boolean;
  exitCode?: number | null;
  error?: string | null;
  reason?: string | null;
  method?: string | null;
  path?: string | null;
  paid?: boolean;
  durationMs?: number;
  payloadHash?: string;
  args?: { command?: string | null; subcommand?: string | null; platform?: string | null; actionId?: string | null; connectionKey?: string | null; flowKey?: string | null; dryRun?: boolean; mock?: boolean };
}

export function recordGatewayEvent(ctx: { executionId: string; taskId: string; workspace: WorkspaceId; executor: string }, ev: GatewayEvent) {
  const a = ev.args ?? {};
  const command = [a.command, a.subcommand].filter(Boolean).join(" ") || "one";
  const decision = ev.decision ?? "allowed";
  const category = ev.category ?? "unknown";
  const name = connectionName(ctx.executionId, a.connectionKey ?? null);
  run(
    `INSERT INTO connection_usage(task_id, execution_id, workspace, executor, platform, connection_key, connection_name, action_id, category, decision, method, path, ok, duration_ms, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.taskId,
      ctx.executionId,
      ctx.workspace,
      ctx.executor,
      a.platform ?? null,
      a.connectionKey ?? null,
      name,
      a.actionId ?? null,
      category,
      decision,
      ev.method ?? null,
      ev.path ?? null,
      ev.ok ? 1 : 0,
      ev.durationMs ?? null,
      (ev.reason ?? ev.error ?? null)?.toString().slice(0, 500) ?? null,
      nowIso(),
    ],
  );
  const blocked = decision !== "allowed";
  const platformCall = !!a.connectionKey;
  emit({
    taskId: ctx.taskId,
    executionId: ctx.executionId,
    system: ctx.workspace,
    type: blocked ? "gateway_blocked" : platformCall ? "connection_used" : "one_cli",
    level: blocked ? "warning" : ev.ok ? "info" : "warning",
    visibility: blocked ? "chat" : "details",
    summary: blocked
      ? `Gateway blocked \`one ${command}\`${a.platform ? ` on ${a.platform}` : ""}: ${ev.reason ?? ev.error ?? decision}`
      : platformCall
        ? `${a.platform} · ${name ?? a.connectionKey} · ${category}${ev.method ? ` ${ev.method} ${ev.path ?? ""}` : ""}${ev.ok ? "" : " (failed)"}`
        : `one ${command}${a.platform ? ` ${a.platform}` : ""}${ev.ok ? "" : " (failed)"}`,
    data: { ...ev, connectionName: name },
  });
}

export function recordApprovedWrite(ctx: { executionId: string | null; taskId: string; workspace: WorkspaceId; platform: string; connectionKey: string | null; connectionName: string | null; actionId: string | null; ok: boolean; durationMs?: number; reason?: string }) {
  run(
    `INSERT INTO connection_usage(task_id, execution_id, workspace, executor, platform, connection_key, connection_name, action_id, category, decision, ok, duration_ms, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'write', 'approved', ?, ?, ?, ?)`,
    [ctx.taskId, ctx.executionId, ctx.workspace, ctx.workspace, ctx.platform, ctx.connectionKey, ctx.connectionName, ctx.actionId, ctx.ok ? 1 : 0, ctx.durationMs ?? null, ctx.reason ?? null, nowIso()],
  );
}

/** Real platform calls only: reads and approved writes that reached a connection. */
const USAGE_WHERE = "connection_key IS NOT NULL AND category IN ('read','write') AND decision IN ('allowed','approved')";

export function lastUsedByPlatform(): Array<{ workspace: string; platform: string; last_used: string; calls: number }> {
  return all(
    `SELECT workspace, platform, MAX(created_at) AS last_used, COUNT(*) AS calls FROM connection_usage WHERE ${USAGE_WHERE} GROUP BY workspace, platform`,
  );
}

export function topConnections(opts: { workspace?: WorkspaceId | null; sinceIso?: string | null; limit?: number }) {
  const params: (string | number)[] = [];
  let where = USAGE_WHERE;
  if (opts.workspace) {
    where += " AND workspace = ?";
    params.push(opts.workspace);
  }
  if (opts.sinceIso) {
    where += " AND created_at >= ?";
    params.push(opts.sinceIso);
  }
  params.push(opts.limit ?? 5);
  return all<{ platform: string; connection_name: string | null; workspace: string; calls: number; last_used: string }>(
    `SELECT platform, MAX(connection_name) AS connection_name, GROUP_CONCAT(DISTINCT workspace) AS workspace, COUNT(*) AS calls, MAX(created_at) AS last_used
     FROM connection_usage WHERE ${where} GROUP BY platform ORDER BY calls DESC, last_used DESC LIMIT ?`,
    params,
  );
}
