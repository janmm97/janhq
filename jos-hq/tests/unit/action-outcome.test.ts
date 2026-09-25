import { describe, expect, it } from "vitest";
import { actionOutcome, approvedActionTimeoutMs } from "../../gateway/lib/action-outcome.mjs";

const result = (events: unknown[], code = 0) => ({ stdout: events.map(v => JSON.stringify(v)).join("\n"), code });
describe("approved Flow outcome", () => {
  it("lets multi-step Flows use the executor budget while reserving a minute for reporting", () => {
    expect(approvedActionTimeoutMs("one_flow", 1801000, 1000)).toBe(1740000);
    expect(approvedActionTimeoutMs("one_action", 1801000, 1000)).toBe(180000);
    expect(approvedActionTimeoutMs("one_flow", 1000, 1000)).toBe(0);
    expect(approvedActionTimeoutMs("one_flow", undefined, 1000)).toBe(180000);
  });
  it("reports the recorded incident as failed even with exit zero and successful early steps", () => {
    const r = result([{ event: "flow:start" }, { event: "step:complete", status: "success" },
      { event: "flow:error", status: "failed" },
      { event: "workflow:result", runId: "0369c22669fd", status: "failed", error: "No endpoints found" }]);
    expect(actionOutcome(r, "one_flow")).toMatchObject({ outcome: "failed", summary: "No endpoints found", json: { runId: "0369c22669fd" } });
  });
  it("accepts only a terminal success", () => {
    expect(actionOutcome(result([{ event: "flow:start" }, { event: "workflow:result", status: "success", runId: "ok" }]), "one_flow").outcome).toBe("succeeded");
  });
  it.each([[], [{ event: "flow:start" }], [{ event: "workflow:result", status: "paused" }]])("leaves incomplete output ambiguous: %j", (...events) => {
    expect(actionOutcome(result(events), "one_flow").outcome).toBe("ambiguous");
  });
  it("does not certify a nonzero exit or timeout", () => {
    const r = result([{ event: "workflow:result", status: "success" }], 1);
    expect(actionOutcome(r, "one_flow").outcome).toBe("ambiguous");
    expect(actionOutcome({ ...r, code: 0, timedOut: true }, "one_flow").outcome).toBe("ambiguous");
  });
  it("preserves ordinary action errors and successful resource objects", () => {
    expect(actionOutcome(result([{ error: { message: "denied" } }]), "one_action").outcome).toBe("failed");
    expect(actionOutcome(result([{ response: { id: "doc1" } }]), "one_action").outcome).toBe("succeeded");
  });
  it("rejects flow validate valid:false even when the CLI exits zero", () => {
    expect(actionOutcome(result([{ valid: false, errors: [{ message: "Syntax check failed" }] }]), "flow_validation").outcome).toBe("failed");
    expect(actionOutcome(result([{ valid: true }]), "flow_validation").outcome).toBe("succeeded");
    expect(actionOutcome(result([{ ok: true }]), "flow_validation").outcome).toBe("failed");
  });
});
