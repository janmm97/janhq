import { describe, expect, it } from "vitest";

describe("runtime pins per role (Jan, 2026-09-24)", () => {
  it("pins the planner and the executor of each workspace", async () => {
    const { rolePolicy } = await import("@/lib/server/env");
    expect(rolePolicy("One", "planner")).toMatchObject({ adapter: "claude-code", model: "claude-opus-5-5", effort: "medium" });
    expect(rolePolicy("One", "executor")).toMatchObject({ adapter: "claude-code", model: "claude-opus-5-5", effort: "medium" });
    expect(rolePolicy("Studio", "planner")).toMatchObject({ adapter: "codex", model: "gpt-6-astra", modelLabel: "GPT 6 Astra", effort: "medium" });
    expect(rolePolicy("Studio", "executor")).toMatchObject({ adapter: "codex", model: "gpt-6-sol", effort: "medium" });
  });

  it("gives a planner its executor's harness and binary settings", async () => {
    const { rolePolicy } = await import("@/lib/server/env");
    expect(rolePolicy("Studio", "planner").minCodexVersion).toBe(rolePolicy("Studio", "executor").minCodexVersion);
    expect(rolePolicy("One", "planner").claudeBin).toBe(rolePolicy("One", "executor").claudeBin);
  });

  it("maps phases to roles and bounds planning", async () => {
    const { phaseRole, loadConfig } = await import("@/lib/server/env");
    expect(phaseRole("plan")).toBe("planner");
    expect(phaseRole("preview")).toBe("executor");
    expect(phaseRole("execute")).toBe("executor");
    expect(loadConfig().limits.planTimeoutMs).toBe(600000);
  });
});
