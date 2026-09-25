// Runtime Health. Every check is a real probe of the repository, the three One scopes, the planner and
// executor runtimes and HQ's own stores. The web server responding proves nothing.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { josRoot, loadConfig, rolePolicy, workspaceRoot, WORKSPACES, type RuntimeRole, type WorkspaceId } from "./env";
import { get, json, run } from "./db";
import { sqliteSelfTest } from "./db";
import { discoverScope } from "./one/discovery";
import { resolveOneCli } from "./one/cli";
import { evaluateIdentity, type IdentityVerdict } from "./identity";
import { adapterFor, dispatch, DispatchError, runningExecutions, recordRuntimeVerification } from "./dispatch";
import { releaseWorkspace, reserveWorkspace, workspaceHolders } from "./queue";
import { kickLines } from "./orchestrator";
import { logsWritable, openLogEntry, closeLogEntry } from "./logs";
import { newId } from "./util/ids";
import { nowIso } from "./util/time";
import { emit, signal } from "./events";
import type { RuntimeResolution } from "./executors/types";

export type CheckStatus = "pass" | "warn" | "fail";
export interface HealthCheck {
  id: string;
  group: "Repository" | "Orchestrator" | "One" | "Studio" | "Systems";
  label: string;
  status: CheckStatus;
  detail: string;
  blocking: boolean;
}

export interface ModelVerification {
  state: "verified" | "stale" | "unverified" | "failed";
  at: string | null;
  source: string | null;
  version: string | null;
  detail: string;
}

export interface ExecutorStatus {
  workspace: WorkspaceId;
  runtimeLabel: string;
  modelLabel: string;
  model: string;
  effort: string;
  runtime: RuntimeResolution;
  identity: IdentityVerdict;
  modelVerification: ModelVerification;
  /** The planning session's pin (same harness and binary as the executor). */
  planner: { modelLabel: string; model: string; effort: string; modelVerification: ModelVerification };
  dispatchable: boolean;
  blockers: string[];
}

export interface HealthReport {
  status: "Healthy" | "Attention" | "Blocked";
  generatedAt: string;
  checks: HealthCheck[];
  executors: Record<WorkspaceId, ExecutorStatus>;
  root: { identity: IdentityVerdict; connections: Array<{ platform: string; name: string; state: string }> };
  oneCli: { ok: boolean; version: string | null; error?: string };
}

function sha(p: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

export function modelVerification(ws: WorkspaceId, currentVersion: string | null, role: RuntimeRole = "executor"): ModelVerification {
  const cfg = loadConfig();
  const p = rolePolicy(ws, role);
  const row = get<{ ok: number; created_at: string; source: string; version: string | null; detail_json: string | null }>(
    "SELECT ok, created_at, source, version, detail_json FROM runtime_verifications WHERE workspace = ? AND model = ? AND effort = ? ORDER BY id DESC LIMIT 1",
    [ws, p.model, p.effort],
  );
  if (!row) return { state: "unverified", at: null, source: null, version: null, detail: `${p.modelLabel} (${p.effort}) has not been verified by a real launch yet; the first dispatch verifies it before any One call runs.` };
  const detail = (() => {
    try {
      return JSON.parse(row.detail_json ?? "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  if (!row.ok) return { state: "failed", at: row.created_at, source: row.source, version: row.version, detail: `Last launch failed verification: ${String(detail.reason ?? "model/effort mismatch")}` };
  const ageH = (Date.now() - Date.parse(row.created_at)) / 3600_000;
  if (row.version !== currentVersion) return { state: "stale", at: row.created_at, source: row.source, version: row.version, detail: `Verified on ${row.version}, but the runtime is now ${currentVersion}; the next dispatch re-verifies.` };
  if (ageH > cfg.limits.modelVerificationTtlHours) return { state: "stale", at: row.created_at, source: row.source, version: row.version, detail: `Last verified ${Math.round(ageH)} h ago.` };
  return { state: "verified", at: row.created_at, source: row.source, version: row.version, detail: `Verified by a real ${row.source} launch: ${String(detail.model ?? p.model)} · effort ${String(detail.effort ?? p.effort)}.` };
}

const cache = globalThis as unknown as { __josHealth?: { at: number; report: HealthReport } };

export async function healthReport(opts: { fresh?: boolean } = {}): Promise<HealthReport> {
  if (!opts.fresh && cache.__josHealth && Date.now() - cache.__josHealth.at < 30_000) return cache.__josHealth.report;
  const cfg = loadConfig();
  const checks: HealthCheck[] = [];
  const add = (c: HealthCheck) => checks.push(c);
  const root = josRoot();

  // Repository
  add({ id: "repo.root", group: "Repository", label: "J/OS root", status: fs.existsSync(root) ? "pass" : "fail", detail: root, blocking: true });
  for (const f of ["CLAUDE.md", "AGENTS.md"]) {
    const ok = fs.existsSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ root, f));
    add({ id: `repo.${f}`, group: "Repository", label: `Root ${f}`, status: ok ? "pass" : "fail", detail: ok ? "present" : "missing", blocking: f === "CLAUDE.md" });
  }
  const lw = logsWritable();
  add({ id: "repo.logs", group: "Repository", label: "J/OS logs", status: lw.ok ? "pass" : "fail", detail: lw.detail, blocking: true });

  // One CLI and the three scopes (live)
  const oneCli = await resolveOneCli(!!opts.fresh);
  add({ id: "sys.onecli", group: "Systems", label: "One CLI", status: oneCli.ok ? "pass" : "fail", detail: oneCli.ok ? `@withone/cli ${oneCli.version} (${oneCli.shim})` : oneCli.error ?? "unavailable", blocking: true });

  const [dRoot, dOne, dStudio] = oneCli.ok
    ? await Promise.all([discoverScope("root", { fresh: opts.fresh }), discoverScope("One", { fresh: opts.fresh }), discoverScope("Studio", { fresh: opts.fresh })])
    : [null, null, null];

  const rootIdentity = dRoot ? evaluateIdentity("root", dRoot.identity) : null;
  if (rootIdentity) {
    add({
      id: "root.identity",
      group: "Orchestrator",
      label: "Root identity",
      status: rootIdentity.ok ? "pass" : "fail",
      detail: rootIdentity.ok ? `${rootIdentity.actual.email} · org ${rootIdentity.actual.org} · ${rootIdentity.actual.projectRoot}` : rootIdentity.problems.join("; "),
      blocking: false,
    });
    const rc = dRoot?.connections ?? [];
    const extra = rc.filter((c) => c.platform !== "open-router");
    add({
      id: "root.nonexecuting",
      group: "Orchestrator",
      label: "Root is non-executing",
      status: extra.length ? "warn" : "pass",
      detail: extra.length ? `The root holds operational connections beyond open-router (${extra.map((c) => c.platform).join(", ")}); CLAUDE.md §7 says the root holds only open-router.` : "The root holds only open-router: it can plan and structurally cannot execute.",
      blocking: false,
    });
  }
  const executors = {} as Record<WorkspaceId, ExecutorStatus>;
  for (const ws of WORKSPACES) {
    const d = ws === "One" ? dOne : dStudio;
    const adapter = adapterFor(ws);
    const p = cfg.workspaces[ws].executor;
    const wsRoot = workspaceRoot(ws);
    const wsOk = adapter.verifyWorkspace();
    add({ id: `${ws}.workspace`, group: ws, label: "Workspace", status: wsOk.ok ? "pass" : "fail", detail: wsOk.ok ? wsRoot : wsOk.problem ?? "invalid", blocking: true });
    const a = sha(path.join(wsRoot, "CLAUDE.md"));
    const b = sha(path.join(wsRoot, "AGENTS.md"));
    add({ id: `${ws}.twins`, group: ws, label: "Instruction twins", status: a && b && a === b ? "pass" : "warn", detail: a && b ? (a === b ? `CLAUDE.md = AGENTS.md (sha256 ${a.slice(0, 12)}…)` : "CLAUDE.md and AGENTS.md differ — the two harnesses would get different instructions") : "instruction pair incomplete", blocking: false });
    const identity = d ? evaluateIdentity(ws, d.identity) : ({ scope: ws, ok: false, expected: { projectRoot: wsRoot, email: cfg.workspaces[ws].expectedEmail, org: cfg.workspaces[ws].expectedOrg }, actual: { projectRoot: null, email: null, org: null, name: null, keyName: null }, problems: ["One CLI unavailable"], warnings: [], checkedAt: nowIso() } as IdentityVerdict);
    add({ id: `${ws}.configpath`, group: ws, label: "Config path", status: identity.actual.projectRoot && !identity.problems.some((x) => x.startsWith("projectRoot") || x.includes("config path")) ? "pass" : "fail", detail: identity.actual.projectRoot ?? identity.problems.join("; "), blocking: true });
    add({ id: `${ws}.whoami`, group: ws, label: "Identity (whoami)", status: identity.ok ? "pass" : "fail", detail: identity.ok ? `${identity.actual.email}${identity.actual.org ? ` · org ${identity.actual.org}` : " · no org (by design)"}` : identity.problems.join("; "), blocking: true });
    if (identity.warnings.length) add({ id: `${ws}.org`, group: ws, label: "Organization", status: "warn", detail: identity.warnings.join("; "), blocking: false });
    const conns = d?.connections;
    add({ id: `${ws}.connections`, group: ws, label: "Connection discovery", status: conns ? (conns.length ? "pass" : "warn") : "fail", detail: conns ? `${conns.length} connections (${conns.filter((c) => c.state === "operational").length} operational)` : d?.connectionsError ?? "failed", blocking: false });
    add({ id: `${ws}.flows`, group: ws, label: "Flow discovery", status: d?.flows ? "pass" : "fail", detail: d?.flows ? `${d.flows.length} flows` : d?.flowsError ?? "failed", blocking: false });
    const runtime = await adapter.checkAvailability(!!opts.fresh);
    add({
      id: `${ws}.runtime`,
      group: ws,
      label: ws === "One" ? "Claude Code" : `Codex CLI (${p.modelLabel} harness)`,
      status: runtime.ok ? "pass" : "fail",
      detail: runtime.ok ? `${runtime.version} · ${runtime.source} · ${runtime.binary}` : runtime.error ?? "unavailable",
      blocking: true,
    });
    const mv = modelVerification(ws, runtime.version);
    add({ id: `${ws}.model`, group: ws, label: `${p.modelLabel} (${p.effort})`, status: mv.state === "verified" ? "pass" : mv.state === "failed" ? "fail" : "warn", detail: mv.detail, blocking: mv.state === "failed" });
    // A failed planner does not block dispatch: Edit and Auto continue without a plan (Plan and Manual stop per task).
    const pp = rolePolicy(ws, "planner");
    const pmv = modelVerification(ws, runtime.version, "planner");
    add({ id: `${ws}.planner`, group: ws, label: `${pp.modelLabel} (${pp.effort}) · planner`, status: pmv.state === "verified" ? "pass" : pmv.state === "failed" ? "fail" : "warn", detail: pmv.detail, blocking: false });
    const blockers = checks.filter((c) => c.group === ws && c.blocking && c.status === "fail").map((c) => `${c.label}: ${c.detail}`);
    if (!oneCli.ok) blockers.push("One CLI unavailable");
    executors[ws] = {
      workspace: ws,
      runtimeLabel: p.runtimeLabel,
      modelLabel: p.modelLabel,
      model: p.model,
      effort: p.effort,
      runtime,
      identity,
      modelVerification: mv,
      planner: { modelLabel: pp.modelLabel, model: pp.model, effort: pp.effort, modelVerification: pmv },
      dispatchable: blockers.length === 0,
      blockers,
    };
  }

  const st = sqliteSelfTest();
  add({ id: "sys.sqlite", group: "Systems", label: "SQLite telemetry store", status: st.ok ? "pass" : "fail", detail: st.detail, blocking: true });
  const running = runningExecutions();
  const stuck = get<{ n: number }>("SELECT COUNT(*) AS n FROM executions WHERE status IN ('needs_reconciliation')")?.n ?? 0;
  add({
    id: "sys.dispatch",
    group: "Systems",
    label: "Dispatch service",
    status: stuck ? "warn" : "pass",
    detail: `${running.length} running execution(s)${stuck ? ` · ${stuck} orphaned execution(s) need reconciliation` : ""} · the only executor launcher in J/OS`,
    blocking: false,
  });

  const blocked = checks.some((c) => c.blocking && c.status === "fail");
  const attention = checks.some((c) => c.status !== "pass");
  const report: HealthReport = {
    status: blocked ? "Blocked" : attention ? "Attention" : "Healthy",
    generatedAt: nowIso(),
    checks,
    executors,
    root: { identity: rootIdentity ?? ({} as IdentityVerdict), connections: (dRoot?.connections ?? []).map((c) => ({ platform: c.platform, name: c.name, state: c.state })) },
    oneCli: { ok: oneCli.ok, version: oneCli.version, error: oneCli.error },
  };
  run("INSERT INTO health_snapshots(status, report_json, created_at) VALUES (?, ?, ?)", [report.status, json({ status: report.status, checks: report.checks.map((c) => ({ id: c.id, status: c.status })) }), report.generatedAt]);
  run("DELETE FROM health_snapshots WHERE id NOT IN (SELECT id FROM health_snapshots ORDER BY id DESC LIMIT 500)");
  cache.__josHealth = { at: Date.now(), report };
  signal("health_updated", { status: report.status });
  return report;
}

/**
 * Explicit "Verify models": a minimal read-only launch of each workspace's planner (PLAN phase) and
 * executor (PREVIEW phase) through the real dispatch path, so all four pins are proven. Orchestrator
 * maintenance, so it is logged as one JOSMEMORY.md entry.
 */
export async function verifyModels(): Promise<{ taskId: string; results: Array<{ workspace: WorkspaceId; role: RuntimeRole; ok: boolean; detail: string }> }> {
  // One task per workspace: the check launches in both, so it refuses while either is busy.
  const busy = WORKSPACES.flatMap((ws) => {
    const h = workspaceHolders(ws)[0];
    return h ? [`${ws} is busy with “${h.title}”`] : [];
  });
  if (busy.length) throw new DispatchError("WORKSPACE_BUSY", `${busy.join("; ")}. Verify the models when ${busy.length > 1 ? "they are" : "it is"} free.`);
  // Reserved synchronously, before the first await, so no task is admitted alongside the check.
  for (const ws of WORKSPACES) reserveWorkspace(ws, "Runtime Health check");
  try {
    const taskId = newId("jos");
    const now = nowIso();
    const pin = (ws: WorkspaceId, role: RuntimeRole) => `${rolePolicy(ws, role).modelLabel} (${rolePolicy(ws, role).effort})`;
    run(
      `INSERT INTO tasks(id, chat_id, origin, title, request, mode, route_selection, route, route_reason, status, stage, created_at, updated_at)
       VALUES (?, NULL, 'probe', 'Verify planner and executor runtimes', ?, 'manual', 'auto', 'none', 'Runtime Health verification', 'executing', 'execute', ?, ?)`,
      [taskId, `Verify that One plans on ${pin("One", "planner")} and executes on ${pin("One", "executor")}, and Studio plans on ${pin("Studio", "planner")} and executes on ${pin("Studio", "executor")}`, now, now],
    );
    await openLogEntry({ taskId, file: "JOSMEMORY.md", title: "Verify planner and executor runtimes", asked: "Runtime Health: verify both planners and both executors with a read-only launch each.", route: "none — Orchestrator maintenance; read-only probe launches of both planners and both executors through the HQ dispatch service" });
    run("UPDATE tasks SET log_file = 'JOSMEMORY.md', log_opened_at = ? WHERE id = ?", [nowIso(), taskId]);
    const results: Array<{ workspace: WorkspaceId; role: RuntimeRole; ok: boolean; detail: string }> = [];
    for (const ws of WORKSPACES) {
      const planPrompt = `YOU ARE THE PLANNER FOR THIS TASK
J/OS HQ runtime verification for the ${ws} planner. Strictly read-only: run exactly \`one --agent config path\` and then \`one --agent whoami\`, and nothing else.
RETURN the structured plan: status "planned"; title "runtime verification"; objective "runtime verification"; success_condition "identity confirmed"; intent_questions []; identity_check from the two commands (passed only if projectRoot ends with \\JOS\\${ws}); connections []; resolved_facts []; steps []; flow_design {needed: false, key: "", name: "", inputs: [], outline: [], error_handling: [], test_plan: []}; verification []; risks []; estimated_external_calls 0; paid_surfaces []; notes "".`;
      const execPrompt = `YOU ARE THE PRIMARY EXECUTOR FOR THIS TASK
J/OS HQ runtime verification for the ${ws} executor. Strictly read-only: run exactly \`one --agent config path\` and then \`one --agent whoami\`, and nothing else.
RETURN the structured result: status "completed"; identity_check from the two commands (passed only if projectRoot ends with \\JOS\\${ws}); answer "runtime verification"; summary "runtime verification"; proposed_actions []; artifacts []; verification {performed: true, passed: <identity passed>, method: "config path + whoami", evidence: "<projectRoot> / <email>"}; limitations []; learned []; needs_user_input "".`;
      for (const role of ["planner", "executor"] as const) {
        const pol = rolePolicy(ws, role);
        try {
          const d = await dispatch({ taskId, workspace: ws, phase: role === "planner" ? "plan" : "preview", mode: "manual", prompt: role === "planner" ? planPrompt : execPrompt, origin: { kind: "hq" } });
          const o = await d.done;
          const passed = role === "planner" ? !!o.exit.plan?.identity_check.passed : !!o.exit.structured?.identity_check.passed;
          const ok = o.verification.ok === true && o.status === "exited" && passed;
          results.push({ workspace: ws, role, ok, detail: ok ? `${o.verification.model} · effort ${o.verification.effort} · ${o.verification.cwd}` : o.verification.reason ?? o.exit.error ?? "verification failed" });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const rt = await adapterFor(ws).checkAvailability();
          recordRuntimeVerification({ workspace: ws, adapter: adapterFor(ws).id, binary: rt.binary, version: rt.version, model: pol.model, effort: pol.effort, ok: false, source: "probe", executionId: null, detail: { reason: msg } });
          results.push({ workspace: ws, role, ok: false, detail: msg });
        }
      }
    }
    const allOk = results.every((r) => r.ok);
    await closeLogEntry({
      taskId,
      file: "JOSMEMORY.md",
      status: allOk ? "done" : "blocked",
      outcome: results.map((r) => `${r.workspace} ${r.role}: ${r.ok ? "verified" : "FAILED"} — ${r.detail}`).join("; "),
      artifacts: `HQ task ${taskId}`,
      learned: allOk ? "Both planners and both executors launched on the required model and effort." : "At least one runtime failed verification; a failed executor blocks dispatch, and a failed planner blocks planning, until re-verified.",
    });
    run("UPDATE tasks SET status = ?, stage = 'respond', log_closed_at = ?, log_status = ?, ended_at = ? WHERE id = ?", [allOk ? "completed" : "blocked", nowIso(), allOk ? "done" : "blocked", nowIso(), taskId]);
    emit({ taskId, system: "hq", type: "runtime_verification", level: allOk ? "success" : "error", visibility: "chat", summary: results.map((r) => `${r.workspace} ${r.role} ${r.ok ? "verified" : "failed"}`).join(" · "), data: results });
    cache.__josHealth = undefined;
    return { taskId, results };
  } finally {
    for (const ws of WORKSPACES) releaseWorkspace(ws);
    kickLines();
  }
}
