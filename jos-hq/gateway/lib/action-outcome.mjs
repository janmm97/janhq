import { extractJson } from "./real-one.mjs";

export function approvedActionTimeoutMs(kind, deadline, now = Date.now()) {
  const remaining = Number.isFinite(deadline) ? Math.max(0, deadline - now - 60000) : 180000;
  return kind === "one_flow" ? remaining : Math.min(180000, remaining);
}

// A Flow emits JSONL, including successful starts before failures. Only its terminal
// workflow result establishes completion; exit 0 and a parsed first line do not.
export function actionOutcome(result, kind) {
  const records = String(result.stdout ?? "").split(/\r?\n/).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const json = kind === "one_flow"
    ? records.findLast((v) => v?.event === "workflow:result")
    : extractJson(result.stdout);
  if (result.timedOut || result.error) return { outcome: "ambiguous", json, summary: result.timedOut ? "timed out" : result.error };
  if (kind === "one_flow" && !json) return { outcome: "ambiguous", summary: "Missing terminal workflow:result; inspect the run before any retry." };
  if (json === undefined) return { outcome: "ambiguous", summary: "unparseable output" };
  if (kind === "flow_validation" && json?.valid !== true) {
    return { outcome: "failed", json, summary: JSON.stringify(json?.errors ?? json?.error ?? "Flow validation did not confirm valid:true") };
  }
  const error = json?.error;
  if (error || (kind === "one_flow" && json.status === "failed")) {
    return { outcome: "failed", json, summary: typeof error === "string" ? error : JSON.stringify(error ?? { status: json.status }) };
  }
  if (result.code !== 0 || (kind === "one_flow" && json.status !== "success")) {
    return { outcome: "ambiguous", json, summary: `Unconfirmed completion (exit ${result.code}, status ${json?.status ?? "unknown"}); verify before retry.` };
  }
  return { outcome: "succeeded", json, summary: "ok" };
}
