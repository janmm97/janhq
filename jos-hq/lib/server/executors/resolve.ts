// Resolution of the executor runtime binaries. Nothing is silently substituted: every candidate is
// listed with the reason it was or was not chosen, and Runtime Health shows the result.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../env";
import { runCapture, which } from "../proc";
import type { BinaryCandidate, RuntimeResolution } from "./types";

/** Semver comparison including prerelease identifiers (0.155.0-alpha.16 > 0.155.0-alpha.2.6). */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  if (!pa.pre.length && !pb.pre.length) return 0;
  if (!pa.pre.length) return 1;
  if (!pb.pre.length) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function versionOf(binary: string, pattern: RegExp): Promise<string | null> {
  const r = await runCapture(binary, ["--version"], { timeoutMs: 20000 });
  const m = `${r.stdout}\n${r.stderr}`.match(pattern);
  return m ? m[1] : null;
}

const cache = globalThis as unknown as { __josRuntime?: Map<string, { at: number; value: RuntimeResolution }> };
const TTL = 5 * 60_000;

function cached(key: string, force: boolean) {
  cache.__josRuntime ??= new Map();
  const hit = cache.__josRuntime.get(key);
  return !force && hit && Date.now() - hit.at < TTL ? hit.value : null;
}
function store(key: string, value: RuntimeResolution) {
  cache.__josRuntime ??= new Map();
  cache.__josRuntime.set(key, { at: Date.now(), value });
  return value;
}

export async function resolveClaude(force = false): Promise<RuntimeResolution> {
  const hit = cached("claude", force);
  if (hit) return hit;
  const cfg = loadConfig().workspaces.One.executor;
  const explicit = process.env.JOS_HQ_CLAUDE_BIN || (cfg.claudeBin && cfg.claudeBin !== "auto" ? cfg.claudeBin : null);
  const found = explicit ?? which(process.platform === "win32" ? "claude.exe" : "claude") ?? which("claude");
  const candidates: BinaryCandidate[] = [];
  if (!found || !fs.existsSync(found)) {
    // A pinned binary is exclusive: when it is missing, HQ does not go looking for another one.
    const error = explicit
      ? `Claude Code unavailable: the pinned binary ${explicit} (${process.env.JOS_HQ_CLAUDE_BIN ? "JOS_HQ_CLAUDE_BIN" : "claudeBin in jos-hq.config.json"}) does not exist`
      : "Claude Code unavailable: `claude` was not found on PATH";
    return store("claude", { ok: false, adapter: "claude-code", binary: explicit, version: null, source: explicit ? "explicit" : null, candidates, error });
  }
  if (/\.(cmd|bat|ps1)$/i.test(found)) {
    return store("claude", { ok: false, adapter: "claude-code", binary: found, version: null, source: "PATH", candidates, error: `Claude Code resolves to a script shim (${found}); HQ spawns executors without a shell and needs the native claude.exe` });
  }
  const version = await versionOf(found, /(\d+\.\d+\.\d+[^\s]*)\s*\(Claude Code\)/);
  candidates.push({ binary: found, version, source: explicit ? "explicit" : "PATH", eligible: !!version, reason: version ? "native Claude Code binary" : "`--version` did not identify Claude Code" });
  return store(
    "claude",
    version
      ? { ok: true, adapter: "claude-code", binary: found, version, source: explicit ? "explicit" : "PATH", candidates }
      : { ok: false, adapter: "claude-code", binary: found, version: null, source: null, candidates, error: "Claude Code unavailable: the binary on PATH did not report a Claude Code version" },
  );
}

function listDirs(p: string): string[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name));
  } catch {
    return [];
  }
}

export async function resolveCodex(force = false): Promise<RuntimeResolution> {
  const hit = cached("codex", force);
  if (hit) return hit;
  const cfg = loadConfig().workspaces["Studio"].executor;
  const minVersion = cfg.minCodexVersion ?? "0.0.0";
  const sources: Array<{ source: string; binaries: string[] }> = [];

  const explicit = process.env.JOS_HQ_CODEX_BIN || (cfg.codexBin && cfg.codexBin !== "auto" ? cfg.codexBin : null);
  // A pinned binary is exclusive: if it is missing or too old, the Studio model is unavailable. HQ does
  // not quietly pick another installed Codex build instead.
  if (explicit) sources.push({ source: "explicit", binaries: fs.existsSync(explicit) ? [explicit] : [] });

  const npmShim = explicit ? null : which(process.platform === "win32" ? "codex.cmd" : "codex");
  if (npmShim) {
    const pkg = path.join(path.dirname(npmShim), "node_modules", "@openai", "codex");
    const native = [
      path.join(pkg, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
      path.join(pkg, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
    ].filter((p) => fs.existsSync(/*turbopackIgnore: true*/ p));
    sources.push({ source: "npm global (@openai/codex)", binaries: native });
  }

  if (!explicit) {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    sources.push({
      source: "Codex desktop app",
      binaries: listDirs(path.join(local, "OpenAI", "Codex", "bin"))
        .map((d) => path.join(d, "codex.exe"))
        .filter((p) => fs.existsSync(p)),
    });

    sources.push({
      source: "VS Code extension (openai.chatgpt)",
      binaries: listDirs(path.join(os.homedir(), ".vscode", "extensions"))
        .filter((d) => /[\\/]openai\.chatgpt-/.test(d))
        .map((d) => path.join(d, "bin", "windows-x86_64", "codex.exe"))
        .filter((p) => fs.existsSync(p)),
    });
  }

  const candidates: BinaryCandidate[] = [];
  let chosen: BinaryCandidate | null = null;
  for (const s of sources) {
    const evaluated: BinaryCandidate[] = [];
    for (const b of s.binaries) {
      const version = await versionOf(b, /codex-cli\s+(\S+)/);
      const eligible = !!version && compareSemver(version, minVersion) >= 0;
      evaluated.push({
        binary: b,
        version,
        source: s.source,
        eligible,
        reason: !version ? "`--version` failed" : eligible ? `>= ${minVersion}` : `older than ${minVersion}; the server rejects ${cfg.model} for older Codex clients`,
      });
    }
    evaluated.sort((x, y) => compareSemver(y.version ?? "0.0.0", x.version ?? "0.0.0"));
    candidates.push(...evaluated);
    if (!chosen) chosen = evaluated.find((c) => c.eligible) ?? null;
  }

  if (!chosen) {
    return store("codex", {
      ok: false,
      adapter: "codex",
      binary: null,
      version: null,
      source: null,
      candidates,
      error: explicit
        ? `${cfg.modelLabel} unavailable: the pinned Codex binary ${explicit} (${process.env.JOS_HQ_CODEX_BIN ? "JOS_HQ_CODEX_BIN" : "codexBin in jos-hq.config.json"}) ${fs.existsSync(explicit) ? `is not Codex >= ${minVersion}` : "does not exist"}`
        : `${cfg.modelLabel} unavailable: no installed Codex CLI is >= ${minVersion} (the minimum proven to run ${cfg.model} on this machine)`,
    });
  }
  return store("codex", { ok: true, adapter: "codex", binary: chosen.binary, version: chosen.version, source: chosen.source, candidates });
}
