// HQ's access lock. Every page and API route (but /api/internal/*, which executors reach with their
// nonce) needs the key from %LOCALAPPDATA%\JOS\hq\access.key: browsers carry it in the joshq cookie that
// /enter sets from the desktop shortcut, and the jos CLI sends it as x-jos-key. Only Quinn's account can
// read the file, so another local account cannot drive HQ. The Host check stops DNS rebinding.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const HQ_COOKIE = "joshq";
export const KEY_HEADER = "x-jos-key";

export function accessKeyFile(): string {
  if (process.env.JOS_HQ_ACCESS_KEY_FILE) return path.resolve(process.env.JOS_HQ_ACCESS_KEY_FILE);
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "JOS", "hq", "access.key");
}

/** The key, creating the file (32 random bytes, hex, readable by this user only) when missing or empty. */
export function ensureHqKey(): string {
  const f = accessKeyFile();
  const existing = fs.existsSync(/*turbopackIgnore: true*/ f) ? fs.readFileSync(/*turbopackIgnore: true*/ f, "utf8").trim() : "";
  if (existing) return existing;
  fs.mkdirSync(/*turbopackIgnore: true*/ path.dirname(f), { recursive: true });
  const key = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(/*turbopackIgnore: true*/ f, key, { mode: 0o600 });
  if (process.platform === "win32" && process.env.USERNAME) {
    execFileSync("icacls", [f, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], { stdio: "ignore" });
  }
  return key;
}

export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function hostOk(host: string | null, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function checkHqRequest(req: Request, key: string, port: number): { ok: true } | { ok: false; status: 401 | 403; reason: string } {
  if (!hostOk(req.headers.get("host"), port)) return { ok: false, status: 403, reason: "wrong host" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return { ok: false, status: 403, reason: "cross-site request" };
  }
  const given = req.headers.get(KEY_HEADER) ?? cookieValue(req.headers.get("cookie"), HQ_COOKIE);
  if (!given || !sameSecret(given, key)) return { ok: false, status: 401, reason: "Open J/OS HQ from its desktop shortcut." };
  return { ok: true };
}

/** The pages' check, from the values next/headers gives a server component. */
export function pageAccessOk(req: { cookie: string | undefined; host: string | null }, key: string, port: number): boolean {
  return hostOk(req.host, port) && !!req.cookie && sameSecret(req.cookie, key);
}
