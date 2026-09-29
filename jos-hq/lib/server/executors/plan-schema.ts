// The PLAN contract a planning session must return (Tasks/Planner-Memory-Spec-2026-09-24.md, 1.4).
// Strict-mode compatible for both runtimes: every object closed, every property required, and
// payloads travel as JSON text. HQ adds `version: 2` after coercion; it is not part of the schema.
const str = { type: "string" } as const;
const strs = { type: "array", items: str } as const;
const obj = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

const STEP_KINDS = ["read", "write", "flow_build", "flow_run", "local"] as const;
const LEARNED = ["knowledge", "read", "flow_docs", "none"] as const;

export const PLAN_RESULT_SCHEMA = obj({
  status: { type: "string", enum: ["planned", "blocked"] },
  title: str,
  objective: str,
  success_condition: str,
  intent_questions: strs,
  identity_check: obj({ project_root: str, email: str, passed: { type: "boolean" } }),
  connections: { type: "array", items: obj({ platform: str, connection_key: str, connection_name: str, why: str }) },
  resolved_facts: { type: "array", items: obj({ fact: str, source: str }) },
  steps: {
    type: "array",
    items: obj({
      n: { type: "integer" },
      kind: { type: "string", enum: [...STEP_KINDS] },
      description: str,
      platform: str,
      action_id: str,
      connection_key: str,
      parameters_json: str,
      learned_from: { type: "string", enum: [...LEARNED] },
      depends_on: { type: "array", items: { type: "integer" } },
      side_effect: { type: "boolean" },
    }),
  },
  flow_design: obj({ needed: { type: "boolean" }, key: str, name: str, inputs: strs, outline: strs, error_handling: strs, test_plan: strs }),
  verification: strs,
  risks: strs,
  estimated_external_calls: { type: "integer" },
  paid_surfaces: strs,
  notes: str,
});

export interface PlanStep {
  n: number;
  kind: (typeof STEP_KINDS)[number];
  description: string;
  platform: string;
  action_id: string;
  connection_key: string;
  parameters_json: string;
  learned_from: (typeof LEARNED)[number];
  depends_on: number[];
  side_effect: boolean;
}

export interface PlannerResult {
  version: 2;
  status: "planned" | "blocked";
  title: string;
  objective: string;
  success_condition: string;
  intent_questions: string[];
  identity_check: { project_root: string; email: string; passed: boolean };
  connections: Array<{ platform: string; connection_key: string; connection_name: string; why: string }>;
  resolved_facts: Array<{ fact: string; source: string }>;
  steps: PlanStep[];
  flow_design: { needed: boolean; key: string; name: string; inputs: string[]; outline: string[]; error_handling: string[]; test_plan: string[] };
  verification: string[];
  risks: string[];
  estimated_external_calls: number;
  paid_surfaces: string[];
  notes: string;
}

const s = (x: unknown) => (typeof x === "string" ? x : x == null ? "" : String(x));
const list = (x: unknown) => (Array.isArray(x) ? x.map(s).filter(Boolean) : []);
const records = (x: unknown) => (Array.isArray(x) ? (x.filter((v) => v && typeof v === "object") as Array<Record<string, unknown>>) : []);

/** Structural validation of what came back; the runtimes enforce the schema, HQ double-checks. */
export function coercePlan(value: unknown): { ok: true; plan: PlannerResult } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "the planner returned no structured plan" };
  const v = value as Record<string, unknown>;
  if (v.status !== "planned" && v.status !== "blocked") return { ok: false, error: `invalid plan status ${s(v.status)}` };
  if (!Array.isArray(v.steps)) return { ok: false, error: "plan steps missing" };
  if (!v.identity_check || typeof v.identity_check !== "object") return { ok: false, error: "plan identity_check missing" };
  const ic = v.identity_check as Record<string, unknown>;
  const fd = (v.flow_design && typeof v.flow_design === "object" ? v.flow_design : {}) as Record<string, unknown>;
  const calls = Number(v.estimated_external_calls);
  return {
    ok: true,
    plan: {
      version: 2,
      status: v.status,
      title: s(v.title).slice(0, 80),
      objective: s(v.objective),
      success_condition: s(v.success_condition),
      intent_questions: list(v.intent_questions),
      identity_check: { project_root: s(ic.project_root), email: s(ic.email), passed: ic.passed === true },
      connections: records(v.connections).map((c) => ({ platform: s(c.platform), connection_key: s(c.connection_key), connection_name: s(c.connection_name), why: s(c.why) })),
      resolved_facts: records(v.resolved_facts).map((f) => ({ fact: s(f.fact), source: s(f.source) })),
      steps: records(v.steps).map((o, i) => {
        const known = (STEP_KINDS as readonly string[]).includes(s(o.kind));
        return {
          n: Number.isInteger(o.n) ? (o.n as number) : i + 1,
          // An unknown kind is treated as a side effect, never as a read.
          kind: known ? (o.kind as PlanStep["kind"]) : "write",
          description: s(o.description),
          platform: s(o.platform),
          action_id: s(o.action_id),
          connection_key: s(o.connection_key),
          parameters_json: s(o.parameters_json),
          learned_from: (LEARNED as readonly string[]).includes(s(o.learned_from)) ? (o.learned_from as PlanStep["learned_from"]) : "none",
          depends_on: Array.isArray(o.depends_on) ? (o.depends_on as unknown[]).filter((d): d is number => Number.isInteger(d)) : [],
          side_effect: o.side_effect === true || !known,
        };
      }),
      flow_design: { needed: fd.needed === true, key: s(fd.key), name: s(fd.name), inputs: list(fd.inputs), outline: list(fd.outline), error_handling: list(fd.error_handling), test_plan: list(fd.test_plan) },
      verification: list(v.verification),
      risks: list(v.risks),
      estimated_external_calls: Number.isFinite(calls) ? Math.max(0, Math.trunc(calls)) : 0,
      paid_surfaces: list(v.paid_surfaces),
      notes: s(v.notes),
    },
  };
}
