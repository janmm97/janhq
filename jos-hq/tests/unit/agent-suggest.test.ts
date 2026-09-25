import { describe, expect, it } from "vitest";
import { suggestFrom, suggestName, type SuggestConnection } from "@/lib/server/agent-suggest";

const ONE: SuggestConnection[] = [
  { platform: "gmail", name: "Main Operator", state: "operational" },
  { platform: "gmail", name: "Main Support", state: "operational" },
  { platform: "gmail", name: "Acme Riley", state: "operational" },
  { platform: "gmail", name: "Acme Support", state: "operational" },
  { platform: "slack", name: "Main Slack", state: "operational" },
  { platform: "exa", name: "Main Exa", state: "degraded" },
];
const suggest = (purpose: string, name = "", taken: (k: string) => boolean = () => false) => suggestFrom({ workspace: "One", purpose, name }, ONE, null, taken);

describe("New agent suggestions", () => {
  it("pre-ticks a connection the purpose names, and asks nothing more about its platform", () => {
    const s = suggest("Triage the Main Support inbox and draft replies");
    expect(s.picks).toEqual([{ platform: "gmail", name: "Main Support", reason: "named", why: '"Main Support" is named in the purpose' }]);
    expect(s.ask).toEqual([]);
  });

  it("leaves out a connection the purpose names only to rule it out", () => {
    expect(suggest("Summarise the day's Slack threads; never use Main Support").picks).toEqual([{ platform: "slack", name: "Main Slack", reason: "only", why: "the purpose implies Slack, and One has one Slack connection" }]);
  });

  it("ticks the only connection of a platform the purpose implies, whatever its state", () => {
    expect(suggest("Research companies with Exa").picks).toEqual([{ platform: "exa", name: "Main Exa", reason: "only", why: "the purpose implies Exa, and One has one Exa connection" }]);
  });

  it("asks which one when the purpose implies a platform with several connections and names none", () => {
    const s = suggest("Draft replies to customer emails");
    expect(s.picks).toEqual([]);
    expect(s.ask).toEqual([{ platform: "gmail", label: "Gmail", question: "Which one? One has 4 Gmail connections.", options: ONE.filter((c) => c.platform === "gmail") }]);
  });

  it("names implied platforms the workspace has not connected", () => {
    expect(suggest("Refund duplicate Stripe charges").missing).toEqual(["Stripe"]);
  });

  it("suggests a name from the purpose's first content words and previews its key", () => {
    expect(suggestName("Triage the Main Support inbox and draft replies")).toBe("triage main support");
    expect(suggest("Triage the Main Support inbox and draft replies").name).toEqual({ input: "", suggested: "triage main support", key: "one_triage_main_support", valid: true, free: true });
    expect(suggest("x", "Contract reviewer!").name.key).toBe("one_contract_reviewer");
  });

  it("says when the key is taken", () => {
    expect(suggest("Triage support", "support triage", (k) => k === "one_support_triage").name).toMatchObject({ key: "one_support_triage", free: false });
  });

  it("never offers a connection that has no name, which SOP.md could not name", () => {
    const s = suggestFrom({ workspace: "One", purpose: "Research with Exa", name: "" }, [...ONE, { platform: "serp-api", state: "operational" } as unknown as SuggestConnection], null, () => false);
    expect(s.connections.map((c) => c.platform)).not.toContain("serp-api");
    expect(s.connections).toHaveLength(ONE.length);
  });
});
