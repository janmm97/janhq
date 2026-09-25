#!/usr/bin/env node
// Task 12 prep: screenshots of the redesign's POPULATED states, for the finish reviewer.
//
// - It starts a throwaway UI-test HQ (scripts/e2e-server.mjs) on port 4614 — never live HQ (4610).
// - It seeds design-review fixture rows into THAT throwaway instance's own database only. The fake
//   One CLI is first on that instance's PATH and its identities never pass the gate, so nothing here
//   can reach a real account or launch a real planner or executor.
// - It captures screenshots of the dashboard, a chat with a pending approval, a chat waiting on a
//   routing question, and a running task, then stops the throwaway server.
// - It never touches live HQ (4610), its data directory, or any real One/Studio/root account. The only
//   contact with live HQ is one read-only GET to confirm it still answers.
//
// Usage: node scripts/review-states.mjs
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = "4614";
const base = `http://127.0.0.1:${PORT}`;
const outDir = path.join(app, ".impeccable", "review", "states");
fs.mkdirSync(outDir, { recursive: true });

const now = Date.now();
const secAgo = (s) => new Date(now - s * 1000).toISOString();
const hoursAgo = (h) => new Date(now - h * 3600_000).toISOString();
const before = (iso, s) => new Date(Date.parse(iso) - s * 1000).toISOString();

function jsonHeaders() {
  return { "content-type": "application/json", "x-jos-hq": "1" };
}
async function apiPost(pathname, data) {
  const r = await fetch(base + pathname, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(data ?? {}) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${pathname} -> ${r.status} ${JSON.stringify(body)}`);
  return body;
}
async function apiGet(pathname) {
  const r = await fetch(base + pathname);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${pathname} -> ${r.status} ${JSON.stringify(body)}`);
  return body;
}
async function waitFor(fn, { timeoutMs = 20_000, intervalMs = 500, label = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

let serverChild = null;
let browser = null;

try {
  // One read-only GET: confirm live HQ (4610) still answers, and touch nothing else on it.
  try {
    const r = await fetch("http://127.0.0.1:4610/");
    console.log(`live HQ (4610) still answers: ${r.status}`);
  } catch (e) {
    console.log(`live HQ (4610) check failed (continuing; this script never depends on it): ${e.message}`);
  }

  // 1. Build .next-e2e so the throwaway instance serves the current code. Live HQ's .next is untouched.
  console.log("building .next-e2e …");
  const build = spawnSync(process.execPath, [path.join(app, "scripts", "build-e2e.mjs")], { cwd: app, stdio: "inherit" });
  if (build.status !== 0) throw new Error(`build-e2e.mjs failed with status ${build.status}`);

  // 2. Start the throwaway UI-test server on 4614 and learn its J/OS copy's root from its own stdout.
  console.log("starting throwaway e2e server on 4614 …");
  serverChild = spawn(process.execPath, [path.join(app, "scripts", "e2e-server.mjs")], {
    cwd: app,
    env: { ...process.env, JOS_HQ_PORT: PORT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let root = null;
  const rootPromise = new Promise((resolve) => {
    const onData = (buf) => {
      const text = buf.toString("utf8");
      process.stdout.write(text);
      const m = text.match(/\[e2e-server\] J\/OS copy at (.+)/);
      if (m) resolve(m[1].trim());
    };
    serverChild.stdout.on("data", onData);
  });
  serverChild.stderr.on("data", (buf) => process.stderr.write(buf));
  serverChild.on("exit", (code) => {
    if (code !== null && code !== 0) console.log(`throwaway e2e server exited early with code ${code}`);
  });
  root = await Promise.race([rootPromise, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out waiting for the e2e-server's J/OS copy root")), 30_000))]);
  console.log(`J/OS copy at ${root}`);
  const dataDir = path.join(path.dirname(root), "data");
  const dbPath = path.join(dataDir, "hq.sqlite");

  await waitFor(
    async () => {
      const r = await fetch(`${base}/api/chats`);
      return r.status === 200 ? true : null;
    },
    { timeoutMs: 60_000, label: `${base}/api/chats to answer 200` },
  );
  console.log("throwaway HQ is answering");

  // 3. Seed through the API where the product itself can do it: a real routing decision that lands on
  //    needs_clarification because it names an entity from each business (Riley -> One, Blake -> Studio).
  const clarifyChat = await apiPost("/api/chats", { title: "Contract questions for Riley and Blake" });
  const clarifyChatId = clarifyChat.chat.id;
  const clarifySend = await apiPost(`/api/chats/${clarifyChatId}/messages`, { content: "Tell Riley and Blake what the contract says" });
  const clarifyTaskId = clarifySend.taskId;
  await waitFor(
    async () => {
      const d = await apiGet(`/api/chats/${clarifyChatId}`);
      const t = d.tasks.find((x) => x.id === clarifyTaskId);
      return t && t.status === "needs_clarification" ? t : null;
    },
    { timeoutMs: 20_000, label: "the Riley/Blake task to reach needs_clarification" },
  );
  console.log("Riley/Blake chat is waiting on a routing question (needs_clarification)");

  // 4. Seed the rest directly, through node:sqlite against the throwaway instance's own database.
  //    Every fixture id carries an fx_ prefix. This never touches any file outside dataDir/hq.sqlite.
  const sqlite = process.getBuiltinModule("node:sqlite");
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const run = (sql, params = []) => db.prepare(sql).run(...params);
  const J = (v) => JSON.stringify(v);
  const CTX = J({ clarifications: [] });

  // ---- Holder of One, waiting on an approval: "Draft the weekly support digest" ------------------
  const oneRoot = path.join(root, "One");
  run("INSERT INTO chats(id, title, purpose, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)", ["fx_chat_digest", "Weekly support digest draft", secAgo(420), secAgo(200)]);
  run(
    `INSERT INTO tasks(id, chat_id, origin, title, request, mode, route_selection, route, route_reason, route_evidence_json, status, stage, log_file, log_opened_at, log_closed_at, log_status, plan_json, planner_model, context_json, result_json, verification, error, created_at, updated_at, ended_at, admitted_at)
     VALUES (?, ?, 'chat', ?, ?, 'manual', 'auto', 'One', ?, NULL, 'awaiting_approval', 'approve', 'ONEMEMORY.md', ?, NULL, NULL, NULL, ?, ?, NULL, 'none', NULL, ?, ?, NULL, ?)`,
    [
      "fx_task_digest",
      "fx_chat_digest",
      "Draft the weekly support digest",
      "Draft the weekly support digest",
      "Named entity: Acme",
      secAgo(360),
      "Claude Code Opus 5.5 (medium)",
      CTX,
      secAgo(420),
      secAgo(200),
      secAgo(360),
    ],
  );
  run(
    `INSERT INTO executions(id, task_id, phase, workspace, cwd, adapter, runtime, binary, model, effort, pid, session_id, status, exit_code, started_at, ended_at, cancel_state, verified, verified_model, verified_effort, verification_json, gateway_token_hash, policy_path, prompt_path, output_path, result_json, error, created_at)
     VALUES (?, ?, 'plan', 'One', ?, 'claude-code', ?, 'claude', ?, 'medium', NULL, NULL, 'exited', 0, ?, ?, 'none', 1, ?, 'medium', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
    ["fx_exec_digest_plan", "fx_task_digest", oneRoot, "Claude Code 2.1.281", "claude-opus-5-5", secAgo(355), secAgo(320), "claude-opus-5-5", secAgo(355)],
  );
  run(
    `INSERT INTO executions(id, task_id, phase, workspace, cwd, adapter, runtime, binary, model, effort, pid, session_id, status, exit_code, started_at, ended_at, cancel_state, verified, verified_model, verified_effort, verification_json, gateway_token_hash, policy_path, prompt_path, output_path, result_json, error, created_at)
     VALUES (?, ?, 'preview', 'One', ?, 'claude-code', ?, 'claude', ?, 'medium', NULL, NULL, 'exited', 0, ?, ?, 'none', 1, ?, 'medium', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
    ["fx_exec_digest_preview", "fx_task_digest", oneRoot, "Claude Code 2.1.281", "claude-opus-5-5", secAgo(300), secAgo(270), "claude-opus-5-5", secAgo(300)],
  );
  const digestAction = {
    index: 1,
    kind: "one_action",
    title: "Create a Gmail draft of the weekly digest",
    platform: "gmail",
    actionId: "gmail.users.drafts.create",
    connectionKey: "one_support_gmail",
    connectionName: "Main Support",
    method: "POST",
    target: "draft to support-leads@example.invalid",
    data: { subject: "Weekly support digest — Sep 19–25", body: "Placeholder digest body summarizing this week's support tickets." },
    pathVars: null,
    queryParams: null,
    flowKey: null,
    flowInputs: null,
    sideEffect: "creates a draft; sends nothing",
    idempotent: false,
    expectedCalls: 1,
    estimatedCost: "",
    payloadHash: "fx_hash_digest_gmail_draft_1",
    dryRun: { ok: true, method: "POST", url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts", detail: null },
    executorDryRunMatched: true,
    problems: [],
  };
  run("INSERT INTO approvals(id, task_id, execution_id, status, actions_json, summary, created_at, resolved_at, resolution_note) VALUES (?, ?, ?, 'pending', ?, ?, ?, NULL, NULL)", [
    "fx_apr_digest",
    "fx_task_digest",
    "fx_exec_digest_preview",
    J([digestAction]),
    "Create a Gmail draft of the weekly digest",
    secAgo(265),
  ]);
  run("INSERT INTO approval_actions(approval_id, idx, payload_hash, state, claimed_at, finished_at, outcome_json) VALUES (?, 1, ?, 'pending', NULL, NULL, NULL)", ["fx_apr_digest", digestAction.payloadHash]);

  const msg = (id, chatId, role, kind, content, taskId, data, createdAt) =>
    run("INSERT INTO chat_messages(id, chat_id, role, kind, content, task_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [id, chatId, role, kind, content, taskId, data === null ? null : J(data), createdAt]);
  msg("fx_msg_digest_user", "fx_chat_digest", "user", "text", "Draft the weekly support digest", "fx_task_digest", null, secAgo(420));
  msg("fx_msg_digest_route", "fx_chat_digest", "assistant", "route", "Routed to One.", "fx_task_digest", { workspace: "One", reason: "Named entity: Acme" }, secAgo(350));
  msg(
    "fx_msg_digest_plan",
    "fx_chat_digest",
    "assistant",
    "plan",
    "Plan ready.",
    "fx_task_digest",
    {
      plan: {
        objective: "Draft the weekly support digest for the support-leads mailbox from this week's ticket activity.",
        success_condition: "A Gmail draft exists with the week's summary, ready for a human to review and send.",
        steps: [
          { n: 1, kind: "action", description: "Read the past week's support ticket summary from Notion", platform: "notion", action_id: "notion.search_pages", side_effect: false },
          { n: 2, kind: "transform", description: "Draft the digest body from the ticket summary", platform: "", action_id: "", side_effect: false },
          { n: 3, kind: "action", description: "Create a Gmail draft of the digest for review", platform: "gmail", action_id: "gmail.users.drafts.create", side_effect: true },
        ],
      },
      model: "Claude Code Opus 5.5 (medium)",
      problems: [],
    },
    secAgo(310),
  );
  msg("fx_msg_digest_approval", "fx_chat_digest", "assistant", "approval", "This needs your approval before anything is sent.", "fx_task_digest", { approvalId: "fx_apr_digest" }, secAgo(260));

  // ---- Holder of Studio, running: "Refresh the Q3 scorecard sheet" (no chat) ------------------------
  const wStudioRoot = path.join(root, "Studio");
  run(
    `INSERT INTO tasks(id, chat_id, origin, title, request, mode, route_selection, route, route_reason, route_evidence_json, status, stage, log_file, log_opened_at, log_closed_at, log_status, plan_json, planner_model, context_json, result_json, verification, error, created_at, updated_at, ended_at, admitted_at)
     VALUES (?, NULL, 'cli', ?, ?, 'auto', 'auto', 'Studio', ?, NULL, 'executing', 'execute', 'STUDIOMEMORY.md', ?, NULL, NULL, NULL, ?, ?, NULL, 'none', NULL, ?, ?, NULL, ?)`,
    ["fx_task_studio_run", "Refresh the Q3 scorecard sheet", "Refresh the Q3 scorecard sheet", "Topic signal: scorecard (Studio)", secAgo(180), "Codex GPT 6 Astra (medium)", CTX, secAgo(230), secAgo(30), secAgo(180)],
  );
  run(
    `INSERT INTO executions(id, task_id, phase, workspace, cwd, adapter, runtime, binary, model, effort, pid, session_id, status, exit_code, started_at, ended_at, cancel_state, verified, verified_model, verified_effort, verification_json, gateway_token_hash, policy_path, prompt_path, output_path, result_json, error, created_at)
     VALUES (?, ?, 'preview', 'Studio', ?, 'codex', ?, 'codex', ?, 'medium', NULL, NULL, 'exited', 0, ?, ?, 'none', 1, ?, 'medium', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
    ["fx_exec_studio_preview", "fx_task_studio_run", wStudioRoot, "Codex 0.155.0-alpha.2.6", "gpt-6-sol", secAgo(175), secAgo(160), "gpt-6-sol", secAgo(175)],
  );
  run(
    `INSERT INTO executions(id, task_id, phase, workspace, cwd, adapter, runtime, binary, model, effort, pid, session_id, status, exit_code, started_at, ended_at, cancel_state, verified, verified_model, verified_effort, verification_json, gateway_token_hash, policy_path, prompt_path, output_path, result_json, error, created_at)
     VALUES (?, ?, 'execute', 'Studio', ?, 'codex', ?, 'codex', ?, 'medium', NULL, NULL, 'running', NULL, ?, NULL, 'none', 1, ?, 'medium', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
    ["fx_exec_studio_execute", "fx_task_studio_run", wStudioRoot, "Codex 0.155.0-alpha.2.6", "gpt-6-sol", secAgo(150), "gpt-6-sol", secAgo(150)],
  );
  const scorecardAction = {
    index: 1,
    kind: "one_action",
    title: "Update the Q3 scorecard values",
    platform: "google-drive",
    actionId: "google-drive.files.update",
    connectionKey: "studio_google_drive",
    connectionName: "Studio Drive",
    method: "PATCH",
    target: "Q3 scorecard sheet",
    data: { range: "Q3!A1:F40" },
    pathVars: null,
    queryParams: null,
    flowKey: null,
    flowInputs: null,
    sideEffect: "updates cell values in the sheet",
    idempotent: false,
    expectedCalls: 1,
    estimatedCost: "",
    payloadHash: "fx_hash_studio_scorecard_1",
    dryRun: { ok: true, method: "PATCH", url: "https://www.googleapis.com/drive/v3/files/fx-example", detail: null },
    executorDryRunMatched: true,
    problems: [],
  };
  run("INSERT INTO approvals(id, task_id, execution_id, status, actions_json, summary, created_at, resolved_at, resolution_note) VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, ?)", [
    "fx_apr_Studio",
    "fx_task_studio_run",
    "fx_exec_studio_preview",
    J([scorecardAction]),
    "Update the Q3 scorecard values",
    secAgo(165),
    secAgo(155),
    "Auto mode approved 1 action(s)",
  ]);
  run("INSERT INTO approval_actions(approval_id, idx, payload_hash, state, claimed_at, finished_at, outcome_json) VALUES (?, 1, ?, 'ready', ?, NULL, NULL)", ["fx_apr_Studio", scorecardAction.payloadHash, secAgo(150)]);

  // ---- The line for One: two tasks waiting behind the digest holder -------------------------------
  run(
    `INSERT INTO tasks(id, chat_id, origin, title, request, mode, route_selection, route, route_reason, route_evidence_json, status, stage, log_file, log_opened_at, log_closed_at, log_status, plan_json, planner_model, context_json, result_json, verification, error, created_at, updated_at, ended_at, admitted_at)
     VALUES (?, NULL, 'cli', ?, ?, 'edit', 'auto', 'One', ?, NULL, 'in_line', 'queue', NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, 'none', NULL, ?, ?, NULL, NULL)`,
    ["fx_task_line_msa", "Summarise the MSA redlines for Devin", "Summarise the MSA redlines for Devin", "Named entity: Devin", CTX, secAgo(120), secAgo(120)],
  );
  run(
    `INSERT INTO tasks(id, chat_id, origin, title, request, mode, route_selection, route, route_reason, route_evidence_json, status, stage, log_file, log_opened_at, log_closed_at, log_status, plan_json, planner_model, context_json, result_json, verification, error, created_at, updated_at, ended_at, admitted_at)
     VALUES (?, NULL, 'cli', ?, ?, 'auto', 'auto', 'One', ?, NULL, 'in_line', 'queue', NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, 'none', NULL, ?, ?, NULL, NULL)`,
    ["fx_task_line_hiring", "Prepare the hiring roster update", "Prepare the hiring roster update", "Topic signal: hiring (One)", CTX, secAgo(60), secAgo(60)],
  );

  // ---- The drying line: four finished tasks in the last 7 days, spread over the last two days -----
  const dry = [
    { id: "fx_task_dry_stripe", title: "Reconcile Stripe refunds for September", route: "One", status: "completed", endedAt: hoursAgo(4) },
    { id: "fx_task_dry_hbpg", title: "Update the HBPG meeting notes page", route: "Studio", status: "unverified", endedAt: hoursAgo(20) },
    { id: "fx_task_dry_slack", title: "Post the launch summary to Slack", route: "One", status: "failed", endedAt: hoursAgo(30) },
    { id: "fx_task_dry_nwp", title: "Draft the NWP invoice email", route: "Studio", status: "cancelled", endedAt: hoursAgo(46) },
  ];
  for (const d of dry) {
    const createdAt = before(d.endedAt, 900); // 15 minutes before it ended
    run(
      `INSERT INTO tasks(id, chat_id, origin, title, request, mode, route_selection, route, route_reason, route_evidence_json, status, stage, log_file, log_opened_at, log_closed_at, log_status, plan_json, planner_model, context_json, result_json, verification, error, created_at, updated_at, ended_at, admitted_at)
       VALUES (?, NULL, 'cli', ?, ?, 'auto', 'auto', ?, NULL, NULL, ?, 'close', NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, 'none', NULL, ?, ?, ?, ?)`,
      [d.id, d.title, d.title, d.route, d.status, CTX, createdAt, d.endedAt, d.endedAt, createdAt],
    );
  }
  run("INSERT INTO events(task_id, execution_id, system, type, level, visibility, summary, data_json, created_at) VALUES (?, NULL, 'One', 'executor_result', 'success', 'chat', ?, ?, ?)", [
    "fx_task_dry_stripe",
    "Executor result: completed",
    J({ costUsd: 0.84 }),
    hoursAgo(4),
  ]);

  db.close();
  console.log("fixture rows seeded");

  // 5. Capture the populated states.
  browser = await chromium.launch({ channel: "chrome" });
  const pages = [
    ["dashboard", "/"],
    ["chat-expose", `/chat/fx_chat_digest`],
    ["chat-clarify", `/chat/${clarifyChatId}`],
    ["task-running", `/tasks/fx_task_studio_run`],
  ];
  let saved = 0;
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    for (const [name, url] of pages) {
      await page.goto(base + url);
      await page.waitForTimeout(2500); // live data settles; a fresh result finishes developing
      await page.screenshot({ path: path.join(outDir, `${name}-${width}.png`), fullPage: true });
      saved++;
    }
    await page.close();
  }
  await browser.close();
  browser = null;
  console.log(`saved ${saved} screenshots to ${path.relative(app, outDir)}`);
  console.log(`throwaway folder: ${path.dirname(root)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (serverChild && serverChild.pid && !serverChild.killed) {
    console.log(`stopping throwaway e2e server (pid ${serverChild.pid}) …`);
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(serverChild.pid), "/T", "/F"]);
    } else {
      try {
        serverChild.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
}
