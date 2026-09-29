import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { jevCheck, jevHealth } from "@/lib/server/health";
import { useJudgeConfig } from "./fixtures/judge";

vi.mock("@/lib/server/judge/records", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/judge/records")>()),
  callStats: vi.fn(() => {
    throw new Error("judge_calls table unavailable");
  }),
}));

const base = { configured: true, key: "k", breakerOpen: false, failures24h: 0, calls24h: 12, lastModel: "jev-1.13.0", pin: "jev-1.13.0", undescribed: [] as string[] };

describe("Jev health check", () => {
  it("passes when configured, keyed, closed and on the pinned model", () => {
    expect(jevCheck(base)).toMatchObject({ id: "root.jev", status: "pass", blocking: false });
  });
  it.each([
    ["no key", { key: null }, /no operational TypeSafe/],
    ["breaker open", { breakerOpen: true }, /paused/],
    ["model changed", { lastModel: "jev-1.14.0" }, /model/],
    ["undescribed", { undescribed: ["zoho"] }, /zoho/],
    ["a reverted gate", { reverted: ["understand.mail_role (recent accuracy 0.800 fell below target 0.95)"] }, /reverted to shadow by the tuner: understand\.mail_role/],
  ])("warns on %s", (_l, over, re) => {
    const c = jevCheck({ ...base, ...over })!;
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(re);
  });
  it("is absent when the judge is not configured", () => {
    expect(jevCheck({ ...base, configured: false })).toBeNull();
  });
});

describe("Jev health isolation", () => {
  it("returns a warn check instead of throwing when judge telemetry (callStats) throws", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-judge-health-"));
    useJudgeConfig(tmp, { "understand.uses": { mode: "auto" } });
    // Calling jevHealth directly (rather than not.toThrow(() => ...)) is itself the proof: if the
    // judge block were unguarded, this call — not just healthReport's — would throw and fail the test.
    const result = jevHealth(null, null, null);
    expect(result).toMatchObject({ id: "root.jev", status: "warn", blocking: false });
    expect(result?.detail).toMatch(/judge layer status unavailable/);
    expect(result?.detail).toMatch(/judge_calls table unavailable/);
  });
});
