import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The lock sits in front of boot: booting here would reconcile a database and call the One CLI.
vi.mock("../../lib/server/boot", () => ({ ensureBoot: async () => {} }));

import { HQ_COOKIE, accessKeyFile, checkHqRequest, ensureHqKey, pageAccessOk, sameSecret } from "../../lib/server/access";
import { handleApi } from "../../lib/server/api/router";
import { GET as enter } from "../../app/enter/route";

const app = path.resolve(import.meta.dirname, "..", "..");
const key = "a".repeat(64);
const port = 4617;
const req = (headers: Record<string, string>, init: RequestInit & { url?: string } = {}) =>
  new Request(init.url ?? `http://127.0.0.1:${port}/api/chats`, { ...init, headers });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-access-"));
beforeAll(() => {
  // Never the real %LOCALAPPDATA%\JOS\hq\access.key.
  process.env.JOS_HQ_ACCESS_KEY_FILE = path.join(tmp, "hq", "access.key");
  process.env.JOS_HQ_PORT = String(port);
  process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
  process.env.JOS_HQ_CONFIG = path.join(app, "tests", "e2e", "fixtures", "hq.e2e.config.json");
});

describe("checkHqRequest", () => {
  it("accepts the cookie or the x-jos-key header on 127.0.0.1 or localhost at the port", () => {
    expect(checkHqRequest(req({ host: `127.0.0.1:${port}`, cookie: `other=1; ${HQ_COOKIE}=${key}` }), key, port)).toEqual({ ok: true });
    expect(checkHqRequest(req({ host: `localhost:${port}`, "x-jos-key": key }), key, port)).toEqual({ ok: true });
  });
  it("rejects another Host, or the right host on another port (DNS rebinding)", () => {
    expect(checkHqRequest(req({ host: `evil.example:${port}`, "x-jos-key": key }), key, port)).toMatchObject({ ok: false, status: 403 });
    expect(checkHqRequest(req({ host: "127.0.0.1:9999", "x-jos-key": key }), key, port)).toMatchObject({ ok: false, status: 403 });
    expect(checkHqRequest(req({ "x-jos-key": key }), key, port)).toMatchObject({ ok: false, status: 403 });
  });
  it("rejects a missing, wrong or differently sized key", () => {
    const host = `127.0.0.1:${port}`;
    expect(checkHqRequest(req({ host }), key, port)).toMatchObject({ ok: false, status: 401 });
    expect(checkHqRequest(req({ host, cookie: `${HQ_COOKIE}=${"b".repeat(64)}` }), key, port)).toMatchObject({ ok: false, status: 401 });
    expect(checkHqRequest(req({ host, "x-jos-key": "a" }), key, port)).toMatchObject({ ok: false, status: 401 });
    expect(checkHqRequest(req({ host, cookie: `x${HQ_COOKIE}=${key}` }), key, port)).toMatchObject({ ok: false, status: 401 });
  });
  it("rejects a cross-site write even with the key", () => {
    const r = req({ host: `127.0.0.1:${port}`, cookie: `${HQ_COOKIE}=${key}`, origin: "https://evil.example" }, { method: "POST" });
    expect(checkHqRequest(r, key, port)).toMatchObject({ ok: false, status: 403 });
    const same = req({ host: `127.0.0.1:${port}`, cookie: `${HQ_COOKIE}=${key}`, origin: `http://localhost:${port}` }, { method: "POST" });
    expect(checkHqRequest(same, key, port)).toEqual({ ok: true });
  });
  it("compares secrets by value only", () => {
    expect(sameSecret(key, key)).toBe(true);
    expect(sameSecret(key, "b".repeat(64))).toBe(false);
    expect(sameSecret(key, "")).toBe(false);
  });
});

describe("pageAccessOk", () => {
  it("needs the cookie and the right host", () => {
    expect(pageAccessOk({ cookie: key, host: `127.0.0.1:${port}` }, key, port)).toBe(true);
    expect(pageAccessOk({ cookie: undefined, host: `127.0.0.1:${port}` }, key, port)).toBe(false);
    expect(pageAccessOk({ cookie: key, host: `evil.example:${port}` }, key, port)).toBe(false);
  });
});

describe("the key file", () => {
  it("honours JOS_HQ_ACCESS_KEY_FILE and otherwise sits under %LOCALAPPDATA%\\JOS\\hq", () => {
    expect(accessKeyFile()).toBe(path.join(tmp, "hq", "access.key"));
    const saved = process.env.JOS_HQ_ACCESS_KEY_FILE;
    delete process.env.JOS_HQ_ACCESS_KEY_FILE;
    try {
      expect(accessKeyFile().toLowerCase()).toMatch(/[\\/]jos[\\/]hq[\\/]access\.key$/);
    } finally {
      process.env.JOS_HQ_ACCESS_KEY_FILE = saved;
    }
  });
  it("is created with 32 random bytes of hex, kept, and regenerated when empty", () => {
    const f = accessKeyFile();
    fs.rmSync(f, { force: true });
    const k1 = ensureHqKey();
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureHqKey()).toBe(k1);
    fs.writeFileSync(f, "  \n");
    const k2 = ensureHqKey();
    expect(k2).toMatch(/^[0-9a-f]{64}$/);
    expect(k2).not.toBe(k1);
    expect(fs.readFileSync(f, "utf8").trim()).toBe(k2);
  });
});

describe("/enter", () => {
  let k = "";
  beforeEach(() => {
    k = ensureHqKey();
  });
  it("sets the HttpOnly SameSite=Strict cookie and 303s home for the right key", async () => {
    const res = await enter(new Request(`http://127.0.0.1:${port}/enter?k=${k}`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toBe(`${HQ_COOKIE}=${k}; HttpOnly; SameSite=Strict; Path=/`);
  });
  it("gives 401 and no cookie for a missing or wrong key", async () => {
    for (const url of [`http://127.0.0.1:${port}/enter`, `http://127.0.0.1:${port}/enter?k=${"b".repeat(64)}`]) {
      const res = await enter(new Request(url));
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });
});

describe("handleApi's lock", () => {
  let k = "";
  const host = `127.0.0.1:${port}`;
  beforeEach(() => {
    k = ensureHqKey();
  });
  it("refuses a request without the key with 401", async () => {
    const res = await handleApi(req({ host }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("ACCESS_LOCKED");
  });
  it("refuses the SSE stream without the key", async () => {
    const res = await handleApi(req({ host, accept: "text/event-stream" }, { url: `http://${host}/api/tasks/t1/events` }));
    expect(res.status).toBe(401);
  });
  it("refuses a wrong Host with 403 even with the key", async () => {
    const res = await handleApi(req({ host: "evil.example", "x-jos-key": k }));
    expect(res.status).toBe(403);
  });
  it("lets a keyed request through to routing, and the mutation guard still applies", async () => {
    const res = await handleApi(req({ host, "x-jos-key": k }, { url: `http://${host}/api/no-such-route` }));
    expect(res.status).toBe(404);
    const post = await handleApi(req({ host, "x-jos-key": k }, { url: `http://${host}/api/chats`, method: "POST", body: "{}" }));
    expect((await post.json()).error.code).toBe("CSRF_GUARD");
  });
  it("leaves /api/internal/* to its nonce: no key needed, and the key alone is not enough", async () => {
    const nonce = "nonce-for-test";
    const g = globalThis as unknown as { __josLive?: Map<string, unknown> };
    g.__josLive ??= new Map();
    g.__josLive.set("exec_test", { id: "exec_test", taskId: "t1", nonceHash: createHash("sha256").update(nonce).digest("hex"), verify: { ok: true, mainModels: new Set() }, waiters: [] });
    try {
      const url = `http://${host}/api/internal/gateway/verified`;
      const good = await handleApi(req({ host, "x-jos-execution-id": "exec_test", "x-jos-gateway-token": nonce }, { url }));
      expect(good.status).toBe(200);
      expect((await good.json()).verified).toBe(true);
      const keyOnly = await handleApi(req({ host, "x-jos-key": k }, { url }));
      expect(keyOnly.status).toBe(401);
      expect((await keyOnly.json()).error.code).toBe("GATEWAY_AUTH");
    } finally {
      g.__josLive.delete("exec_test");
    }
  });
});

describe("bin/jos.mjs sends the key", () => {
  const seen: Array<{ url: string; key: string | undefined }> = [];
  let server: http.Server;
  let url = "";
  beforeAll(async () => {
    server = http.createServer((q, s) => {
      seen.push({ url: q.url ?? "", key: q.headers["x-jos-key"] as string | undefined });
      q.resume();
      q.on("end", () => {
        if (q.url === "/api/dispatch") {
          s.writeHead(200, { "content-type": "application/json" });
          return s.end(JSON.stringify({ taskId: "task_1", chatId: "chat_1" }));
        }
        if (q.url?.endsWith("/events")) {
          s.writeHead(200, { "content-type": "text/event-stream" });
          return s.end(`data: ${JSON.stringify({ type: "task_complete", createdAt: "2026-09-28T10:00:00.000Z", summary: "done" })}\n\n`);
        }
        s.writeHead(200, { "content-type": "application/json" });
        s.end(JSON.stringify({ task: { status: "completed" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  const run = (args: string[], keyFile: string) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env, JOS_HQ_URL: url, JOS_HQ_ACCESS_KEY_FILE: keyFile };
      delete env.JOS_HQ_EXECUTION_ID;
      delete env.JOS_HQ_TASK_ID;
      const c = spawn(process.execPath, [path.join(app, "bin", "jos.mjs"), ...args], { cwd: tmp, env });
      let out = "";
      let err = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (err += d));
      c.on("exit", (code) => resolve({ code, out, err }));
    });

  it("on dispatch and on the SSE watch", async () => {
    const prompt = path.join(tmp, "prompt.md");
    fs.writeFileSync(prompt, "YOU ARE THE PRIMARY EXECUTOR FOR THIS TASK\n");
    seen.length = 0;
    const r = await run(["dispatch", "--to", "One", "--prompt-file", prompt], accessKeyFile());
    expect(r.err).toBe("");
    expect(seen.map((s) => s.url)).toEqual(["/api/dispatch", "/api/tasks/task_1/events", "/api/tasks/task_1"]);
    for (const s of seen) expect(s.key).toBe(ensureHqKey());
  });

  it("names the key file when it is missing", async () => {
    seen.length = 0;
    const missing = path.join(tmp, "nowhere", "access.key");
    const r = await run(["status", "task_1"], missing);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(missing);
    expect(seen).toEqual([]);
  });
});

describe("the desktop scripts", () => {
  it("derive every path from $PSScriptRoot rather than a user's folder", () => {
    for (const f of ["open.ps1", "install-shortcut.ps1"]) {
      const text = fs.readFileSync(path.join(app, "scripts", f), "utf8");
      expect(text, f).not.toMatch(/C:\\Users\\/i);
      expect(text, f).toContain("$PSScriptRoot");
    }
  });
});
