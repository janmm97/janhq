// Minimal client for the HQ server's internal gateway endpoints. Authenticated by the per-execution
// nonce HQ put in the executor's environment; the browser never sees these values.
//
// Uses node:http with keep-alive disabled, not fetch: on Windows, exiting while fetch's keep-alive
// sockets close trips a libuv assertion (src\win\async.c) that turns a clean exit into a crash. For
// the Claude guard hook that would be fail-open, because Claude Code ignores a hook's JSON output
// when the hook exits non-zero.
import http from "node:http";

function base() {
  const s = process.env.JOS_HQ_SERVER;
  if (!s) throw new Error("JOS_HQ_SERVER is not set");
  return new URL(s);
}

function call(method, path, body, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(path, base());
    } catch (e) {
      resolve({ ok: false, status: 0, json: null, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        agent: false,
        headers: {
          connection: "close",
          "content-type": "application/json",
          // Named NONCE, not TOKEN: Codex strips *TOKEN*/*KEY*/*SECRET* variables from command envs.
          "x-jos-gateway-token": process.env.JOS_HQ_GATEWAY_NONCE ?? "",
          "x-jos-execution-id": process.env.JOS_HQ_EXECUTION_ID ?? "",
          ...(payload ? { "content-length": String(payload.length) } : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          clearTimeout(timer);
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* not JSON */
          }
          resolve({ ok: (res.statusCode ?? 500) < 400, status: res.statusCode ?? 0, json });
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`timeout after ${timeoutMs} ms`));
    }, timeoutMs);
    req.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, status: 0, json: null, error: e.message });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export function hqPost(path, body, timeoutMs = 5000) {
  return call("POST", path, body, timeoutMs);
}

export function hqGet(path, timeoutMs = 5000) {
  return call("GET", path, undefined, timeoutMs);
}
