#!/usr/bin/env node
// Live acceptance scenarios against a running HQ server (default http://127.0.0.1:4610).
//
//   node scripts/e2e-live.mjs <scenario> [...]      scenarios: plan, one-read, Studio-read, ambiguous,
//                                                   gmail-ambiguous, approval-reject, cancel,
//                                                   attachment, restart, logs, root-boundary, all
//   isolated-instance scenarios (need a deliberately misconfigured HQ at JOS_HQ_URL):
//                                                   runtime-missing, identity-Studio
//
// Every scenario runs through the public HTTP API exactly as the UI does. Approvals are ALWAYS
// rejected: these tests never execute a real outward-facing action. They send in "edit" mode, never
// "auto": since 2026-09-23 Auto approves validated actions without asking, so an Auto scenario would
// perform its side effect for real.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HQ = (process.env.JOS_HQ_URL || "http://127.0.0.1:4610").replace(/\/+$/, "");
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JOS = path.resolve(APP, "..");
const LOGS = ["ONEMEMORY.md", "STUDIOMEMORY.md", "JOSMEMORY.md"];

/** The Markdown entry anchored to `taskId`, from whichever log holds it. */
function logEntry(taskId) {
  for (const f of LOGS) {
    const text = fs.readFileSync(path.join(JOS, f), "utf8").replace(/\r\n/g, "\n");
    const i = text.indexOf(`<!-- jos:run=${taskId} -->`);
    if (i < 0) continue;
    const start = text.lastIndexOf("\n## ", i) + 1;
    const rest = text.slice(start + 3);
    const end = rest.search(/\n## |\n---\n/);
    return { file: f, text: end < 0 ? text.slice(start) : text.slice(start, start + 3 + end) };
  }
  return null;
}
const TERMINAL = new Set(["completed", "unverified", "planned", "failed", "blocked", "cancelled", "rejected", "interrupted", "needs_reconciliation", "closed"]);

async function api(method, url, body) {
  const res = await fetch(HQ + url, { method, headers: { "content-type": "application/json", "x-jos-hq": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function events(taskId, after) {
  const r = await api("GET", `/api/tasks/${taskId}/events.json?after=${after}`);
  return r.json?.events ?? [];
}

async function follow(taskId, { onWaiting, timeoutMs = 20 * 60_000, onTick } = {}) {
  let after = 0;
  const t0 = Date.now();
  for (;;) {
    for (const e of await events(taskId, after)) {
      after = e.id;
      if (e.visibility === "chat" || /launch_verified|connection_used|gateway_blocked|executor_complete|planning_complete/.test(e.type)) {
        console.log(`   [${e.createdAt.slice(11, 19)}] ${String(e.system ?? "").padEnd(12)} ${e.type}: ${e.summary.slice(0, 200)}`);
      }
    }
    const { json } = await api("GET", `/api/tasks/${taskId}`);
    const t = json?.task;
    if (!t) throw new Error(`task ${taskId} vanished`);
    if (onTick) {
      const stop = await onTick(t, json);
      if (stop) return json;
    }
    if (TERMINAL.has(t.status)) return json;
    if (t.status === "needs_clarification" || t.status === "awaiting_approval") {
      if (!onWaiting) {
        console.log(`   !! unexpected wait (${t.status}): ${t.context?.pendingQuestion?.question ?? "approval"} — stopping this scenario`);
        return json;
      }
      const handled = await onWaiting(t, json);
      if (handled === "stop") return json;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${taskId}`);
    await sleep(2000);
  }
}

async function newChat(title) {
  const r = await api("POST", "/api/chats", { title });
  return r.json.chat.id;
}

async function send(chatId, content, route = "auto", mode = "edit") {
  const r = await api("POST", `/api/chats/${chatId}/messages`, { content, route, mode });
  if (!r.ok) throw new Error(`send failed: ${JSON.stringify(r.json)}`);
  return r.json.taskId ?? r.json.answered;
}

function summary(label, j) {
  const t = j.task;
  console.log(`=> ${label}: status=${t.status} verification=${t.verification} route=${t.route} (${t.route_reason}) log=${t.log_file}:${t.log_status ?? "open"}`);
  for (const x of j.executions) console.log(`   execution ${x.phase}: ${x.runtime} · ${x.verified_model ?? x.model} · ${x.verified_effort ?? x.effort} · pid ${x.pid} · ${x.status} · verified=${x.verified} · cwd ${x.cwd}`);
  if (j.usage?.length) console.log(`   gateway-observed calls: ${j.usage.map((u) => `${u.platform ?? "one"}:${u.category}/${u.decision}${u.ok ? "" : "(!)"}`).join(", ")}`);
  if (t.result?.answer) console.log(`   answer: ${String(t.result.answer).replace(/\s+/g, " ").slice(0, 300)}`);
  if (t.error) console.log(`   error: ${t.error.slice(0, 300)}`);
  return t;
}

const scenarios = {
  async plan() {
    const chat = await newChat("HQ acceptance test: Plan mode");
    const id = await send(chat, "HQ acceptance test (Plan mode): plan how Devin could get a weekly summary of new Stripe customers posted to Slack. Plan only.", "auto", "plan");
    return summary("plan", await follow(id));
  },
  async "one-read"() {
    const chat = await newChat("HQ acceptance test: One read-only");
    const id = await send(chat, "HQ acceptance test (read-only): report which connections this workspace has, grouped by platform, with each connection's state and access policy. Use only `one --agent connection list`; do not read any mailbox, channel, page or record.", "One", "edit");
    return summary("one-read", await follow(id));
  },
  async "Studio-read"() {
    const chat = await newChat("HQ acceptance test: Studio read-only");
    const id = await send(chat, "HQ acceptance test (read-only): find which Google Drive actions exist for listing files, using `one --agent actions search` only. Do not execute any action and do not read any file.", "Studio", "edit");
    return summary("Studio-read", await follow(id));
  },
  async ambiguous() {
    const chat = await newChat("HQ acceptance test: ambiguous route");
    const id = await send(chat, "Summarize my unread email from today.", "auto", "edit");
    const j = await follow(id, {
      onWaiting: async (t) => {
        console.log(`   question: ${t.context?.pendingQuestion?.question}`);
        const c = await api("POST", `/api/tasks/${id}/cancel`, {});
        console.log(`   cancelled while waiting: ${JSON.stringify(c.json)}`);
      },
    });
    return summary("ambiguous", j);
  },
  async "gmail-ambiguous"() {
    // TEST 9: neither the business nor a One mailbox may be chosen for the operator.
    const chat = await newChat("HQ acceptance test: ambiguous Gmail");
    const id = await send(chat, "Send this from Gmail", "auto", "edit");
    const j = await follow(id, {
      onWaiting: async (t) => {
        const q = t.context?.pendingQuestion;
        console.log(`   question (${q?.kind}): ${q?.question} · options: ${(q?.options ?? []).map((o) => o.label).join(" | ")}`);
        if (q?.kind === "route") {
          await api("POST", `/api/tasks/${id}/clarify`, { answer: "One" });
          console.log("   answered the business question: One");
          return;
        }
        const c = await api("POST", `/api/tasks/${id}/cancel`, {});
        console.log(`   cancelled at the ${q?.kind} question: ${JSON.stringify(c.json)}`);
      },
    });
    console.log(`   executor launches: ${j.executions.length}`);
    return summary("gmail-ambiguous", j);
  },
  async "runtime-missing"() {
    // TEST 20, against an isolated HQ whose config pins a missing Claude binary and an impossible Codex minimum.
    const h = await api("GET", "/api/runtime/health?fresh=1");
    console.log(`   Runtime Health: ${h.json.status}`);
    for (const c of h.json.checks.filter((x) => x.status !== "pass")) console.log(`     ${c.status.padEnd(4)} ${c.group} · ${c.label}: ${c.detail}`);
    for (const ws of ["One", "Studio"]) {
      const chat = await newChat(`HQ acceptance test: ${ws} runtime unavailable`);
      const id = await send(chat, `HQ acceptance test (runtime unavailable: an isolated HQ instance with the ${ws} runtime deliberately missing): report how many connections this workspace has, using \`one --agent connection list\` only.`, ws, "edit");
      const j = await follow(id);
      summary(`runtime-missing ${ws}`, j);
      console.log(`   executor launches: ${j.executions.length} · planning sessions: ${j.executions.filter((e) => e.phase === "plan").length}`);
    }
  },
  async "identity-Studio"() {
    // TEST 3 / 16 for Studio, against an isolated HQ that expects a fake Studio email.
    const chat = await newChat("HQ acceptance test: Studio wrong identity");
    const id = await send(chat, "HQ acceptance test (wrong identity: an isolated HQ instance that expects a fake Studio email): report how many connections this workspace has, using `one --agent connection list` only.", "Studio", "edit");
    const j = await follow(id);
    summary("identity-Studio", j);
    console.log(`   executor launches: ${j.executions.length}`);
    const h = await api("GET", "/api/runtime/health?fresh=1");
    console.log(`   Runtime Health: ${h.json.status}; read-only inspection still runs:`);
    for (const c of h.json.checks.filter((x) => x.group === "Studio")) console.log(`     ${c.status.padEnd(4)} ${c.label}: ${c.detail}`);
  },
  async attachment() {
    // TEST 11 (both executors read a local attachment) and TEST 19 (a real connection read updates telemetry).
    const token = `HQ-ATTACH-${Date.now().toString(36).toUpperCase()}`;
    const before = await api("GET", "/api/connections");
    const gmailBefore = before.json.rows.find((r) => r.platform === "gmail")?.lastUsed ?? null;
    const asks = {
      One: `HQ acceptance test (attachment and connection telemetry, read-only). 1) Read the attached file hq-attachment-One.txt and report its verification token exactly. 2) In the Main Operator Gmail mailbox, list the names of its labels — labels only; do not open, read or list any message, and change nothing.`,
      "Studio": "HQ acceptance test (attachment, read-only): read the attached file hq-attachment-Studio.txt and report its verification token exactly. Do not call any platform action and change nothing.",
    };
    for (const ws of ["One", "Studio"]) {
      const chat = await newChat(`HQ acceptance test: ${ws} attachment`);
      const fd = new FormData();
      fd.append("file", new Blob([`J/OS HQ attachment test for ${ws}\nverification token: ${token}\nThis file is harmless; it only proves an executor can read a local attachment.\n`], { type: "text/plain" }), `hq-attachment-${ws}.txt`);
      const up = await (await fetch(`${HQ}/api/chats/${chat}/attachments`, { method: "POST", headers: { "x-jos-hq": "1" }, body: fd })).json();
      const att = up.attachments[0];
      console.log(`   ${ws}: uploaded ${att.name} (${att.size} B, sha256 ${att.sha256.slice(0, 12)}…) into HQ's local store`);
      const r = await api("POST", `/api/chats/${chat}/messages`, { content: asks[ws], route: ws, mode: "edit", attachmentIds: [att.id] });
      const j = await follow(r.json.taskId);
      summary(`attachment ${ws}`, j);
      console.log(`   ${ws} executor reported the token: ${String(j.task.result?.answer ?? "").includes(token) ? "YES" : "NO"}`);
    }
    const after = await api("GET", "/api/connections");
    const gmail = after.json.rows.find((r) => r.platform === "gmail");
    console.log(`   J3 Last Used for gmail: before=${gmailBefore ?? "never"} after=${gmail?.lastUsed ?? "never"}`);
    const dash = await api("GET", "/api/dashboard?range=today");
    console.log(`   J1 Top Connections (today): ${(dash.json?.topConnections ?? []).map((t) => `#${t.rank} ${t.tool} ${t.calls} call(s), last ${t.lastUsed}`).join("; ")}`);
    const where = await api("GET", `/api/search?q=${encodeURIComponent(token)}`);
    console.log(`   HQ search for the token (local only): ${JSON.stringify(where.json).slice(0, 300)}`);
  },
  async restart() {
    // DoD 29: a run interrupted by an HQ restart is never reported Complete.
    const chat = await newChat("HQ acceptance test: restart mid-run");
    const id = await send(chat, "HQ acceptance test (restart mid-run, read-only): run `one --agent actions search` for gmail, notion, exa, tavily, firecrawl and google-calendar, one at a time, and after each write three sentences about the results before running the next. Do not execute any action.", "Studio", "manual");
    for (let i = 0; ; i++) {
      const { json } = await api("GET", `/api/tasks/${id}`);
      const e = json.executions.find((x) => x.status === "running" && x.verified);
      if (e) {
        console.log(`   executing (pid ${e.pid}, verified); restarting HQ now`);
        break;
      }
      if (TERMINAL.has(json.task.status) || i > 150) return summary("restart (finished before the restart could happen)", json);
      await sleep(2000);
    }
    await sleep(3000);
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(APP, "scripts", "restart.ps1")], { stdio: "inherit" });
    const { json } = await api("GET", `/api/tasks/${id}`);
    summary("restart", json);
    const entry = logEntry(id);
    console.log(`   log ${entry?.file}: ${entry?.text.split("\n").filter((l) => /\*\*(Status|Interrupted|Closed)/.test(l)).join(" | ")}`);
    const r = await api("POST", `/api/tasks/${id}/reconcile`, { logStatus: "abandoned", note: "restart acceptance test: HQ was restarted on purpose mid-run; the read-only run was stopped with it and nothing outward-facing was involved" });
    console.log(`   reconciled by the test operator: ${JSON.stringify(r.json)}`);
    const after = await api("GET", `/api/tasks/${id}`);
    summary("restart after reconciliation", after.json);
  },
  async logs() {
    // TEST 18: one task, one entry in one log; phase 2 edited that same entry.
    const tasks = new Set();
    for (const f of LOGS) for (const m of fs.readFileSync(path.join(JOS, f), "utf8").matchAll(/<!-- jos:run=(jos_[A-Za-z0-9_]+) -->/g)) tasks.add(m[1]);
    let bad = 0;
    for (const id of tasks) {
      const hits = LOGS.map((f) => [f, (fs.readFileSync(path.join(JOS, f), "utf8").match(new RegExp(`jos:run=${id} -->`, "g")) ?? []).length]).filter(([, n]) => n);
      const e = logEntry(id);
      const closed = (e?.text.match(/^- \*\*Closed:\*\*/gm) ?? []).length;
      const status = e?.text.match(/^- \*\*Status:\*\* (.+)$/m)?.[1];
      const ok = hits.length === 1 && hits[0][1] === 1 && closed <= 1;
      if (!ok) bad++;
      console.log(`   ${ok ? "ok " : "BAD"} ${id} · ${hits.map(([f, n]) => `${f}×${n}`).join(", ")} · status ${status} · Closed bullets ${closed}`);
    }
    console.log(`   ${tasks.size} HQ tasks in the logs; ${bad} with duplicate entries or close-outs`);
  },
  async "approval-reject"() {
    const chat = await newChat("HQ acceptance test: approval gate");
    const id = await send(
      chat,
      "HQ acceptance test (approval gate): in the Main Operator Gmail mailbox, create a draft email to operator@example.com with subject \"J/OS HQ approval-gate test\" and body \"This draft is an approval-gate test and will be rejected.\" Do not send anything. Creating the draft is a write, so prepare it and propose it for approval.",
      "One",
      "edit",
    );
    const j = await follow(id, {
      onWaiting: async (t, full) => {
        if (t.status === "needs_clarification") {
          console.log(`   unexpected question: ${t.context?.pendingQuestion?.question} -> answering "Main Operator"`);
          await api("POST", `/api/tasks/${id}/clarify`, { answer: "Main Operator" });
          return;
        }
        const ap = full.approvals.find((a) => a.status === "pending");
        if (!ap) return;
        console.log(`   APPROVAL ${ap.id}: ${ap.summary}`);
        for (const a of ap.actions) console.log(`     #${a.index} ${a.title} · ${a.platform} · ${a.connectionName} · dry-run=${a.dryRun?.ok ? `${a.dryRun.method} ${a.dryRun.url}` : a.dryRun?.detail} · executorDryRunMatched=${a.executorDryRunMatched} · problems=${a.problems.length}\n       payload=${JSON.stringify({ body: a.data, pathVars: a.pathVars, query: a.queryParams }).slice(0, 400)}`);
        const r = await api("POST", `/api/approvals/${ap.id}/reject`, { note: "acceptance test: approval gate verified, rejecting" });
        console.log(`   rejected: ${JSON.stringify(r.json)}`);
      },
    });
    return summary("approval-reject", j);
  },
  async cancel() {
    const chat = await newChat("HQ acceptance test: cancellation");
    const id = await send(chat, "HQ acceptance test (cancellation, read-only): run `one --agent actions search` for gmail, notion, exa, tavily, firecrawl and google-calendar, one at a time, and after each write three sentences about the results before running the next. Do not execute any action.", "Studio", "manual");
    let cancelled = false;
    const j = await follow(id, {
      onTick: async (t, full) => {
        if (cancelled) return false;
        const e = full.executions.find((x) => x.status === "running");
        if (e && e.verified) {
          await sleep(4000);
          const r = await api("POST", `/api/tasks/${id}/cancel`, {});
          console.log(`   cancel requested while executing (pid ${e.pid}): ${JSON.stringify(r.json)}`);
          cancelled = true;
        }
        return false;
      },
    });
    return summary("cancel", j);
  },
  async "root-boundary"() {
    const cases = [
      ["dispatch to root", { to: "root", prompt: "x".repeat(60), origin: { cwd: "C:\\Users\\operator\\Backup\\OneDrive\\Desktop\\JOS" } }],
      ["dispatch to arbitrary path", { to: "C:\\Windows", prompt: "x".repeat(60), origin: {} }],
      ["dispatch from inside JOS/One", { to: "Studio", prompt: "x".repeat(60), origin: { cwd: "C:\\Users\\operator\\Backup\\OneDrive\\Desktop\\JOS\\One\\Tasks" } }],
      ["dispatch from an executor env", { to: "One", prompt: "x".repeat(60), origin: { executorExecutionId: "exe_fake" } }],
      ["thin prompt", { to: "One", prompt: "Handle this.", origin: {} }],
    ];
    for (const [label, body] of cases) {
      const r = await api("POST", "/api/dispatch", body);
      console.log(`   ${label}: HTTP ${r.status} ${r.json?.error?.code ?? ""} — ${r.json?.error?.message ?? JSON.stringify(r.json)}`);
    }
    // TEST 1: the root is the planning account, holds only OpenRouter, and cannot execute.
    const h = await api("GET", "/api/runtime/health?fresh=1");
    for (const c of h.json.checks.filter((x) => x.group === "Orchestrator")) console.log(`   ${c.status.padEnd(4)} ${c.label}: ${c.detail}`);
    const noHeader = await fetch(HQ + "/api/chats", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    console.log(`   mutation without x-jos-hq header: HTTP ${noHeader.status}`);
    const foreign = await fetch(HQ + "/api/chats", { method: "POST", headers: { "content-type": "application/json", "x-jos-hq": "1", origin: "https://evil.example" }, body: "{}" });
    console.log(`   mutation from a foreign origin: HTTP ${foreign.status}`);
  },
};

const ISOLATED = new Set(["runtime-missing", "identity-Studio"]);
const want = process.argv.slice(2);
const list = want.includes("all") ? Object.keys(scenarios).filter((k) => !ISOLATED.has(k)) : want;
for (const name of list) {
  if (!scenarios[name]) {
    console.log(`unknown scenario ${name}`);
    continue;
  }
  console.log(`\n######## ${name}`);
  try {
    await scenarios[name]();
  } catch (e) {
    console.log(`!! ${name} failed: ${e instanceof Error ? e.stack : String(e)}`);
  }
}
