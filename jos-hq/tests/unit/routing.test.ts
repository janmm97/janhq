import { describe, expect, it } from "vitest";
import { detectEntities, detectExplicit, impliedPlatforms, mailboxQuestion, routeRequest } from "@/lib/server/routing";
import type { ConnectionInfo, FlowInfo } from "@/lib/server/one/discovery";

const c = (platform: string, name: string, state = "operational"): ConnectionInfo => ({ platform, name, key: `live::${platform}::default::${name.replace(/\W/g, "")}`, state, access: { policy: "full" } });

// The split measured on 2026-09-23 (CLAUDE.md §2 step 3).
const LIVE: Record<"One" | "Studio", ConnectionInfo[]> = {
  One: [c("gmail", "Main Operator"), c("gmail", "Main Support"), c("gmail", "Acme Riley"), c("gmail", "Acme Support"), c("slack", "Main Slack"), c("stripe", "Main Stripe"), c("notion", "Main Notion"), c("open-router", "Main OpenRouter"), c("firecrawl", "Main Firecrawl"), c("tavily", "Main Tavily"), c("exa", "Main Exa")],
  "Studio": [c("google-drive", "Studio Drive"), c("google-calendar", "Studio Calendar"), c("gmail", "Studio gmail"), c("notion", "Studio Notion"), c("open-router", "Studio OpenRouter"), c("firecrawl", "Studio Firecrawl"), c("tavily", "Studio Tavily"), c("exa", "Studio Exa")],
};

function inputs(text: string, selection: "auto" | "One" | "Studio" = "auto", flows: Record<"One" | "Studio", FlowInfo[]> = { One: [], "Studio": [] }) {
  return { text, selection, flows: async () => flows, connections: async () => LIVE };
}

describe("routing precedence", () => {
  it("explicit selector wins even over a named entity from the other business", async () => {
    const d = await routeRequest(inputs("Send Riley the scorecard", "Studio"));
    expect(d).toMatchObject({ kind: "routed", workspace: "Studio", step: "explicit", reason: "Explicit user selection" });
  });

  it("explicit phrase wins over an incidental name (contract example)", async () => {
    const d = await routeRequest(inputs("Use Studio to review the material from Devin"));
    expect(d.kind).toBe("routed");
    expect(d.workspace).toBe("Studio");
    expect(d.step).toBe("explicit");
  });

  it("names beat topics: 'Send Riley the scorecard' routes to One", async () => {
    const d = await routeRequest(inputs("Send Riley the scorecard"));
    expect(d).toMatchObject({ kind: "routed", workspace: "One", step: "entity" });
    expect(d.reason).toContain("Riley");
  });

  it("matching is case-insensitive and handles possessives", async () => {
    expect((await routeRequest(inputs("what did DEVIN's team decide"))).workspace).toBe("One");
    expect((await routeRequest(inputs("summarize nwp notes"))).workspace).toBe("Studio");
    expect((await routeRequest(inputs("Blake's calendar next week"))).workspace).toBe("Studio");
  });

  it("names from both businesses ask instead of picking the first keyword", async () => {
    const d = await routeRequest(inputs("Send Blake the contract Riley drafted"));
    expect(d.kind).toBe("clarify");
    expect(d.question).toMatch(/Riley/);
    expect(d.question).toMatch(/Blake/);
    expect(d.options?.map((o) => o.value)).toEqual(["One", "Studio", "none"]);
  });

  it("a named flow that exists in exactly one workspace is decisive", async () => {
    const flows = { One: [], "Studio": [{ key: "weekly-kpi-digest", name: "Weekly KPI digest", description: null, raw: {} }] };
    const d = await routeRequest(inputs("run weekly-kpi-digest now", "auto", flows));
    expect(d).toMatchObject({ kind: "routed", workspace: "Studio", step: "flow" });
  });

  it("topic signals route when no name is present", async () => {
    expect(await routeRequest(inputs("update the KPI conditional formatting"))).toMatchObject({ workspace: "Studio", step: "topic" });
    expect(await routeRequest(inputs("prepare the SOC 2 evidence list"))).toMatchObject({ workspace: "One", step: "topic" });
  });

  it("a shared platform named as a topic is not decisive (Gmail exists in both)", async () => {
    const d = await routeRequest(inputs("Summarize my unread email from today"));
    expect(d.kind).toBe("clarify");
    expect(d.question).toMatch(/both One and Studio/);
  });

  it("live connection lookup settles exclusive platforms", async () => {
    expect(await routeRequest(inputs("post the release note in slack"))).toMatchObject({ workspace: "One", step: "connection" });
    expect(await routeRequest(inputs("refund the last stripe payment"))).toMatchObject({ workspace: "One", step: "connection" });
    expect(await routeRequest(inputs("find the budget file in google drive"))).toMatchObject({ workspace: "Studio", step: "connection" });
    expect(await routeRequest(inputs("schedule a meeting on the calendar for Tuesday"))).toMatchObject({ workspace: "Studio", step: "connection" });
  });

  it("platforms split across workspaces cannot be done by one executor, so it asks", async () => {
    const d = await routeRequest(inputs("copy the google drive file into a slack message"));
    expect(d.kind).toBe("clarify");
    expect(d.reason).toMatch(/different workspaces/);
  });

  it("nothing identifying asks with the evidence, never guesses", async () => {
    const d = await routeRequest(inputs("tidy up my notes"));
    expect(d.kind).toBe("clarify");
    expect(d.question).toMatch(/One or Studio/);
  });

  it("tool names are not topics (Jan, 2026-09-23): Gmail, Notion and Google Sheets alone ask", async () => {
    for (const text of ["Check my Gmail", "update the notion page about onboarding", "update the Google Sheets tracker"]) {
      const d = await routeRequest(inputs(text));
      expect(d.kind, text).toBe("clarify");
      expect(d.signals.some((s) => s.step === "topic"), text).toBe(false);
    }
  });

  it("a tool routes only through the connection lookup, when exactly one account has it", async () => {
    const d = await routeRequest({
      text: "check my gmail",
      selection: "auto",
      flows: async () => ({ One: [], "Studio": [] }),
      connections: async () => ({ One: [c("gmail", "Main Operator")], "Studio": [] }),
    });
    expect(d).toMatchObject({ kind: "routed", workspace: "One", step: "connection" });
  });

  it("TEST 9: 'Send this from Gmail' picks neither the business nor a One mailbox", async () => {
    const d = await routeRequest(inputs("Send this from Gmail"));
    expect(d.kind).toBe("clarify");
    expect(d.question).toMatch(/both One and Studio/);
    expect(mailboxQuestion("Send this from Gmail", "One", LIVE.One)?.options).toEqual(["Main Operator", "Main Support", "Acme Riley", "Acme Support"]);
  });

  it("the connection lookup is live: routing reflects the lists it is given", async () => {
    let calls = 0;
    const d = await routeRequest({
      text: "post the release note in slack",
      selection: "auto",
      flows: async () => ({ One: [], "Studio": [] }),
      connections: async () => {
        calls++;
        return { One: [], "Studio": [c("slack", "Studio Slack")] };
      },
    });
    expect(calls).toBe(1);
    expect(d.workspace).toBe("Studio");
  });
});

describe("semantic entity rules for 'One' and 'Studio'", () => {
  it("ordinary uses of 'one' and 'Studio' are not entities", () => {
    expect(detectEntities("send me one report").one).toEqual([]);
    expect(detectEntities("One of the emails bounced").one).toEqual([]);
    expect(detectEntities("we have Studio emails and $226 of spend").studio).toEqual([]);
    expect(detectEntities("page Studio of the manual").studio).toEqual([]);
  });

  it("entity uses count", () => {
    expect(detectEntities("ask the One team about hiring").one).toContain("One");
    expect(detectEntities("For One, draft the MSA").one).toContain("One");
    expect(detectEntities("One's roadmap").one).toContain("One");
    expect(detectEntities("check the Studio Drive folder").studio).toContain("Studio");
    expect(detectEntities("send it to Studio").studio).toContain("Studio");
    expect(detectEntities("Northwind Partners quarterly report").studio).toContain("Northwind Partners");
    expect(detectEntities("Studio Publishing catalogue").studio).toContain("Studio Publishing");
  });

  it("names are word-bounded, not substrings", () => {
    expect(detectEntities("the handy sidebar").one).toEqual([]);
    expect(detectEntities("the handy sidebar").studio).toEqual([]);
  });

  it("explicit phrases", () => {
    expect(detectExplicit("please use the One executor to check this")).toBe("One");
    expect(detectExplicit("route this to Studio")).toBe("Studio");
    expect(detectExplicit("use one template for all of them")).toBe(null);
  });
});

describe("negation and mailbox intent", () => {
  it("a negated platform mention does not imply the platform", () => {
    expect(impliedPlatforms("Use only connection list; do not read any mailbox, channel, page or record.")).not.toContain("gmail");
    expect(impliedPlatforms("summarize my inbox")).toContain("gmail");
  });

  it("the One mailbox question needs real mail intent and several mailboxes", () => {
    expect(mailboxQuestion("Email Devin the signed MSA", "One", LIVE.One)?.options).toEqual(["Main Operator", "Main Support", "Acme Riley", "Acme Support"]);
    expect(mailboxQuestion("Email Devin the signed MSA from Main Support", "One", LIVE.One)).toBeNull();
    expect(mailboxQuestion("report connections; do not read any mailbox", "One", LIVE.One)).toBeNull();
    expect(mailboxQuestion("summarize unread email", "Studio", LIVE["Studio"])).toBeNull(); // one mailbox only
  });
});
