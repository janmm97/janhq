import { describe, expect, it } from "vitest";
import { markFor, stationsFor, type StationInput } from "@/lib/client/stations";

const run = (phase: string, status = "running") => ({ phase, status });
const exited = (phase: string) => ({ phase, status: "exited" });
const states = (t: StationInput) => stationsFor(t).map((s) => s.state);

describe("a task's six stations", () => {
  it("names the stations in order", () => {
    expect(stationsFor({ status: "queued", executions: [], approvals: [] }).map((s) => s.label)).toEqual(["Compose", "Test strip", "Expose", "Develop", "Fix", "Dry"]);
  });

  it("is at Compose while it routes, discovers, waits in line and plans", () => {
    for (const status of ["queued", "routing", "discovering", "in_line", "planning"]) {
      expect(states({ status, executions: status === "planning" ? [run("plan")] : [], approvals: [] })).toEqual(["current", "todo", "todo", "todo", "todo", "todo"]);
    }
  });

  it("waits for the operator at Compose when routing asks a question", () => {
    expect(states({ status: "needs_clarification", executions: [], approvals: [] })).toEqual(["waiting", "todo", "todo", "todo", "todo", "todo"]);
  });

  it("is at Test strip during PREVIEW, and an executor question after it waits at Expose", () => {
    expect(states({ status: "executing", executions: [exited("plan"), run("preview")], approvals: [] })).toEqual(["done", "current", "todo", "todo", "todo", "todo"]);
    expect(states({ status: "needs_clarification", executions: [exited("preview")], approvals: [] })).toEqual(["done", "done", "waiting", "todo", "todo", "todo"]);
  });

  it("waits at Expose for an approval", () => {
    expect(states({ status: "awaiting_approval", executions: [exited("preview")], approvals: [{ status: "pending" }] })).toEqual(["done", "done", "waiting", "todo", "todo", "todo"]);
  });

  it("is at Develop during EXECUTE and at Fix while verifying", () => {
    const approvals = [{ status: "approved" }];
    expect(states({ status: "executing", executions: [exited("preview"), run("execute")], approvals })).toEqual(["done", "done", "done", "current", "todo", "todo"]);
    expect(states({ status: "dispatching", executions: [exited("preview")], approvals })).toEqual(["done", "done", "done", "current", "todo", "todo"]);
    expect(states({ status: "verifying", executions: [exited("preview"), exited("execute")], approvals })).toEqual(["done", "done", "done", "done", "current", "todo"]);
  });

  it("dispatching before any run is still Compose; only an approved approval moves it to Develop", () => {
    expect(states({ status: "dispatching", stage: "prompt", executions: [exited("plan")], approvals: [] })).toEqual(["current", "todo", "todo", "todo", "todo", "todo"]);
    expect(states({ status: "dispatching", stage: "execute", executions: [exited("preview")], approvals: [{ status: "approved" }] })).toEqual(["done", "done", "done", "current", "todo", "todo"]);
    // A superseded approval (an answer re-runs PREVIEW) does not reach Develop.
    expect(states({ status: "dispatching", executions: [exited("preview")], approvals: [{ status: "superseded" }] })).toEqual(["done", "current", "todo", "todo", "todo", "todo"]);
  });

  it("is at Fix while HQ verifies, which HQ marks by stage", () => {
    expect(states({ status: "executing", stage: "verify", executions: [exited("preview"), exited("execute")], approvals: [{ status: "approved" }] })).toEqual(["done", "done", "done", "done", "current", "todo"]);
  });

  it("marks a running PREVIEW as Preview, and everything else by its status", () => {
    expect(markFor({ status: "executing", executions: [run("preview")], approvals: [] })).toEqual({ tone: "preview", text: "Preview" });
    expect(markFor({ status: "executing", executions: [exited("preview"), run("execute")], approvals: [{ status: "approved" }] })).toEqual({ tone: "run", text: "Running" });
    expect(markFor({ status: "dispatching", executions: [], approvals: [] })).toEqual({ tone: "plan", text: "Planning" });
    expect(markFor({ status: "awaiting_approval", executions: [exited("preview")], approvals: [{ status: "pending" }] })).toEqual({ tone: "you", text: "Needs you" });
  });

  it("dries every station a finished task reached and marks the rest skipped", () => {
    expect(states({ status: "completed", executions: [exited("preview"), exited("execute")], approvals: [{ status: "approved" }] })).toEqual(["done", "done", "done", "done", "done", "done"]);
    // A read-only task: PREVIEW did the work, nothing needed approval.
    expect(states({ status: "completed", executions: [exited("preview")], approvals: [] })).toEqual(["done", "done", "skipped", "skipped", "done", "done"]);
    // Plan mode stops after planning.
    expect(states({ status: "planned", executions: [exited("plan")], approvals: [] })).toEqual(["done", "skipped", "skipped", "skipped", "skipped", "done"]);
  });

  it("marks where a failed task stopped, and where a cancelled one was stopped", () => {
    expect(states({ status: "failed", executions: [exited("preview")], approvals: [] })).toEqual(["done", "failed", "todo", "todo", "todo", "done"]);
    expect(states({ status: "blocked", executions: [], approvals: [] })).toEqual(["failed", "todo", "todo", "todo", "todo", "done"]);
    expect(states({ status: "cancelled", executions: [], approvals: [] })).toEqual(["stopped", "todo", "todo", "todo", "todo", "done"]);
  });

  it("an interrupted run waits for reconciliation where it was, and is not dried", () => {
    expect(states({ status: "interrupted", executions: [exited("preview"), exited("execute")], approvals: [{ status: "approved" }] })).toEqual(["done", "done", "done", "waiting", "todo", "todo"]);
  });
});
