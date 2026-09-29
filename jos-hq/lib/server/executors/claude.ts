// ClaudeOneExecutorAdapter: the One executor runs as Claude Code Opus 5 at medium effort, as a
// separate process rooted in JOS/One. Verified on this machine (2026-09-23): `--model claude-opus-5`
// is reported back in the init event and in every assistant message; `--effort` is not reported in
// any output event, but Claude Code passes `effort.level` to PreToolUse hooks, so the HQ guard hook
// captures it before the first tool runs. An unknown `--effort` value is NOT rejected by Claude Code
// (it warns and runs at the default), so that warning is treated as a launch failure.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { gatewayDir, loadConfig, phaseRole, rolePolicy, serverUrl, workspaceRoot } from "../env";
import { executorEnv, killTree } from "../proc";
import { redactSecrets } from "../util/redact";
import { resolveClaude } from "./resolve";
import { RESULT_SCHEMA, coerceResult } from "./result-schema";
import { PLAN_RESULT_SCHEMA, coercePlan, type PlannerResult } from "./plan-schema";
import type { ExecutorAdapter, ExecutorResult, ExitInfo, LaunchHandle, LaunchHooks, LaunchSpec, TaskMode, Phase } from "./types";

const EFFORT_WARNING = /Unknown --effort value/i;

export function claudePermissions(mode: TaskMode, phase: Phase) {
  // Planning is read-only whatever the mode: One commands and file reads, nothing that writes or delegates.
  if (phase === "plan") return { permissionMode: "dontAsk", allowedTools: ["Read", "Glob", "Grep", "TodoWrite", "Bash(one *)", "Bash(one)", "PowerShell(one *)"], allowLocalWrites: false };
  const base = [
    "Read",
    "Glob",
    "Grep",
    "TodoWrite",
    "Task",
    "Bash(one *)",
    "Bash(one)",
    "Bash(jos-approved *)",
    "PowerShell(one *)",
    "PowerShell(jos-approved *)",
  ];
  const edits = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
  const localTools = ["Bash(mkdir *)", "Bash(ls *)", "Bash(cp *)", "Bash(node *)", "Bash(python *)"];
  // Manual: reads only until the operator approves; local edits wait for approval like any mutation.
  if (mode === "manual" && phase === "preview") return { permissionMode: "dontAsk", allowedTools: base, allowLocalWrites: false };
  if (mode === "auto") return { permissionMode: "acceptEdits", allowedTools: [...base, ...edits, ...localTools], allowLocalWrites: true };
  return { permissionMode: "acceptEdits", allowedTools: [...base, ...edits], allowLocalWrites: true };
}

export class ClaudeOneExecutorAdapter implements ExecutorAdapter {
  readonly id = "claude-code" as const;
  readonly workspace = "One" as const;

  get policy() {
    return loadConfig().workspaces.One.executor;
  }

  policyFor(phase: Phase) {
    return rolePolicy("One", phaseRole(phase));
  }

  checkAvailability(force = false) {
    return resolveClaude(force);
  }

  verifyWorkspace() {
    const root = workspaceRoot("One");
    for (const f of ["CLAUDE.md", "AGENTS.md", ".one"]) {
      if (!fs.existsSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ root, f))) return { ok: false, root, problem: `${f} missing in ${root}` };
    }
    return { ok: true, root };
  }

  async launch(spec: LaunchSpec, hooks: LaunchHooks): Promise<LaunchHandle> {
    const rt = await resolveClaude();
    if (!rt.ok || !rt.binary) throw new Error(rt.error ?? "Claude Code unavailable");
    const policy = this.policyFor(spec.phase);
    const schema = spec.phase === "plan" ? PLAN_RESULT_SCHEMA : RESULT_SCHEMA;
    const perms = claudePermissions(spec.mode, spec.phase);
    const guard = path.join(gatewayDir(), "claude-guard.mjs").replace(/\\/g, "/");
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node "${guard}"`, timeout: 60 }] }],
      },
      autoMemoryEnabled: false,
    };
    const sessionId = randomUUID();
    const args = [
      "-p",
      "--model",
      policy.model,
      "--effort",
      policy.effort,
      "--output-format",
      "stream-json",
      "--verbose",
      "--forward-subagent-text",
      "--session-id",
      sessionId,
      "--permission-mode",
      perms.permissionMode,
      "--permission-prompts",
      "none",
      "--allowedTools",
      ...perms.allowedTools,
      "--disallowedTools",
      "WebFetch",
      "WebSearch",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: {} }),
      "--settings",
      JSON.stringify(settings),
      "--json-schema",
      JSON.stringify(schema),
      ...spec.extraReadDirs.flatMap((d) => ["--add-dir", d]),
    ];
    const env = executorEnv(
      {
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        // No silent model substitution, for the main loop or any sub-agent. These variables are read by
        // Claude Code 2.1.278 (strings in its binary: "CLAUDE_CODE_NO_MODEL_FALLBACK forbids model
        // substitution"); HQ's per-turn model check stays in place as the backstop.
        CLAUDE_CODE_NO_MODEL_FALLBACK: "1",
        CLAUDE_CODE_SUBAGENT_MODEL: policy.model,
        CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
        JOS_HQ_EXECUTION_ID: spec.executionId,
        JOS_HQ_TASK_ID: spec.taskId,
        JOS_HQ_WORKSPACE: spec.workspace,
        JOS_HQ_PHASE: spec.phase,
        JOS_HQ_POLICY_FILE: spec.policyPath,
        JOS_HQ_SERVER: serverUrl(),
        JOS_HQ_GATEWAY_NONCE: spec.gatewayNonce,
        JOS_HQ_REAL_ONE_CLI: spec.realOneCli,
        JOS_HQ_NODE: process.execPath,
      },
      path.join(gatewayDir(), "bin"),
    );
    fs.writeFileSync(path.join(spec.runDir, "launch.json"), JSON.stringify({ binary: rt.binary, version: rt.version, cwd: spec.workspaceRoot, args: args.map((a) => (a.length > 400 ? `${a.slice(0, 120)}…(${a.length} chars)` : a)) }, null, 2));

    const t0 = Date.now();
    const child = spawn(rt.binary, args, { cwd: spec.workspaceRoot, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const out = fs.createWriteStream(path.join(spec.runDir, "stdout.jsonl"));
    let stderr = "";
    let result: Record<string, unknown> | null = null;
    let lastText: string | null = null;
    let effortWarning = false;
    let killed = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) void killTree(child.pid);
    }, spec.timeoutMs);

    const done = new Promise<ExitInfo>((resolve) => {
      let buf = "";
      const dec = new StringDecoder("utf8");
      // The raw stream is kept for audit, redacted like everything else HQ stores.
      const endOut = () => {
        buf += dec.end();
        if (buf.trim()) out.write(redactSecrets(buf.trim()) + "\n");
        buf = "";
        out.end();
      };
      child.stdout.on("data", (d: Buffer) => {
        buf += dec.write(d);
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          out.write(redactSecrets(line) + "\n");
          hooks.onRawLine?.(line);
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line);
          } catch {
            hooks.onEvent({ kind: "info", summary: line.slice(0, 300) });
            continue;
          }
          const handled = handleClaudeEvent(ev, hooks);
          if (handled.result) result = handled.result;
          if (handled.text) lastText = handled.text;
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        const s = d.toString();
        stderr += s;
        if (EFFORT_WARNING.test(s)) {
          effortWarning = true;
          hooks.onEvent({ kind: "error", summary: "Claude Code rejected the effort value and fell back to its default effort", data: { stderr: s.slice(0, 500) } });
          if (child.pid) {
            killed = true;
            void killTree(child.pid);
          }
        }
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        endOut();
        resolve({ code: null, timedOut, killed, structured: null, resultText: null, error: `Executor failed before launch: ${e.message}`, durationMs: Date.now() - t0 });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        endOut();
        fs.writeFileSync(path.join(spec.runDir, "stderr.txt"), redactSecrets(stderr));
        const r = result as Record<string, unknown> | null;
        const raw = r?.structured_output;
        let structured: ExecutorResult | null = null;
        let plan: PlannerResult | null = null;
        let coerceError: string | null = null;
        if (raw !== undefined) {
          if (spec.phase === "plan") {
            const c = coercePlan(raw);
            if (c.ok) plan = c.plan;
            else coerceError = c.error;
          } else {
            const c = coerceResult(raw);
            if (c.ok) structured = c.result;
            else coerceError = c.error;
          }
        }
        let error: string | null = null;
        if (effortWarning) error = `${policy.modelLabel} (${policy.effort}) unavailable: effort value not accepted`;
        else if (timedOut) error = `Executor timed out after ${Math.round(spec.timeoutMs / 1000)} s`;
        else if (!r) error = `Executor exited unexpectedly (code ${code}) before returning a result`;
        else if (r.is_error || r.subtype !== "success") error = `Executor returned an error: ${String(r.result ?? r.terminal_reason ?? r.subtype).slice(0, 500)}`;
        else if (coerceError) error = coerceError;
        resolve({
          code,
          timedOut,
          killed,
          structured,
          plan,
          resultText: typeof r?.result === "string" ? (r.result as string) : lastText,
          error,
          durationMs: Date.now() - t0,
        });
      });
    });

    child.stdin.on("error", () => {
      /* child may exit before reading */
    });
    child.stdin.end(spec.prompt);
    hooks.onSession({ sessionId });
    return { child, pid: child.pid ?? null, binary: rt.binary, version: rt.version, args, done };
  }
}

function summarizeInput(name: string, input: Record<string, unknown>): string {
  if (name === "Bash" || name === "PowerShell") return String(input.command ?? "").slice(0, 300);
  if (input.file_path) return String(input.file_path);
  if (input.pattern) return String(input.pattern);
  if (input.description) return String(input.description).slice(0, 200);
  return JSON.stringify(input).slice(0, 200);
}

export function handleClaudeEvent(ev: Record<string, unknown>, hooks: LaunchHooks): { result?: Record<string, unknown>; text?: string } {
  const type = ev.type;
  if (type === "system" && ev.subtype === "init") {
    hooks.onSession({ sessionId: String(ev.session_id ?? ""), model: String(ev.model ?? ""), cwd: String(ev.cwd ?? ""), permissionMode: String(ev.permissionMode ?? "") });
    hooks.onEvent({
      kind: "started",
      summary: `Claude Code ${String(ev.claude_code_version ?? "")} started · model ${String(ev.model)} · ${String(ev.permissionMode)}`,
      data: { model: ev.model, cwd: ev.cwd, sessionId: ev.session_id, permissionMode: ev.permissionMode, mcpServers: ev.mcp_servers, memoryPaths: ev.memory_paths ?? null, version: ev.claude_code_version },
    });
    return {};
  }
  if (type === "assistant") {
    const msg = (ev.message ?? {}) as { model?: string; content?: Array<Record<string, unknown>> };
    const parent = ev.parent_tool_use_id ? String(ev.parent_tool_use_id) : null;
    let text: string | undefined;
    for (const c of msg.content ?? []) {
      if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
        text = c.text;
        hooks.onEvent({ kind: "text", summary: c.text.slice(0, 500), data: { model: msg.model, subagent: parent } });
      } else if (c.type === "tool_use") {
        const name = String(c.name ?? "tool");
        const input = (c.input ?? {}) as Record<string, unknown>;
        if (name === "Task" || name === "Agent") {
          hooks.onEvent({ kind: "subagent", summary: `Sub-agent: ${String(input.subagent_type ?? "general-purpose")} — ${String(input.description ?? "").slice(0, 160)}`, data: { toolUseId: c.id, subagentType: input.subagent_type ?? null, description: input.description ?? null, model: msg.model } });
        } else {
          hooks.onEvent({ kind: "tool", summary: `${name}: ${summarizeInput(name, input)}`, data: { tool: name, toolUseId: c.id, model: msg.model, subagent: parent } });
        }
      }
    }
    if (msg.model) hooks.onEvent({ kind: "usage", summary: "", data: { assistantModel: msg.model, subagent: parent } });
    return { text };
  }
  if (type === "user") {
    const msg = (ev.message ?? {}) as { content?: Array<Record<string, unknown>> };
    for (const c of msg.content ?? []) {
      if (c.type === "tool_result") {
        const content = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
        hooks.onEvent({ kind: "tool_result", summary: content.slice(0, 400), data: { toolUseId: c.tool_use_id, isError: !!c.is_error } });
      }
    }
    return {};
  }
  if (type === "result") {
    hooks.onEvent({
      kind: "result",
      summary: `Claude Code finished: ${String(ev.subtype)} · ${String(ev.num_turns ?? "?")} turns · ${String(ev.terminal_reason ?? "")}`,
      data: { subtype: ev.subtype, isError: ev.is_error, numTurns: ev.num_turns, costUsd: ev.total_cost_usd, modelUsage: ev.modelUsage, permissionDenials: ev.permission_denials, terminalReason: ev.terminal_reason },
    });
    return { result: ev };
  }
  return {};
}
