// The RETURN contract every executor must satisfy (CLAUDE.md §5 / §11). Strict-mode compatible for
// both runtimes: every property required, no free-form objects (payloads travel as JSON strings).
import type { ExecutorResult } from "./types";

const str = { type: "string" } as const;

export const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "answer",
    "summary",
    "identity_check",
    "proposed_actions",
    "artifacts",
    "verification",
    "limitations",
    "learned",
    "needs_user_input",
  ],
  properties: {
    status: { type: "string", enum: ["completed", "needs_approval", "blocked", "failed", "partial"] },
    answer: str,
    summary: str,
    identity_check: {
      type: "object",
      additionalProperties: false,
      required: ["project_root", "email", "passed"],
      properties: { project_root: str, email: str, passed: { type: "boolean" } },
    },
    proposed_actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "title",
          "platform",
          "action_id",
          "connection_key",
          "connection_name",
          "method",
          "target",
          "data_json",
          "path_vars_json",
          "query_params_json",
          "flow_key",
          "flow_inputs_json",
          "side_effect",
          "idempotent",
          "expected_calls",
          "estimated_cost",
          "dry_run_ok",
        ],
        properties: {
          kind: { type: "string", enum: ["one_action", "one_flow"] },
          title: str,
          platform: str,
          action_id: str,
          connection_key: str,
          connection_name: str,
          method: str,
          target: str,
          data_json: str,
          path_vars_json: str,
          query_params_json: str,
          flow_key: str,
          flow_inputs_json: str,
          side_effect: str,
          idempotent: { type: "boolean" },
          expected_calls: { type: "integer" },
          estimated_cost: str,
          dry_run_ok: { type: "boolean" },
        },
      },
    },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "id", "path", "description"],
        properties: { kind: str, id: str, path: str, description: str },
      },
    },
    verification: {
      type: "object",
      additionalProperties: false,
      required: ["performed", "passed", "method", "evidence"],
      properties: { performed: { type: "boolean" }, passed: { type: "boolean" }, method: str, evidence: str },
    },
    limitations: { type: "array", items: str },
    learned: { type: "array", items: str },
    needs_user_input: str,
  },
} as const;

/** Structural validation of what came back; the runtimes enforce the schema, HQ double-checks. */
export function coerceResult(value: unknown): { ok: true; result: ExecutorResult } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "executor returned no structured result" };
  const v = value as Record<string, unknown>;
  const statuses = ["completed", "needs_approval", "blocked", "failed", "partial"];
  if (!statuses.includes(String(v.status))) return { ok: false, error: `invalid status ${String(v.status)}` };
  if (!Array.isArray(v.proposed_actions)) return { ok: false, error: "proposed_actions missing" };
  if (!v.verification || typeof v.verification !== "object") return { ok: false, error: "verification missing" };
  return {
    ok: true,
    result: {
      status: v.status as ExecutorResult["status"],
      answer: String(v.answer ?? ""),
      summary: String(v.summary ?? ""),
      identity_check: (v.identity_check as ExecutorResult["identity_check"]) ?? { project_root: "", email: "", passed: false },
      proposed_actions: v.proposed_actions as ExecutorResult["proposed_actions"],
      artifacts: Array.isArray(v.artifacts) ? (v.artifacts as ExecutorResult["artifacts"]) : [],
      verification: v.verification as ExecutorResult["verification"],
      limitations: Array.isArray(v.limitations) ? (v.limitations as string[]) : [],
      learned: Array.isArray(v.learned) ? (v.learned as string[]) : [],
      needs_user_input: String(v.needs_user_input ?? ""),
    },
  };
}
