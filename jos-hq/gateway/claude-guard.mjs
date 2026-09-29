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
import { isWithin, realpathNearest } from "./lib/paths.mjs";
import { hqPost } from "./lib/hq-client.mjs";
import { loadPolicy } from "./lib/policy.mjs";
import { onlyCommandsAllows } from "./lib/commands.mjs";
// policy.denyWriteGlobs: segment patterns (`tsconfig*.json`) or root patterns (`/.gitignore`); see the module.
import { hasAmbiguousSegment, writeDenied } from "./lib/write-globs.mjs";

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
// `one` / `jos-approved` in command position (start, or after ; & | ( or a newline). Handles quoted
// and unquoted forms: "one", 'one', one, path/one, "path with spaces/one", & "one", etc.
// Used by agents that must never reach a platform themselves (the GitHub Agent: its app makes every call).
const ONE_CMD = /(^|[;&|(\n]\s*)(&\s*)?("(?:[^"])*?(?:one|jos-approved)(?:\.exe|\.cmd|\.ps1|\.mjs)?(?:[^"])*?"|'(?:[^'])*?(?:one|jos-approved)(?:\.exe|\.cmd|\.ps1|\.mjs)?(?:[^'])*?'|(?:[^\s"';&|]*[\\/])?(?:one|jos-approved)(?:\.exe|\.cmd|\.ps1|\.mjs)?)["']?(?=\s|$)/i;

// The leading part of a path with no glob syntax in it: the part that names real directories.
function staticPrefix(abs) {
  const segs = abs.split(/[\\/]/);
  const i = segs.findIndex((s) => /[*?[\]{}]/.test(s));
  if (i < 0) return abs;
  const head = segs.slice(0, i).join(path.sep);
  return !head || /^[A-Za-z]:$/.test(head) ? head + path.sep : head; // `C:` alone means C's current directory
}

/**
 * Whether `abs` (already lexically inside the workspace) stays inside it once links are resolved, and
 * its path relative to the resolved root. Any resolution error answers "outside" (fail closed).
 */
function resolvedInside(abs, root) {
  try {
    const realRoot = realpathNearest(root);
    const prefix = staticPrefix(abs);
    const real = path.join(realpathNearest(prefix), abs.slice(prefix.length));
    if (!isWithin(real, realRoot)) return { inside: false, rel: null };
    return { inside: true, rel: path.relative(realRoot, real).replace(/\\/g, "/").toLowerCase() };
  } catch {
    return { inside: false, rel: null };
  }
}

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
    // onlyCommands first: an agent limited to named commands gets nothing else, whatever follows.
    if (policy.onlyCommands !== undefined && !onlyCommandsAllows(cmd, policy.onlyCommands)) {
      const names = Array.isArray(policy.onlyCommands) ? policy.onlyCommands.join(", ") : "(none)";
      return decide("deny", `this agent may only run: ${names} <verb> [args], with no shell syntax (no ; & | < > $ \` quotes, parentheses or newlines).`);
    }
    if (DELEGATION.test(cmd)) return decide("deny", "executors execute; they do not start other agent sessions (no codex/claude).");
    if (JOS_DISPATCH.test(cmd)) return decide("deny", "executors may not dispatch other executors.");
    if (ONE_BYPASS.test(cmd)) return decide("deny", "call `one` by name so the HQ gateway applies; do not invoke the One CLI by path.");
    if (policy.denyOne && ONE_CMD.test(cmd)) return decide("deny", "this agent has no One access; its app makes every platform call. Return what you need in your result instead.");
    for (const src of Array.isArray(policy.denyCommands) ? policy.denyCommands : []) {
      let re;
      try { re = new RegExp(src, "i"); } catch { return decide("deny", `invalid denyCommands pattern /${src}/; failing closed.`); }
      if (re.test(cmd)) return decide("deny", `this command is not allowed for this agent: /${src}/`);
    }
    return decide("allow");
  }

  // confineReads: file reads stay inside the workspace too. Glob/Grep without a path search the cwd.
  if (policy.confineReads && ["Read", "Glob", "Grep", "NotebookRead"].includes(tool)) {
    const targets = [ti.file_path, ti.path, ti.notebook_path].filter((t) => t !== undefined && t !== null && t !== "");
    // A Glob pattern can reach outside its directory by itself (absolute, or with `..`), so it is resolved too.
    if (tool === "Glob" && typeof ti.pattern === "string" && ti.pattern) targets.push(path.resolve(policy.workspaceRoot, String(ti.path ?? "."), ti.pattern));
    for (const t of targets) {
      const abs = path.resolve(policy.workspaceRoot, String(t));
      // Lexically inside, and still inside once junctions and symlinks are resolved.
      if (!isWithin(abs, policy.workspaceRoot) || !resolvedInside(abs, policy.workspaceRoot).inside) {
        return decide("deny", `reads are confined to the ${policy.workspace} workspace (${policy.workspaceRoot}).`);
      }
    }
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
    // Agent policies (HQ sets neither field): the target must stay inside once links are resolved, and
    // the write-deny patterns apply to the resolved path as well as the spelled one.
    let realRel = null;
    if (policy.denyWriteGlobs !== undefined || policy.onlyCommands !== undefined) {
      // `x::$DATA`, `x.` and `x ` all write `x` on NTFS, and realpath does not normalize a new file's name.
      if (hasAmbiguousSegment(rel)) return decide("deny", "this path uses an NTFS stream or a trailing dot or space; write the file by its plain name.");
      const r = resolvedInside(abs, policy.workspaceRoot);
      if (!r.inside) return decide("deny", `writes are confined to the ${policy.workspace} workspace (${policy.workspaceRoot}); this path resolves outside it.`);
      realRel = r.rel;
    }
    if (rel === "claude.md" || rel === "agents.md") {
      return decide("deny", "executors do not edit their own instruction files.");
    }
    if (Array.isArray(policy.denyWriteGlobs) && (writeDenied(rel, policy.denyWriteGlobs) || (realRel !== null && writeDenied(realRel, policy.denyWriteGlobs)))) {
      return decide("deny", "this file configures how code runs; the GitHub Agent may not change it — say so in your result");
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
