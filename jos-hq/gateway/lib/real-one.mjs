// Run the real One CLI (`node <@withone/cli>/bin/cli.js ...`) without a shell. Arguments are argv
// elements, never a command string, so a JSON payload can contain any character safely.
//
// Output is captured through inherited FILE handles, not pipes. Inside Codex's restricted-token
// Windows sandbox a process cannot create the named pipes Node uses for child stdio (spawn fails
// with EPERM), while inherited file handles work.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function realOneCli() {
  const cli = process.env.JOS_HQ_REAL_ONE_CLI;
  if (!cli) throw new Error("JOS_HQ_REAL_ONE_CLI is not set; the gateway only runs under an HQ dispatch.");
  return cli;
}

let tmpDirCache = null;
function captureDir() {
  if (tmpDirCache) return tmpDirCache;
  for (const d of [path.join(os.tmpdir(), "jos-hq-gateway"), path.join(os.homedir(), ".one", ".jos-hq-tmp")]) {
    try {
      fs.mkdirSync(d, { recursive: true });
      const probe = path.join(d, `probe-${process.pid}`);
      fs.writeFileSync(probe, "");
      fs.unlinkSync(probe);
      tmpDirCache = d;
      return d;
    } catch {
      /* try the next location */
    }
  }
  throw new Error("no writable location for capturing One CLI output");
}

/**
 * @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{code: number | null, stdout: string, stderr: string, timedOut: boolean, durationMs: number, error?: string}>}
 */
export function runRealOne(args, opts = {}) {
  const node = process.env.JOS_HQ_NODE || process.execPath;
  const t0 = Date.now();
  return new Promise((resolve) => {
    let dir;
    try {
      dir = captureDir();
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, durationMs: 0, error: String(e) });
      return;
    }
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outPath = path.join(dir, `one-${id}.out`);
    const errPath = path.join(dir, `one-${id}.err`);
    const outFd = fs.openSync(outPath, "w");
    const errFd = fs.openSync(errPath, "w");
    const collect = () => {
      const read = (p) => {
        try {
          return fs.readFileSync(p, "utf8");
        } catch {
          return "";
        }
      };
      const stdout = read(outPath);
      const stderr = read(errPath);
      for (const p of [outPath, errPath]) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
      return { stdout, stderr };
    };
    const closeFds = () => {
      for (const fd of [outFd, errFd]) {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed */
        }
      }
    };
    let child;
    try {
      child = spawn(node, [realOneCli(), ...args], {
        cwd: opts.cwd ?? process.cwd(),
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", outFd, errFd],
      });
    } catch (e) {
      closeFds();
      const c = collect();
      resolve({ code: null, ...c, timedOut: false, durationMs: 0, error: String(e) });
      return;
    }
    let timedOut = false;
    let settled = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        }, opts.timeoutMs)
      : null;
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      closeFds();
      resolve({ code: null, ...collect(), timedOut, durationMs: Date.now() - t0, error: String(e) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      closeFds();
      resolve({ code, ...collect(), timedOut, durationMs: Date.now() - t0 });
    });
  });
}

/** The CLI prints one JSON document in --agent mode; tolerate leading warnings and trailing noise. */
export function extractJson(text) {
  const s = String(text ?? "").trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  for (const line of s.split(/\r?\n/)) {
    const l = line.trim();
    if (!(l.startsWith("{") || l.startsWith("["))) continue;
    try {
      return JSON.parse(l);
    } catch {
      /* next */
    }
  }
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch {
      /* give up */
    }
  }
  return undefined;
}

/** stderr noise the One CLI 1.57.x prints on exit under Windows; not an error signal. */
export function stripKnownNoise(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .filter((l) => !/Assertion failed: !\(handle->flags & UV_HANDLE_CLOSING\)/.test(l))
    .join("\n")
    .trim();
}
