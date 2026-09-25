export function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export function fail(status: number, code: string, message: string, details?: unknown): Response {
  return new Response(JSON.stringify({ error: { code, message, details: details ?? null } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

/**
 * Mutating browser/CLI requests must carry `x-jos-hq: 1` (a custom header forces a CORS preflight
 * that this server never grants, so another web page cannot forge it) and, when present, an Origin
 * on this host. This is the CSRF guard for a localhost app that can start processes.
 */
export function assertMutationAllowed(req: Request): Response | null {
  if (req.headers.get("x-jos-hq") !== "1") return fail(403, "CSRF_GUARD", "Missing x-jos-hq header; requests must come from the J/OS HQ UI or the jos CLI.");
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const host = new URL(origin).hostname;
      if (host !== "127.0.0.1" && host !== "localhost") return fail(403, "CSRF_GUARD", `Cross-origin request from ${origin} refused.`);
    } catch {
      return fail(403, "CSRF_GUARD", "Malformed Origin header.");
    }
  }
  return null;
}
