import { describe, expect, it } from "vitest";
import { trimConnections } from "@/lib/server/judge/trim";

const c = (platform: string, name: string, state = "operational") => ({ platform, name, key: `k-${name}`, state, access: null });
const conns = [c("exa", "Main Exa"), c("gmail", "Main Riley"), c("slack", "Main Slack"), c("stripe", "Main Stripe"), c("notion", "Main Notion", "failed")];
const u = { model: "m", platforms: { exa: 0.97, gmail: 0.04, slack: 0.02, stripe: 0.01 }, mailRole: { choice: "find_address", confidence: 0.9 }, complexity: { score: 0, confidence: 1, single: 1 }, sideEffects: 0, relevance: { "Main Exa": 0.9, "Main Riley": 0.05, "Main Slack": 0.03, "Main Stripe": 0.01, "Main Notion": 0.02 }, recordIds: { uses: {}, mailRole: null, trim: {} } };
const live = { key: "trim.connection" as const, mode: "live" as const, version: 1, model: "m", threshold: 0.8, live: true };

describe("D4 trim", () => {
  it("drops clearly irrelevant connections but keeps protected ones", () => {
    const r = trimConnections(conns, { u, g: live, request: "Using Main Exa, check Main Slack too", keep: ["Main Riley"] });
    expect(r.kept.map((x) => x.name)).toEqual(["Main Exa", "Main Riley", "Main Slack", "Main Notion"]);
    expect(r.dropped).toEqual(["Main Stripe"]);
  });
  it("keeps everything when the gate is not live or there is no judgment", () => {
    expect(trimConnections(conns, { u, g: { ...live, live: false }, request: "x", keep: [] }).dropped).toEqual([]);
    expect(trimConnections(conns, { u: null, g: live, request: "x", keep: [] }).kept).toHaveLength(5);
  });
});
