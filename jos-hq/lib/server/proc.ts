import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WIN = process.platform === "win32";

/** Resolve an executable on PATH (PATHEXT-aware on Windows). */
export function which(name: string, envPath = process.env.PATH ?? ""): string | null {
  const exts = WIN ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase()) : [""];
  const hasExt = WIN && exts.some((e) => e && name.toLowerCase().endsWith(e));
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidates = hasExt || !WIN ? [path.join(dir, name)] : exts.map((e) => path.join(dir, name + e));
    for (const c of candidates) {
      try {
        if (fs.statSync(c).isFile()) return c;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

/** Spawn without a shell and capture output. */
export function runCapture(
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {},
): Promise<CaptureResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, durationMs: 0, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (child.pid) void killTree(child.pid);
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, durationMs: Date.now() - t0, error: e.message });
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - t0 });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/**
 * Terminate a process and all of its descendants. On Windows there are no POSIX signals: Node's
 * child.kill() is always a forced TerminateProcess and does not reach grandchildren, so the tree
 * is killed with `taskkill /T /F`.
 */
export async function killTree(pid: number): Promise<{ ok: boolean; detail: string }> {
  if (!pid) return { ok: false, detail: "no pid" };
  if (WIN) {
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    const r = await runCapture(taskkill, ["/PID", String(pid), "/T", "/F"], { timeoutMs: 20000 });
    const text = `${r.stdout}${r.stderr}`.trim();
    // Exit code 128 = process not found (already gone).
    return { ok: r.code === 0 || r.code === 128, detail: text || `taskkill exit ${r.code}` };
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return { ok: true, detail: "already exited" };
    }
  }
  return { ok: true, detail: "SIGTERM sent to process group" };
}

export function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Image name of a running process (Windows), used to avoid mistaking a reused PID for an executor. */
export async function processImageName(pid: number): Promise<string | null> {
  if (!WIN) return null;
  const tasklist = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe");
  const r = await runCapture(tasklist, ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeoutMs: 10000 });
  const m = r.stdout.match(/^"([^"]+)"/m);
  return m ? m[1] : null;
}

const KEEP = new Set(["CLAUDE_CODE_GIT_BASH_PATH", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]);

/**
 * The environment for an executor process: the operator's environment minus session state that
 * would leak between agent sessions (e.g. CLAUDE_EFFORT, CLAUDECODE, a parent session's messaging
 * socket, IDE IPC handles, npm/Next.js process variables), plus the explicit additions.
 */
export function executorEnv(extra: Record<string, string>, prependPath?: string): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (KEEP.has(k)) {
      env[k] = v;
      continue;
    }
    if (/^CLAUDE/i.test(k) || /^CODEX_/i.test(k) || /^VSCODE_/i.test(k) || /^JOS_HQ_/i.test(k)) continue;
    if (/^npm_/i.test(k) || /^__NEXT/i.test(k) || /^NEXT_/i.test(k) || /^TURBOPACK/i.test(k) || k === "NODE_ENV" || k === "NODE_OPTIONS") continue;
    env[k] = v;
  }
  if (prependPath) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[key] = `${prependPath}${path.delimiter}${env[key] ?? ""}`;
  }
  // NODE_ENV is deliberately absent (Next.js types declare it required on ProcessEnv).
  return { ...env, ...extra } as unknown as NodeJS.ProcessEnv;
}
