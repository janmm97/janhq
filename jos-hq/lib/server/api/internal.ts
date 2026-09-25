// Endpoints called by the executor-side gateway (`one`, `jos-approved`) and the Claude guard hook.
// Authenticated by the per-execution nonce HQ placed in the executor's environment.
import { authenticateGateway, awaitVerification, observeGuard } from "../dispatch";
import { claimApprovedAction, recordActionOutcome } from "../approvals";
import { recordGatewayEvent } from "../telemetry";
import { body, fail, ok } from "./http";

export async function handleInternal(req: Request, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/internal/")) return null;
  const url = new URL(req.url);
  const execId = req.headers.get("x-jos-execution-id") ?? url.searchParams.get("execution");
  const entry = authenticateGateway(execId, req.headers.get("x-jos-gateway-token"));
  if (!entry) return fail(401, "GATEWAY_AUTH", "unknown or finished execution, or bad gateway nonce");

  if (pathname === "/api/internal/gateway/verified" && req.method === "GET") {
    return ok(await awaitVerification(entry));
  }
  if (pathname === "/api/internal/gateway/event" && req.method === "POST") {
    recordGatewayEvent({ executionId: entry.id, taskId: entry.taskId, workspace: entry.workspace, executor: entry.adapter.id }, await body(req));
    return ok({ recorded: true });
  }
  if (pathname === "/api/internal/gateway/consume" && req.method === "POST") {
    const b = await body<{ approvalId?: string; index?: number; payloadHash?: string }>(req);
    if (entry.phase !== "execute") return fail(409, "NOT_EXECUTE_PHASE", "approved actions run only in the EXECUTE phase");
    const r = claimApprovedAction({ approvalId: String(b.approvalId), index: Number(b.index), payloadHash: String(b.payloadHash), taskId: entry.taskId });
    return r.ok ? ok({ claimed: true }) : fail(409, "NOT_RELEASED", r.error);
  }
  if (pathname === "/api/internal/gateway/consume-result" && req.method === "POST") {
    const b = await body<{ approvalId?: string; index?: number; outcome?: string; summary?: string; responseIds?: string[]; durationMs?: number }>(req);
    const outcome = ["succeeded", "failed", "ambiguous", "blocked"].includes(String(b.outcome)) ? (b.outcome as "succeeded") : "ambiguous";
    recordActionOutcome({
      approvalId: String(b.approvalId),
      index: Number(b.index),
      outcome,
      summary: String(b.summary ?? ""),
      responseIds: Array.isArray(b.responseIds) ? b.responseIds.map(String) : [],
      durationMs: typeof b.durationMs === "number" ? b.durationMs : undefined,
      executionId: entry.id,
      workspace: entry.workspace,
    });
    return ok({ recorded: true });
  }
  if (pathname === "/api/internal/claude-guard/observe" && req.method === "POST") {
    const b = await body<{ effort?: string | null; permissionMode?: string | null; cwd?: string | null; tool?: string; summary?: string | null }>(req);
    return ok(observeGuard(entry, { effort: b.effort ?? null, permissionMode: b.permissionMode ?? null, cwd: b.cwd ?? null, tool: String(b.tool ?? ""), summary: b.summary ?? null }));
  }
  return fail(404, "NOT_FOUND", `no internal route ${req.method} ${pathname}`);
}
