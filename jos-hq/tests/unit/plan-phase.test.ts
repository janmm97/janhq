import { describe, expect, it } from "vitest";
import { rawPlan } from "./fixtures/plans";

describe("the PLAN phase", () => {
  it("gives the One planner read-only tools and no local writes, in every mode", async () => {
    const { claudePermissions } = await import("@/lib/server/executors/claude");
    for (const mode of ["auto", "edit", "manual", "plan"] as const) {
      const p = claudePermissions(mode, "plan");
      expect(p).toMatchObject({ permissionMode: "dontAsk", allowLocalWrites: false });
      for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Task", "Bash(node *)", "Bash(mkdir *)", "Bash(jos-approved *)"]) expect(p.allowedTools).not.toContain(t);
      expect(p.allowedTools).toEqual(expect.arrayContaining(["Read", "Bash(one *)", "PowerShell(one *)"]));
    }
  });

  it("pins each phase to its role's model", async () => {
    const { phasePolicy } = await import("@/lib/server/dispatch");
    expect(phasePolicy("Studio", "plan")).toMatchObject({ model: "gpt-6-astra", effort: "medium" });
    expect(phasePolicy("Studio", "preview").model).toBe("gpt-6-sol");
    expect(phasePolicy("Studio", "execute").model).toBe("gpt-6-sol");
    expect(phasePolicy("One", "plan")).toMatchObject({ model: "claude-opus-5-5", effort: "medium" });
  });

  it("bounds a planning session by planTimeoutMs", async () => {
    const { phaseTimeoutMs } = await import("@/lib/server/dispatch");
    expect(phaseTimeoutMs("plan")).toBe(600000);
    expect(phaseTimeoutMs("preview")).toBe(1800000);
    expect(phaseTimeoutMs("execute")).toBe(1800000);
  });

  it("has a schema Codex strict mode accepts: every object closed and fully required", async () => {
    const { PLAN_RESULT_SCHEMA } = await import("@/lib/server/executors/plan-schema");
    const walk = (s: Record<string, unknown>, where: string) => {
      if (s.type === "object") {
        expect(s.additionalProperties, where).toBe(false);
        expect([...(s.required as string[])].sort(), where).toEqual(Object.keys(s.properties as object).sort());
        for (const [k, v] of Object.entries(s.properties as Record<string, Record<string, unknown>>)) walk(v, `${where}.${k}`);
      }
      if (s.type === "array") walk(s.items as Record<string, unknown>, `${where}[]`);
    };
    walk(PLAN_RESULT_SCHEMA as unknown as Record<string, unknown>, "plan");
  });

  it("coerces a plan, marks it version 2 and fails closed on an unknown step kind", async () => {
    const { coercePlan } = await import("@/lib/server/executors/plan-schema");
    const r = coercePlan(rawPlan({ steps: [{ ...rawPlan().steps[0], kind: "teleport" }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.version).toBe(2);
    expect(r.plan.steps[0]).toMatchObject({ n: 1, kind: "write", learned_from: "knowledge", side_effect: true });
    expect(r.plan.identity_check.passed).toBe(true);
  });

  it("rejects a plan without steps, identity check or a valid status", async () => {
    const { coercePlan } = await import("@/lib/server/executors/plan-schema");
    expect(coercePlan(null)).toMatchObject({ ok: false });
    expect(coercePlan({ ...rawPlan(), steps: undefined })).toMatchObject({ ok: false, error: expect.stringMatching(/steps/) });
    expect(coercePlan({ ...rawPlan(), identity_check: undefined })).toMatchObject({ ok: false, error: expect.stringMatching(/identity/) });
    expect(coercePlan({ ...rawPlan(), status: "done" })).toMatchObject({ ok: false, error: expect.stringMatching(/status/) });
  });
});
