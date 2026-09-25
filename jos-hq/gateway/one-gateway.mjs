#!/usr/bin/env node
// J/OS HQ One gateway.
//
// HQ puts this program first on an executor's PATH as `one`. It passes every command through to
// the real One CLI unchanged, except that it enforces, in code:
//   - the workspace boundary: `one` must run from the executor's own workspace, because the One
//     account is resolved from the working directory;
//   - a verified launch: nothing contacts a platform until HQ has verified the executor's model
//     and reasoning effort;
//   - the blast-radius rule: an external write never runs directly. In PREVIEW it is refused and
//     must be dry-run and proposed; in EXECUTE it runs only as an operator-approved action through
//     `jos-approved run <n>`, which executes the exact approved payload once;
//   - telemetry: every real platform call is reported to HQ as connection usage.
import { parseOneArgs } from "./lib/one-args.mjs";
import { classifyCommand, classifyRequest, requestPath } from "./lib/classify.mjs";
import { runRealOne, extractJson, stripKnownNoise } from "./lib/real-one.mjs";
import { isWithin } from "./lib/paths.mjs";
import { loadPolicy } from "./lib/policy.mjs";
import { hqGet, hqPost } from "./lib/hq-client.mjs";
import { actionPayloadHash, tryParseJson } from "./lib/canonical.mjs";

const argv = process.argv.slice(2);
const started = Date.now();

function out(text) {
  if (text) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

function deny(message, details, exitCode = 1) {
  out(JSON.stringify({ error: `J/OS HQ gateway: ${message}`, josHq: { blocked: true, ...details } }));
  process.stderr.write(`J/OS HQ gateway blocked this command: ${message}\n`);
  return exitCode;
}

async function report(event) {
  try {
    await hqPost("/api/internal/gateway/event", { ...event, durationMs: Date.now() - started }, 3000);
  } catch {
    /* telemetry must never break a read */
  }
}

function summarizeArgs(parsed) {
  const seg = parsed.execute?.segments?.[0];
  // `actions knowledge <platform> <actionId>` has no execute segment; HQ still needs to know which
  // action was looked up, because it checks a plan's "learned from knowledge" claims against this.
  const pos = parsed.other?.positionals ?? [];
  const lookup = parsed.command === "actions" && parsed.subcommand === "knowledge";
  return {
    command: parsed.command,
    subcommand: parsed.subcommand,
    platform: seg?.platform ?? (lookup ? pos[0] ?? null : null),
    actionId: seg?.actionId ?? (lookup ? pos[1] ?? null : null),
    connectionKey: seg?.connectionKey ?? null,
    flowKey: parsed.flow?.target ?? null,
    dryRun: !!(seg?.dryRun || parsed.flow?.dryRun),
    mock: !!(seg?.mock || parsed.flow?.mock),
    agent: parsed.agent,
  };
}

async function passthrough(parsed, category, extra = {}) {
  const r = await runRealOne(argv, { cwd: process.cwd() });
  const json = extractJson(r.stdout);
  const cleanErr = stripKnownNoise(r.stderr);
  if (r.stdout) out(r.stdout.trimEnd());
  if (cleanErr) process.stderr.write(cleanErr + "\n");
  const cliError = json && typeof json === "object" && !Array.isArray(json) && "error" in json;
  const ok = !r.error && !r.timedOut && json !== undefined && !cliError;
  await report({
    kind: "one_call",
    category,
    decision: "allowed",
    ok,
    exitCode: r.code,
    error: cliError ? String(json.error).slice(0, 300) : r.error ?? null,
    args: summarizeArgs(parsed),
    ...extra,
  });
  // The CLI's Windows exit assertion can turn a good result into a non-zero exit; judge by output.
  if (ok) return 0;
  return typeof r.code === "number" && r.code !== 0 ? r.code : 1;
}

async function requireVerified(policy) {
  const r = await hqGet(`/api/internal/gateway/verified?execution=${encodeURIComponent(policy.executionId)}`, 15000);
  if (!r.ok || !r.json) return { ok: false, reason: `HQ unreachable or refused (${r.status || r.error || "no response"})` };
  if (!r.json.verified) return { ok: false, reason: r.json.reason || "executor launch not verified" };
  return { ok: true };
}

async function main() {
  const loaded = loadPolicy();
  if (!loaded.ok) {
    return deny(loaded.error, { category: "environment" });
  }
  const policy = loaded.policy;
  const cwd = process.cwd();
  if (!isWithin(cwd, policy.workspaceRoot)) {
    await report({ kind: "one_call", category: "boundary", decision: "blocked", ok: false, reason: "cwd outside workspace", cwd });
    return deny(
      `\`one\` must run from the ${policy.workspace} workspace (${policy.workspaceRoot}); this command ran from ${cwd}, where the One CLI would resolve a different account.`,
      { category: "boundary", cwd },
    );
  }

  const parsed = parseOneArgs(argv);
  const cls = classifyCommand(parsed);

  // Identity reads and documentation are allowed before launch verification completes.
  const isIdentityRead =
    (parsed.command === "config" && parsed.subcommand === "path") || parsed.command === "whoami";
  if (cls.category === "meta" || isIdentityRead) {
    return passthrough(parsed, cls.category);
  }

  if (!parsed.agent) {
    return deny("always run `one --agent <command>` so the output is structured JSON (J/OS contract).", {
      category: cls.category,
    });
  }

  const v = await requireVerified(policy);
  if (!v.ok) {
    await report({ kind: "one_call", category: cls.category, decision: "blocked", ok: false, reason: v.reason, args: summarizeArgs(parsed) });
    return deny(`this executor launch is not verified: ${v.reason}`, { category: "verification" });
  }

  switch (cls.category) {
    case "read":
    case "preview":
      return passthrough(parsed, cls.category, previewExtra(parsed, cls));
    case "local-write":
      if (policy.allowLocalWrites) return passthrough(parsed, cls.category);
      await report({ kind: "one_call", category: cls.category, decision: "blocked", ok: false, reason: cls.reason, args: summarizeArgs(parsed) });
      return deny(
        policy.phase === "plan"
          ? `${cls.reason}. This is the PLAN phase: planning is read-only; put this step in the plan instead.`
          : `${cls.reason}. Local writes are not allowed in this mode (${policy.mode}); list it as a proposed action instead.`,
        { category: cls.category },
      );
    case "needs-dry-run":
      return executeWithClassification(parsed, policy);
    case "flow-run":
      await report({ kind: "one_call", category: cls.category, decision: "blocked", ok: false, reason: cls.reason, args: summarizeArgs(parsed) });
      return deny(
        policy.phase === "execute"
          ? "flow executions run only as approved actions: use `jos-approved list` and `jos-approved run <n>`."
          : policy.phase === "plan"
            ? "flow executions are side effects and planning is read-only: validate or dry-run the flow (`flow execute <key> --dry-run`) and put the run in the plan."
            : "flow executions are side effects. Validate and dry-run the flow (`flow execute <key> --dry-run`), then list it in proposed_actions for operator approval.",
        { category: cls.category, phase: policy.phase },
      );
    case "forbidden":
      await report({ kind: "one_call", category: cls.category, decision: "blocked", ok: false, reason: cls.reason, args: summarizeArgs(parsed) });
      return deny(`${cls.reason}. HQ executors never do this; ask the operator.`, { category: cls.category });
    default:
      await report({ kind: "one_call", category: "unknown", decision: "blocked", ok: false, reason: cls.reason, args: summarizeArgs(parsed) });
      return deny(`${cls.reason}; the gateway blocks commands it cannot classify (fail closed).`, { category: "unknown" });
  }
}

function previewExtra(parsed, cls) {
  if (cls.category !== "preview" || !parsed.execute) return {};
  const seg = parsed.execute.segments[0];
  const data = tryParseJson(seg.data);
  const pv = tryParseJson(seg.pathVars);
  const qp = tryParseJson(seg.queryParams);
  if (!data.ok || !pv.ok || !qp.ok) return {};
  return {
    payloadHash: actionPayloadHash({
      kind: "one_action",
      platform: seg.platform,
      actionId: seg.actionId,
      connectionKey: seg.connectionKey,
      data: data.value,
      pathVars: pv.value,
      queryParams: qp.value,
    }),
  };
}

async function executeWithClassification(parsed, policy) {
  const segs = parsed.execute.segments;
  for (const seg of segs) {
    if (seg.connectionKey && Array.isArray(policy.allowedConnectionKeys) && !policy.allowedConnectionKeys.includes(seg.connectionKey)) {
      await report({ kind: "one_call", category: "needs-dry-run", decision: "blocked", ok: false, reason: "connection not in this workspace", args: summarizeArgs(parsed) });
      return deny(`connection ${seg.connectionKey} is not one of the connections this execution may use.`, {
        category: "boundary",
      });
    }
  }
  // Resolve the exact request each segment would send, without sending it.
  const verdicts = [];
  for (const seg of segs) {
    const dryArgs = ["--agent", "actions", "execute", ...rebuildSegment(seg), "--dry-run"];
    const dry = await runRealOne(dryArgs, { cwd: process.cwd(), timeoutMs: 60000 });
    const json = extractJson(dry.stdout);
    if (!json || typeof json !== "object" || json.error || !json.request) {
      // The CLI rejected the request (validation). Return exactly what the CLI said.
      if (dry.stdout) out(dry.stdout.trimEnd());
      const e = stripKnownNoise(dry.stderr);
      if (e) process.stderr.write(e + "\n");
      await report({ kind: "one_call", category: "needs-dry-run", decision: "rejected-by-cli", ok: false, error: json?.error ? String(json.error).slice(0, 300) : "no request resolved", args: summarizeArgs(parsed) });
      return 1;
    }
    const verdict = classifyRequest(seg.platform, json.request.method, json.request.url);
    verdicts.push({ seg, method: json.request.method, path: requestPath(json.request.url), verdict });
  }
  const writes = verdicts.filter((v) => v.verdict.category === "write");
  if (writes.length === 0) {
    const v0 = verdicts[0];
    return passthrough(parsed, "read", { method: v0.method, path: v0.path, paid: verdicts.some((v) => v.verdict.paid) });
  }
  const w = writes[0];
  await report({
    kind: "one_call",
    category: "write",
    decision: "blocked",
    ok: false,
    reason: w.verdict.reason,
    method: w.method,
    path: w.path,
    args: summarizeArgs(parsed),
  });
  if (policy.phase === "execute") {
    return deny(
      `this is an external write (${w.method} ${w.path}). In the EXECUTE phase only operator-approved actions run, and only through \`jos-approved run <n>\` (see \`jos-approved list\`). Do not work around this.`,
      { category: "write", phase: "execute", method: w.method, path: w.path },
    );
  }
  if (policy.phase === "plan") {
    return deny(
      `this is an external write (${w.method} ${w.path}) and this is the PLAN phase: planning is read-only. Put this step in the plan (a step with side_effect true, its action, connection and parameters); the executor proposes it for approval later.`,
      { category: "write", phase: "plan", method: w.method, path: w.path },
    );
  }
  return deny(
    `this is an external write (${w.method} ${w.path}) and this is the PREVIEW phase: nothing outward-facing runs yet. Re-run the same command with --dry-run, and list the action (with its exact payload) in proposed_actions so the operator can approve it.`,
    { category: "write", phase: "preview", method: w.method, path: w.path },
  );
}

function rebuildSegment(seg) {
  const args = [];
  if (seg.platform) args.push(seg.platform);
  if (seg.actionId) args.push(seg.actionId);
  if (seg.connectionKey) args.push(seg.connectionKey);
  args.push(...seg.extraPositionals);
  for (const [flag, values] of Object.entries(seg.flags)) {
    if (flag === "--dry-run" || flag === "--mock" || flag === "--parallel") continue;
    for (const v of values) {
      if (v === true) args.push(flag);
      else args.push(flag, v);
    }
  }
  return args;
}

// Exit by setting exitCode, never process.exit(): see lib/hq-client.mjs on the Windows libuv assertion.
main().then(
  (code) => {
    process.exitCode = code ?? 0;
  },
  (e) => {
    // Fail closed on any internal error.
    out(JSON.stringify({ error: `J/OS HQ gateway internal error: ${e instanceof Error ? e.message : String(e)}`, josHq: { blocked: true } }));
    process.exitCode = 1;
  },
);
