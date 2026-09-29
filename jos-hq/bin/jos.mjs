#!/usr/bin/env node
// jos — the J/OS HQ client for root Orchestrator sessions. HQ is the only dispatch authority; a root
// session hands it a self-contained executor prompt instead of starting an executor itself.
//
//   node jos-hq/bin/jos.mjs dispatch --to <One|Studio> --prompt-file <file> [--title <t>] [--mode edit|manual|auto] [--no-wait]
//     --mode defaults to edit: side effects wait for the operator. auto approves them without asking.
//   node jos-hq/bin/jos.mjs status <taskId>
//   node jos-hq/bin/jos.mjs watch <taskId>
//   node jos-hq/bin/jos.mjs approve <approvalId> [--note <text>]
//   node jos-hq/bin/jos.mjs reject <approvalId> [--note <text>]
//   node jos-hq/bin/jos.mjs cancel <taskId> [--force]
//   node jos-hq/bin/jos.mjs health
//   node jos-hq/bin/jos.mjs agents migrate
//   jos judge [status|probe|backfill]   TypeSafe judgment layer: status, one live call, replay history
//
// Env: JOS_HQ_URL (default http://127.0.0.1:4610), JOS_HQ_ACCESS_KEY_FILE (default
// %LOCALAPPDATA%\JOS\hq\access.key, the key HQ requires as x-jos-key; see lib/server/access.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HQ = (process.env.JOS_HQ_URL || "http://127.0.0.1:4610").replace(/\/+$/, "");
const here = path.dirname(fileURLToPath(import.meta.url));
const josRoot = path.resolve(here, "..", "..");

// The same resolution as lib/server/access.ts's accessKeyFile().
function accessKeyFile() {
  if (process.env.JOS_HQ_ACCESS_KEY_FILE) return path.resolve(process.env.JOS_HQ_ACCESS_KEY_FILE);
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "JOS", "hq", "access.key");
}

class KeyMissing extends Error {}
let cachedKey = null;
function accessKey() {
  if (cachedKey) return cachedKey;
  const f = accessKeyFile();
  const k = fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : "";
  if (!k) throw new KeyMissing(`no HQ access key at ${f}. HQ writes it when it first serves a request; start HQ, or set JOS_HQ_ACCESS_KEY_FILE.`);
  cachedKey = k;
  return k;
}

function die(msg, code = 1) {
  process.stderr.write(`jos: ${msg}\n`);
  process.exitCode = code;
  return code;
}

function within(child, parent) {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  return c === p || c.startsWith(p + path.sep);
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function api(method, url, body) {
  const res = await fetch(HQ + url, {
    method,
    headers: { "content-type": "application/json", "x-jos-hq": "1", "x-jos-key": accessKey() },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { code: "HQ_UNREACHABLE", message: `J/OS HQ is not reachable at ${HQ} (${e.message}). Start it with: npm --prefix jos-hq run start` } }) }));
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { ok: res.ok, status: res.status, json };
}

const TERMINAL = new Set(["task_complete", "task_blocked", "task_cancelled", "task_failed"]);

async function watch(taskId) {
  const res = await fetch(`${HQ}/api/tasks/${encodeURIComponent(taskId)}/events`, { headers: { accept: "text/event-stream", "x-jos-key": accessKey() } }).catch(() => null);
  if (!res || !res.ok || !res.body) return die(`cannot stream events for ${taskId}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      if (!data) continue;
      let e;
      try {
        e = JSON.parse(data);
      } catch {
        continue;
      }
      if (e.visibility === "chat" || TERMINAL.has(e.type)) {
        process.stdout.write(`[${e.createdAt.slice(11, 19)}] ${e.system ?? ""} ${e.type}: ${e.summary}\n`);
      }
      if (e.type === "approval_required") {
        process.stdout.write(`  -> approve in the HQ UI, or: node jos-hq/bin/jos.mjs approve ${e.data?.approvalId}\n`);
      }
      if (TERMINAL.has(e.type)) {
        const s = await api("GET", `/api/tasks/${encodeURIComponent(taskId)}`);
        const t = s.json?.task;
        if (t) process.stdout.write(`\nstatus: ${t.status} · verification: ${t.verification} · log: ${t.log_file ?? "-"} (${t.log_status ?? "open"})\n${t.result?.answer ?? t.error ?? ""}\n`);
        try {
          await reader.cancel();
        } catch {
          /* closed */
        }
        return t?.status === "completed" ? 0 : 3;
      }
    }
  }
  return 0;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(4, 14).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
    return 0;
  }

  // Executors execute; they do not dispatch (checked here and again by the server).
  const execId = process.env.JOS_HQ_EXECUTION_ID || process.env.JOS_HQ_TASK_ID;
  if (cmd === "dispatch" && execId) return die("refusing to dispatch from inside an executor session (JOS_HQ_EXECUTION_ID is set). Executors execute; they do not become Orchestrators.", 4);
  for (const ws of ["One", "Studio"]) {
    if (cmd === "dispatch" && within(process.cwd(), path.join(josRoot, ws))) return die(`refusing to dispatch from inside the ${ws} executor workspace (${process.cwd()}).`, 4);
  }

  if (cmd === "dispatch") {
    const to = argValue(args, "--to");
    const file = argValue(args, "--prompt-file");
    if (!to || !file) return die("usage: jos dispatch --to <One|Studio> --prompt-file <file> [--title <t>] [--mode auto|manual|edit] [--no-wait]");
    const prompt = fs.readFileSync(path.resolve(file), "utf8");
    const r = await api("POST", "/api/dispatch", {
      to,
      prompt,
      title: argValue(args, "--title"),
      // Not "auto": Auto approves side effects without asking, which is the operator's choice to make
      // in the UI, not a default for a session that dispatches on its own.
      mode: argValue(args, "--mode") ?? "edit",
      origin: { cwd: process.cwd(), executorExecutionId: execId ?? null },
    });
    if (!r.ok) return die(`${r.json?.error?.code ?? r.status}: ${r.json?.error?.message ?? "dispatch refused"}`, 2);
    process.stdout.write(`task ${r.json.taskId} · ${HQ}/chat/${r.json.chatId}\n`);
    if (args.includes("--no-wait")) return 0;
    return watch(r.json.taskId);
  }
  if (cmd === "watch") return args[0] ? watch(args[0]) : die("usage: jos watch <taskId>");
  if (cmd === "status") {
    const r = await api("GET", `/api/tasks/${encodeURIComponent(args[0] ?? "")}`);
    if (!r.ok) return die(r.json?.error?.message ?? "not found");
    const t = r.json.task;
    process.stdout.write(JSON.stringify({ id: t.id, status: t.status, stage: t.stage, route: t.route, reason: t.route_reason, verification: t.verification, log: t.log_file, logStatus: t.log_status, answer: t.result?.answer ?? null }, null, 2) + "\n");
    return 0;
  }
  if (cmd === "approve" || cmd === "reject") {
    const r = await api("POST", `/api/approvals/${encodeURIComponent(args[0] ?? "")}/${cmd}`, { note: argValue(args, "--note") ?? null });
    if (!r.ok) return die(r.json?.error?.message ?? `${cmd} failed`);
    process.stdout.write(`${cmd}d ${args[0]}\n`);
    return 0;
  }
  if (cmd === "cancel") {
    const r = await api("POST", `/api/tasks/${encodeURIComponent(args[0] ?? "")}/cancel`, { force: args.includes("--force") });
    if (!r.ok) return die(r.json?.error?.message ?? "cancel failed");
    process.stdout.write(`cancel: ${r.json.detail}\n`);
    return 0;
  }
  if (cmd === "health") {
    const r = await api("GET", "/api/runtime/health");
    if (!r.ok) return die(r.json?.error?.message ?? "health failed");
    process.stdout.write(`Runtime: ${r.json.status}\n`);
    for (const c of r.json.checks) process.stdout.write(`  ${c.status === "pass" ? "ok  " : c.status === "warn" ? "warn" : "FAIL"} ${c.group} · ${c.label}: ${c.detail}\n`);
    return r.json.status === "Blocked" ? 5 : 0;
  }
  if (cmd === "agents" && args[0] === "migrate") {
    const r = await api("POST", "/api/agents/migrate", {});
    if (!r.ok) return die(r.json?.error?.message ?? "migration failed");
    const results = r.json.results ?? [];
    if (!results.length) process.stdout.write("no agent definitions found\n");
    for (const x of results) process.stdout.write(`${x.status.padEnd(9)} ${x.workspace} ${x.name} — ${x.detail}\n`);
    return results.some((x) => x.status === "failed") ? 6 : 0;
  }
  if (cmd === "judge") {
    const sub = args[0] ?? "status";
    if (sub === "probe") {
      const r = await api("POST", "/api/judge/probe", {});
      process.stdout.write(JSON.stringify(r.json, null, 2) + "\n");
      const f = r.json?.formats;
      if (f) process.stdout.write(`answer formats: score keys ${f.scoreKeys.join(", ") || "(none)"}, range ${f.scoreRange ? f.scoreRange.join("..") : "not numeric"}, choice ${f.choiceOk ? "ok" : "NOT ok"}\n`);
      return r.ok && r.json?.ok ? 0 : 1;
    }
    if (sub === "backfill") {
      const start = await api("POST", "/api/judge/backfill", {});
      if (!start.ok) return die(start.json?.error?.message ?? "backfill failed to start");
      for (;;) {
        const r = await api("GET", "/api/judge");
        const b = r.json?.backfill;
        process.stdout.write(`backfill ${b?.state}: ${b?.tasks ?? 0} tasks, ${b?.labelled ?? 0} labels, ${b?.skipped ?? 0} skipped\n`);
        if (b?.state !== "running") return b?.state === "done" ? 0 : 1;
        await new Promise((res) => setTimeout(res, 3000));
      }
    }
    const r = await api("GET", "/api/judge");
    process.stdout.write(JSON.stringify({ configured: r.json?.configured, pin: r.json?.pin, root: r.json?.rootConnection, breaker: r.json?.breaker, stats: r.json?.stats, gates: r.json?.gates?.map((g) => ({ key: g.key, mode: g.mode, live: g.live, threshold: g.threshold, labelled: g.labelled })) }, null, 2) + "\n");
    return r.ok ? 0 : 1;
  }
  return die(`unknown command ${cmd}`);
}

main().then(
  (code) => {
    if (typeof code === "number") process.exitCode = code;
  },
  (e) => {
    if (e instanceof KeyMissing) die(e.message, 7);
    else throw e;
  },
);
