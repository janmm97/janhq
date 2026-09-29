// Live proof of executor dispatch through the real HQ dispatch service (no UI, no mocks).
//
//   npx tsx scripts/prove-dispatch.mts [one|Studio|all] [--no-cancel]
//
// For each executor it launches a READ-ONLY probe (identity + connection/flow listing through the HQ
// One gateway) and proves: separate process, cwd, runtime, model, effort, streamed output, identity,
// and the structured result. It then launches a second run and cancels it mid-flight, proving the
// process tree is gone. Evidence is written to data/proof/evidence-<timestamp>.json.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

process.env.JOS_HQ_PORT ??= "4611";
process.env.JOS_HQ_DATA_DIR ??= path.join(process.cwd(), "data", "proof");

const { handleInternal } = await import("../lib/server/api/internal");
const { dispatch, cancelExecution } = await import("../lib/server/dispatch");
const { run, get } = await import("../lib/server/db");
const { onEvent } = await import("../lib/server/events");
const { newId } = await import("../lib/server/util/ids");
const { nowIso } = await import("../lib/server/util/time");
const { isPidAlive, processImageName } = await import("../lib/server/proc");
const { dataDir } = await import("../lib/server/env");
type WorkspaceId = "One" | "Studio";

const port = Number(process.env.JOS_HQ_PORT);
const server = http.createServer(async (req, res) => {
  const url = `http://127.0.0.1:${port}${req.url}`;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const request = new Request(url, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks) });
  const response = (await handleInternal(request, new URL(url).pathname)) ?? new Response("not found", { status: 404 });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));

const arg = (process.argv[2] ?? "all").toLowerCase();
const targets: WorkspaceId[] = arg === "one" ? ["One"] : arg === "Studio" ? ["Studio"] : ["One", "Studio"];
const doCancel = !process.argv.includes("--no-cancel");

const PROBE = (ws: WorkspaceId) => `YOU ARE THE PRIMARY EXECUTOR FOR THIS TASK
This is a J/OS HQ dispatch PROOF RUN for the ${ws} executor. It is strictly read-only.

Run exactly these commands, one at a time, from your working directory, and nothing else:
1. one --agent config path
2. one --agent whoami
3. one --agent connection list
4. one --agent flow list

Do not run any other command, do not read or write files, and do not perform any action on any platform.

RETURN
Return the structured result: status "completed"; identity_check with the projectRoot from command 1, the
email from command 2, and passed=true only if projectRoot ends with \\JOS\\${ws}; answer = one sentence
listing the connection platforms you saw and the number of flows; summary = "proof run"; proposed_actions = [];
artifacts = []; verification = {performed: true, passed: <identity passed>, method: "config path + whoami",
evidence: "<projectRoot> / <email>"}; limitations = []; learned = []; needs_user_input = "".`;

const LONG = (ws: WorkspaceId) => `YOU ARE THE PRIMARY EXECUTOR FOR THIS TASK
J/OS HQ CANCELLATION PROOF for the ${ws} executor. Strictly read-only.
Run these commands one at a time, and after each one write two sentences about what it showed before
running the next: one --agent config path; one --agent whoami; one --agent connection list;
one --agent flow list; one --agent actions search gmail "list messages" -t execute;
one --agent actions search notion "search" -t execute; one --agent actions search exa "search" -t execute;
one --agent actions search tavily "search" -t execute; one --agent actions search firecrawl "scrape" -t execute.
Do not perform any action on any platform. Return the structured result when done.`;

function createTask(ws: WorkspaceId, title: string) {
  const id = newId("jos");
  run(
    `INSERT INTO tasks(id, chat_id, origin, title, request, mode, route_selection, route, route_reason, status, stage, created_at, updated_at)
     VALUES (?, NULL, 'probe', ?, ?, 'manual', ?, ?, 'dispatch proof', 'running', 'dispatch', ?, ?)`,
    [id, title, title, ws, ws, nowIso(), nowIso()],
  );
  return id;
}

const evidence: Record<string, unknown> = { startedAt: nowIso(), host: process.env.COMPUTERNAME ?? null, runs: [] as unknown[] };

for (const ws of targets) {
  console.log(`\n==================== ${ws}: read-only proof run`);
  const taskId = createTask(ws, `Dispatch proof (${ws})`);
  const seen: string[] = [];
  const off = onEvent((e) => {
    if (e.taskId !== taskId) return;
    if (["executor_output", "executor_usage", "executor_session"].includes(e.type) && seen.length > 60) return;
    seen.push(`${e.type}: ${e.summary}`);
    console.log(`  [${e.type}] ${e.summary.slice(0, 220)}`);
  });
  try {
    const r = await dispatch({ taskId, workspace: ws, phase: "preview", mode: "manual", prompt: PROBE(ws), origin: { kind: "hq" } });
    const outcome = await r.done;
    const row = get("SELECT * FROM executions WHERE id = ?", [r.executionId]) as Record<string, unknown>;
    const usage = (await import("../lib/server/db")).all("SELECT platform, connection_key, category, decision, method, path, ok FROM connection_usage WHERE execution_id = ?", [r.executionId]);
    const record = {
      workspace: ws,
      kind: "probe",
      executionId: r.executionId,
      pid: row.pid,
      cwd: row.cwd,
      runtime: row.runtime,
      binary: row.binary,
      requiredModel: row.model,
      requiredEffort: row.effort,
      verified: outcome.verification,
      identityAtDispatch: { ok: r.identity.ok, email: r.identity.actual.email, projectRoot: r.identity.actual.projectRoot },
      status: outcome.status,
      exitCode: outcome.exit.code,
      error: outcome.exit.error,
      structured: outcome.exit.structured,
      gatewayCalls: usage,
      eventCount: seen.length,
    };
    (evidence.runs as unknown[]).push(record);
    console.log(`  -> status=${outcome.status} verified=${JSON.stringify(outcome.verification)} error=${outcome.exit.error}`);
    console.log(`  -> structured.status=${outcome.exit.structured?.status} identity=${JSON.stringify(outcome.exit.structured?.identity_check)}`);
  } catch (e) {
    console.log(`  !! dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
    (evidence.runs as unknown[]).push({ workspace: ws, kind: "probe", error: e instanceof Error ? e.message : String(e), details: (e as { details?: unknown }).details ?? null });
  } finally {
    off();
  }

  if (!doCancel) continue;
  console.log(`\n==================== ${ws}: cancellation proof run`);
  const taskId2 = createTask(ws, `Cancellation proof (${ws})`);
  try {
    const r = await dispatch({ taskId: taskId2, workspace: ws, phase: "preview", mode: "manual", prompt: LONG(ws), origin: { kind: "hq" } });
    const row0 = get("SELECT pid FROM executions WHERE id = ?", [r.executionId]) as { pid: number };
    // Wait until the launch is verified and at least one gateway call happened, then cancel.
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      const n = (get("SELECT COUNT(*) AS n FROM connection_usage WHERE execution_id = ?", [r.executionId]) as { n: number }).n;
      const v = (get("SELECT verified FROM executions WHERE id = ?", [r.executionId]) as { verified: number }).verified;
      if (n >= 1 && v === 1) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    const beforeAlive = isPidAlive(row0.pid);
    const beforeImage = await processImageName(row0.pid);
    const c = await cancelExecution(r.executionId, "cancellation proof");
    const outcome = await r.done;
    await new Promise((res) => setTimeout(res, 1500));
    const afterAlive = isPidAlive(row0.pid);
    const row = get("SELECT status, cancel_state, exit_code FROM executions WHERE id = ?", [r.executionId]);
    const record = { workspace: ws, kind: "cancel", executionId: r.executionId, pid: row0.pid, beforeAlive, beforeImage, cancel: c, afterAlive, row, outcomeStatus: outcome.status };
    (evidence.runs as unknown[]).push(record);
    console.log(`  -> pid ${row0.pid} (${beforeImage}) alive before=${beforeAlive} after=${afterAlive}; taskkill: ${c.detail.replace(/\s+/g, " ").slice(0, 160)}; row=${JSON.stringify(row)}`);
  } catch (e) {
    console.log(`  !! cancel proof failed: ${e instanceof Error ? e.message : String(e)}`);
    (evidence.runs as unknown[]).push({ workspace: ws, kind: "cancel", error: e instanceof Error ? e.message : String(e) });
  }
}

evidence.finishedAt = nowIso();
const file = path.join(dataDir(), `evidence-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
console.log(`\nEvidence written to ${file}`);
server.close();
process.exit(0);
