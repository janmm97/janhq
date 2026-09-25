#!/usr/bin/env node
// J/OS HQ PreToolUse guard for Claude Code executor sessions.
//
// Claude Code runs this before every tool call and passes the call as JSON on stdin (including
// `effort.level`, which Claude Code reports nowhere else). The guard:
//   - reports the observed effort and permission mode to HQ, which uses it to verify the launch;
//   - denies every tool call if effort is not the required level;
//   - denies recursive delegation (codex / claude / jos dispatch), direct web access, MCP tools,
//     calls that bypass the HQ One gateway, and file writes outside the workspace.
// Any internal error denies the call (fail closed).
import path from "node:path";
import { isWithin } from "./lib/paths.mjs";
import { hqPost } from "./lib/hq-client.mjs";
import { loadPolicy } from "./lib/policy.mjs";

// Claude Code reads a hook's JSON only when the hook exits 0, so every path must exit 0 cleanly:
// set exitCode and let the process end (process.exit() can trip a Windows libuv assertion).
function decide(decision, reason) {
  if (decision === "deny") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `J/OS HQ: ${reason}`,
        },
      }),
    );
  }
  process.exitCode = 0;
}

// `codex` / `claude` in command position: start, or after ; & | ( or a newline, optionally as a
// quoted path. A mere mention (grep claude notes.md) is not a launch.
const DELEGATION = /(^|[;&|(\n]\s*)(["']?[^\s"';&|]*[\\/])?(codex|claude)(\.exe|\.cmd|\.js)?["']?(\s|$)/i;
const JOS_DISPATCH = /\bjos(\.mjs|\.cmd)?\b[^\n]*\bdispatch\b/i;
const ONE_BYPASS = /@withone[\\/]+cli|AppData[\\/]+Roaming[\\/]+npm[\\/]+one(\.cmd|\.ps1)?\b|npm[\\/]+one(\.cmd)?\b|[\\/]bin[\\/]cli\.js/i;

async function readStdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

async function main() {
  const loaded = loadPolicy();
  if (!loaded.ok) return decide("deny", loaded.error);
  const policy = loaded.policy;
  const input = JSON.parse(await readStdin());
  const tool = String(input.tool_name ?? "");
  const ti = input.tool_input ?? {};
  const effort = input.effort?.level ?? null;

  const obs = await hqPost(
    "/api/internal/claude-guard/observe",
    {
      executionId: policy.executionId,
      effort,
      permissionMode: input.permission_mode ?? null,
      cwd: input.cwd ?? null,
      sessionId: input.session_id ?? null,
      tool,
      summary: tool === "Bash" || tool === "PowerShell" ? String(ti.command ?? "").slice(0, 300) : ti.file_path ?? ti.pattern ?? ti.description ?? null,
    },
    8000,
  );
  if (!obs.ok) return decide("deny", `HQ did not acknowledge this tool call (${obs.status || obs.error || "no response"}); refusing to run unobserved.`);
  if (obs.json?.deny) return decide("deny", obs.json.deny);

  if (effort !== policy.requiredEffort) {
    return decide("deny", `reasoning effort is "${effort}" but this executor must run at "${policy.requiredEffort}". Execution is blocked.`);
  }

  if (tool === "WebFetch" || tool === "WebSearch") {
    return decide("deny", "direct web access is not allowed; J/OS uses the One CLI for every external service.");
  }
  if (tool.startsWith("mcp__")) {
    return decide("deny", "MCP tools are not allowed in executor sessions; use the One CLI.");
  }

  if (tool === "Bash" || tool === "PowerShell") {
    const cmd = String(ti.command ?? "");
    if (DELEGATION.test(cmd)) return decide("deny", "executors execute; they do not start other agent sessions (no codex/claude).");
    if (JOS_DISPATCH.test(cmd)) return decide("deny", "executors may not dispatch other executors.");
    if (ONE_BYPASS.test(cmd)) return decide("deny", "call `one` by name so the HQ gateway applies; do not invoke the One CLI by path.");
    return decide("allow");
  }

  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const target = ti.file_path ?? ti.notebook_path;
    if (!target) return decide("deny", "file write without a path");
    const abs = path.resolve(policy.workspaceRoot, String(target));
    if (!isWithin(abs, policy.workspaceRoot)) {
      return decide("deny", `writes are confined to the ${policy.workspace} workspace (${policy.workspaceRoot}).`);
    }
    const rel = path.relative(policy.workspaceRoot, abs).replace(/\\/g, "/").toLowerCase();
    if (rel === "claude.md" || rel === "agents.md") {
      return decide("deny", "executors do not edit their own instruction files.");
    }
    if (rel.startsWith(".one/") && !rel.startsWith(".one/flows/")) {
      return decide("deny", "the .one directory holds this workspace's One config; only .one/flows/ may be written.");
    }
    if (!policy.allowLocalWrites) {
      return decide("deny", `local file writes are not allowed in ${policy.mode} mode during this phase; propose the change instead.`);
    }
    return decide("allow");
  }

  return decide("allow");
}

main().catch((e) => decide("deny", `guard error (${e instanceof Error ? e.message : String(e)}); failing closed.`));
