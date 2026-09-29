// CodexStudioExecutorAdapter: the Studio executor runs the pinned model and effort from jos-hq.config.json
// (GPT 6 Sol, gpt-6-sol, medium since 2026-09-23; GPT 6 Astra before that) through the Codex CLI, as a
// separate process rooted in JOS/Studio. The GPT 6 models have no CLI of their own on this machine; Codex
// is their only executable harness, and the npm Codex 0.147.0 is rejected by the server for them, so
// the resolver picks an installed Codex build >= the proven minimum.
//
// Sandbox, verified 2026-09-23: Codex's default *elevated* Windows sandbox runs commands as a separate
// identity that cannot even see the One CLI, and the *read-only* sandbox cannot let the One CLI write
// its own config (whoami fails with EPERM). The configuration that keeps file writes confined while
// letting the One CLI work is: workspace-write + unelevated + network access + ~/.one writable.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { gatewayDir, loadConfig, phaseRole, rolePolicy, serverUrl, workspaceRoot } from "../env";
import { executorEnv, killTree } from "../proc";
import { redactSecrets } from "../util/redact";
import { resolveCodex } from "./resolve";
import { RESULT_SCHEMA, coerceResult } from "./result-schema";
import { PLAN_RESULT_SCHEMA, coercePlan, type PlannerResult } from "./plan-schema";
import type { ExecutorAdapter, ExecutorResult, ExitInfo, LaunchHandle, LaunchHooks, LaunchSpec, Phase } from "./types";

export function codexSandboxArgs(): string[] {
  return [
    "-s",
    "workspace-write",
    "-c",
    'windows.sandbox="unelevated"',
    "-c",
    "sandbox_workspace_write.network_access=true",
    "--add-dir",
    path.join(os.homedir(), ".one"),
  ];
}

export class CodexStudioExecutorAdapter implements ExecutorAdapter {
  readonly id = "codex" as const;
  readonly workspace = "Studio" as const;

  get policy() {
    return loadConfig().workspaces["Studio"].executor;
  }

  policyFor(phase: Phase) {
    return rolePolicy("Studio", phaseRole(phase));
  }

  checkAvailability(force = false) {
    return resolveCodex(force);
  }

  verifyWorkspace() {
    const root = workspaceRoot("Studio");
    for (const f of ["CLAUDE.md", "AGENTS.md", ".one"]) {
      if (!fs.existsSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ root, f))) return { ok: false, root, problem: `${f} missing in ${root}` };
    }
    return { ok: true, root };
  }

  async launch(spec: LaunchSpec, hooks: LaunchHooks): Promise<LaunchHandle> {
    const rt = await resolveCodex();
    const policy = this.policyFor(spec.phase);
    if (!rt.ok || !rt.binary) throw new Error(rt.error ?? `${policy.modelLabel} unavailable`);
    const schemaPath = path.join(spec.runDir, "result-schema.json");
    const lastPath = path.join(spec.runDir, "last-message.json");
    fs.writeFileSync(schemaPath, JSON.stringify(spec.phase === "plan" ? PLAN_RESULT_SCHEMA : RESULT_SCHEMA));
    const args = [
      "exec",
      "-C",
      spec.workspaceRoot,
      "-m",
      policy.model,
      "-c",
      `model_reasoning_effort="${policy.effort}"`,
      ...codexSandboxArgs(),
      "--json",
      "--output-schema",
      schemaPath,
      "-o",
      lastPath,
      "-",
    ];
    const npmManaged: Record<string, string> = rt.source?.startsWith("npm")
      ? { CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: path.resolve(rt.binary, "..", "..", "..", "..", "..", "..") }
      : {};
    const env = executorEnv(
      {
        JOS_HQ_EXECUTION_ID: spec.executionId,
        JOS_HQ_TASK_ID: spec.taskId,
        JOS_HQ_WORKSPACE: spec.workspace,
        JOS_HQ_PHASE: spec.phase,
        JOS_HQ_POLICY_FILE: spec.policyPath,
        JOS_HQ_SERVER: serverUrl(),
        JOS_HQ_GATEWAY_NONCE: spec.gatewayNonce,
        JOS_HQ_REAL_ONE_CLI: spec.realOneCli,
        JOS_HQ_NODE: process.execPath,
        ...npmManaged,
      },
      path.join(gatewayDir(), "bin"),
    );
    fs.writeFileSync(path.join(spec.runDir, "launch.json"), JSON.stringify({ binary: rt.binary, version: rt.version, source: rt.source, cwd: spec.workspaceRoot, args }, null, 2));

    const t0 = Date.now();
    const child = spawn(rt.binary, args, { cwd: spec.workspaceRoot, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const out = fs.createWriteStream(path.join(spec.runDir, "stdout.jsonl"));
    let stderr = "";
    let lastAgentMessage: string | null = null;
    let turnFailed: string | null = null;
    let turnCompleted = false;
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
          const h = handleCodexEvent(ev, hooks);
          if (h.agentMessage) lastAgentMessage = h.agentMessage;
          if (h.failed) turnFailed = h.failed;
          if (h.completed) turnCompleted = true;
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        endOut();
        resolve({ code: null, timedOut, killed: false, structured: null, resultText: null, error: `Executor failed before launch: ${e.message}`, durationMs: Date.now() - t0 });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        endOut();
        fs.writeFileSync(path.join(spec.runDir, "stderr.txt"), redactSecrets(stderr));
        let raw: string | null = null;
        try {
          raw = fs.readFileSync(lastPath, "utf8");
          // Codex writes this file itself; keep only the redacted copy on disk.
          fs.writeFileSync(lastPath, redactSecrets(raw));
        } catch {
          raw = lastAgentMessage;
        }
        let structured: ExecutorResult | null = null;
        let plan: PlannerResult | null = null;
        let parseError: string | null = null;
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (spec.phase === "plan") {
              const c = coercePlan(parsed);
              if (c.ok) plan = c.plan;
              else parseError = c.error;
            } else {
              const c = coerceResult(parsed);
              if (c.ok) structured = c.result;
              else parseError = c.error;
            }
          } catch (e) {
            parseError = `final message was not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        let error: string | null = null;
        const versionRejection = /requires a newer version of Codex/i.test(`${turnFailed ?? ""}${stderr}`);
        if (versionRejection) error = `${policy.modelLabel} unavailable: the selected Codex CLI is too old for ${policy.model}`;
        else if (timedOut) error = `Executor timed out after ${Math.round(spec.timeoutMs / 1000)} s`;
        else if (turnFailed) error = `Executor turn failed: ${turnFailed.slice(0, 500)}`;
        else if (!turnCompleted) error = `Executor exited unexpectedly (code ${code}) before completing its turn`;
        else if (!structured && !plan) error = parseError ?? "executor returned no structured result";
        resolve({ code, timedOut, killed: false, structured, plan, resultText: raw, error, durationMs: Date.now() - t0 });
      });
    });

    child.stdin.on("error", () => {
      /* ignore */
    });
    child.stdin.end(spec.prompt);
    return { child, pid: child.pid ?? null, binary: rt.binary, version: rt.version, args, done };
  }
}

export function handleCodexEvent(ev: Record<string, unknown>, hooks: LaunchHooks): { agentMessage?: string; failed?: string; completed?: boolean } {
  const type = String(ev.type ?? "");
  if (type === "thread.started") {
    hooks.onSession({ sessionId: String(ev.thread_id ?? "") });
    hooks.onEvent({ kind: "started", summary: `Codex thread started (${String(ev.thread_id ?? "")})`, data: { threadId: ev.thread_id } });
    return {};
  }
  if (type === "turn.started") {
    hooks.onEvent({ kind: "info", summary: "Turn started" });
    return {};
  }
  if (type === "turn.completed") {
    hooks.onEvent({ kind: "usage", summary: "Turn completed", data: { usage: ev.usage } });
    return { completed: true };
  }
  if (type === "turn.failed") {
    const msg = String((ev.error as { message?: string } | undefined)?.message ?? "turn failed");
    hooks.onEvent({ kind: "error", summary: msg.slice(0, 500) });
    return { failed: msg };
  }
  if (type === "error") {
    hooks.onEvent({ kind: "error", summary: String(ev.message ?? "error").slice(0, 500) });
    return {};
  }
  if (type === "item.started" || type === "item.completed" || type === "item.updated") {
    const item = (ev.item ?? {}) as Record<string, unknown>;
    const itype = String(item.type ?? "");
    const doneItem = type === "item.completed";
    if (itype === "agent_message" && doneItem) {
      const text = String(item.text ?? "");
      hooks.onEvent({ kind: "text", summary: text.slice(0, 500) });
      return { agentMessage: text };
    }
    if (itype === "reasoning" && doneItem) {
      hooks.onEvent({ kind: "info", summary: `Reasoning: ${String(item.text ?? "").slice(0, 300)}` });
      return {};
    }
    if (itype === "command_execution") {
      if (type === "item.started") hooks.onEvent({ kind: "tool", summary: `Command: ${String(item.command ?? "").slice(0, 300)}`, data: { tool: "shell" } });
      else if (doneItem)
        hooks.onEvent({
          kind: "tool_result",
          summary: `exit ${String(item.exit_code)} · ${String(item.aggregated_output ?? "").slice(0, 400)}`,
          data: { exitCode: item.exit_code, status: item.status, isError: item.status === "failed" },
        });
      return {};
    }
    if (itype === "file_change" && doneItem) {
      hooks.onEvent({ kind: "tool", summary: `File change: ${JSON.stringify(item.changes ?? []).slice(0, 300)}`, data: { tool: "file_change" } });
      return {};
    }
    if (itype === "error" && doneItem) {
      hooks.onEvent({ kind: "error", summary: String(item.message ?? "").slice(0, 500) });
      return {};
    }
    if (/collab|agent|spawn/i.test(itype)) {
      hooks.onEvent({ kind: "subagent", summary: `Sub-agent activity (${itype})`, data: { item } });
      return {};
    }
    if (doneItem) hooks.onEvent({ kind: "info", summary: `${itype}`, data: { item } });
  }
  return {};
}
