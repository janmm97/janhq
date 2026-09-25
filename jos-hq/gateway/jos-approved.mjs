#!/usr/bin/env node
// J/OS HQ approved-action runner.
//
//   jos-approved list        show the actions the operator approved for this execution
//   jos-approved run <n>     execute approved action <n> exactly as approved, once
//
// The payload comes from the HQ policy file, never from the command line, so what runs is byte-for-byte
// what the operator approved. Before running, the One identity is re-checked from this working
// directory; HQ atomically claims the approval so it can never run twice; an ambiguous outcome is
// recorded as ambiguous and is never retried automatically.
import { loadPolicy } from "./lib/policy.mjs";
import { runRealOne, extractJson, stripKnownNoise } from "./lib/real-one.mjs";
import { configOwnershipProblems, isWithin, samePath } from "./lib/paths.mjs";
import { hqPost } from "./lib/hq-client.mjs";
import { emptyToNull } from "./lib/canonical.mjs";
import { actionOutcome, approvedActionTimeoutMs } from "./lib/action-outcome.mjs";

function out(text) {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

function fail(message, code = 1) {
  out(JSON.stringify({ error: `jos-approved: ${message}` }));
  return code;
}

function collectIds(value, acc = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return acc;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && /^(id|messageId|threadId|eventId|fileId|pageId|runId|ts|chargeId|paymentIntentId)$/i.test(k) && v.length < 200) {
      acc.add(`${k}=${v}`);
    } else if (v && typeof v === "object") collectIds(v, acc, depth + 1);
  }
  return acc;
}

async function main() {
  const loaded = loadPolicy();
  if (!loaded.ok) return fail(loaded.error);
  const policy = loaded.policy;
  const [cmd, nRaw] = process.argv.slice(2);

  if (cmd === "list" || cmd === undefined) {
    const rows = (policy.approvedActions ?? []).map((a) => ({
      index: a.index,
      title: a.title,
      platform: a.platform,
      connection: a.connectionName ?? a.connectionKey,
      kind: a.kind,
      target: a.target ?? null,
    }));
    out(JSON.stringify({ phase: policy.phase, approvedActions: rows }, null, 2));
    return 0;
  }
  if (cmd !== "run") return fail("usage: jos-approved list | jos-approved run <n>");
  if (policy.phase !== "execute") return fail("no actions are approved in the PREVIEW phase.");

  const cwd = process.cwd();
  if (!isWithin(cwd, policy.workspaceRoot)) {
    return fail(`must run from the ${policy.workspace} workspace (${policy.workspaceRoot}), not ${cwd}.`);
  }
  const n = Number(nRaw);
  const action = (policy.approvedActions ?? []).find((a) => a.index === n);
  if (!action) return fail(`there is no approved action #${nRaw}. Run \`jos-approved list\`.`);

  // Identity at the moment of the side effect: projectRoot AND email, never the org alone, from this
  // directory's own project config (the same checks HQ ran at dispatch).
  const cp = extractJson((await runRealOne(["--agent", "config", "path"], { cwd, timeoutMs: 30000 })).stdout);
  const who = extractJson((await runRealOne(["--agent", "whoami"], { cwd, timeoutMs: 30000 })).stdout);
  const email = who?.user?.email ?? null;
  const root = cp?.projectRoot ?? null;
  const problems = [];
  if (!root || !samePath(root, policy.expectedProjectRoot)) problems.push(`projectRoot=${root}, expected ${policy.expectedProjectRoot}`);
  if (!email || email.toLowerCase() !== String(policy.expectedEmail).toLowerCase()) problems.push(`email=${email}, expected ${policy.expectedEmail}`);
  problems.push(...configOwnershipProblems(cp, policy.expectedProjectRoot));
  if (problems.length) {
    await hqPost("/api/internal/gateway/consume-result", {
      approvalId: action.approvalId,
      index: action.index,
      outcome: "blocked",
      summary: `identity mismatch at execution time: ${problems.join("; ")}`,
    });
    return fail(`identity mismatch — ${problems.join("; ")}. Nothing was executed.`);
  }

  // Atomically claim the approval. A second claim, or a claim after an ambiguous run, is refused.
  const timeoutMs = approvedActionTimeoutMs(action.kind, policy.executionDeadlineMs);
  if (timeoutMs <= 0) return fail("execution deadline is too close; no action was claimed or run.");
  const claim = await hqPost("/api/internal/gateway/consume", {
    approvalId: action.approvalId,
    index: action.index,
    payloadHash: action.payloadHash,
  });
  if (!claim.ok) {
    const why = claim.json?.error ?? claim.error ?? `HTTP ${claim.status}`;
    return fail(`HQ did not release approved action #${n}: ${why}. Do not retry; verify whether it already happened.`);
  }

  let args;
  if (action.kind === "one_flow") {
    args = ["--agent", "flow", "execute", action.flowKey];
    for (const [k, v] of Object.entries(action.flowInputs ?? {})) {
      args.push("-i", `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    }
  } else {
    args = ["--agent", "actions", "execute", action.platform, action.actionId, action.connectionKey];
    if (action.data !== null && action.data !== undefined) args.push("-d", JSON.stringify(action.data));
    const pathVars = emptyToNull(action.pathVars);
    const queryParams = emptyToNull(action.queryParams);
    if (pathVars) args.push("--path-vars", JSON.stringify(pathVars));
    if (queryParams) args.push("--query-params", JSON.stringify(queryParams));
  }

  const r = await runRealOne(args, { cwd, timeoutMs });
  const { json, outcome, summary } = actionOutcome(r, action.kind);

  const ids = json ? [...collectIds(json)].slice(0, 20) : [];
  await hqPost("/api/internal/gateway/consume-result", {
    approvalId: action.approvalId,
    index: action.index,
    outcome,
    exitCode: r.code,
    durationMs: r.durationMs,
    responseIds: ids,
    summary: `${summary}${ids.length ? `: ${ids.join(", ")}` : ""}`.slice(0, 500),
  });

  if (r.stdout) out(r.stdout.trimEnd());
  const e = stripKnownNoise(r.stderr);
  if (e) process.stderr.write(e + "\n");
  if (outcome === "ambiguous") {
    process.stderr.write(
      "jos-approved: the outcome is AMBIGUOUS. Do not run this action again. Verify with a read whether it took effect, and report what you find.\n",
    );
  }
  return outcome === "succeeded" ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    out(JSON.stringify({ error: `jos-approved internal error: ${e instanceof Error ? e.message : String(e)}` }));
    process.exitCode = 1;
  },
);
