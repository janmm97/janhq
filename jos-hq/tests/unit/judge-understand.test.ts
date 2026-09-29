import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useJudgeConfig } from "./fixtures/judge";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-judge-und-"));
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
process.env.JOS_HQ_JOS_ROOT = path.join(tmp, "JOS");

const h = vi.hoisted(() => ({ lastQuestions: {} as Record<string, unknown>, lastState: null as unknown, answer: (_q: Record<string, { type: string; instructions: unknown }>) => ({}) as Record<string, unknown> }));
vi.mock("@/lib/server/judge/client", () => ({
  systemOne: vi.fn(async (o: { state: unknown; questions: Record<string, { type: string; instructions: unknown }> }) => {
    h.lastQuestions = o.questions;
    h.lastState = o.state;
    return { ok: true, model: "jev-1.13.0", answers: h.answer(o.questions), callId: 1 };
  }),
}));

const c = (platform: string, name: string) => ({ platform, name, key: `live::${platform}::default::${name.replace(/\W/g, "")}`, state: "operational", access: null });
const ONE = [c("gmail", "Acme Riley"), c("gmail", "Main Riley"), c("gmail", "Main Support"), c("gmail", "Main Operator"), c("gmail", "Acme Support"), c("exa", "Main Exa"), c("tavily", "Main Tavily")];

/** Canned Jev for the 2026-09-29 Exa request: exa needed, gmail not; an address to find; one lookup. */
function exaAnswers(q: Record<string, { type: string; instructions: unknown }>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) {
    const text = String(v.instructions);
    if (k.startsWith("uses_")) out[k] = { type: "noul", noul: /\bexa\b/.test(text) ? 0.97 : 0.04 };
    else if (k.startsWith("rel_")) out[k] = { type: "noul", noul: /Main Exa|Main Tavily/.test(text) ? 0.9 : 0.05 };
  }
  out.mail_role = { type: "choice", choice: "find_address", probabilities: { operate_mailbox: 0.04, find_address: 0.95, no_mail: 0.01, other: 0 }, confidence: 0.93 };
  out.complexity = { type: "score", score: 0.1, probabilities: { "0": 0.92, "1": 0.07, "2": 0.01, "3": 0 }, confidence: 0.9 };
  out.side_effects = { type: "noul", noul: 0.03 };
  return out;
}

describe("D1 understand", () => {
  it("question keys are index-based and names round-trip", async () => {
    const { understandQuestions } = await import("@/lib/server/judge/understand");
    const { toolsFor } = await import("@/lib/server/judge/catalog");
    const tools = toolsFor([c("gmail", 'Acme "Riley" (old)'), c("exa", "Main Exa")]);
    const q = understandQuestions(tools);
    expect(Object.keys(q.questions).every((k) => /^[a-z_0-9]+$/.test(k))).toBe(true);
    expect(Object.values(q.relKeys)).toEqual(['Acme "Riley" (old)', "Main Exa"]);
    expect(Object.values(q.platformKeys).sort()).toEqual(["exa", "gmail"]);
  });

  it("reads the Exa request as exa-not-gmail and an address to find", async () => {
    useJudgeConfig(tmp, { "understand.uses": { mode: "live", threshold: 0.8 }, "understand.mail_role": { mode: "live", threshold: 0.9 } });
    h.answer = exaAnswers;
    const { understand, impliedFromJudge, mailboxVerdict } = await import("@/lib/server/judge/understand");
    const { gate } = await import("@/lib/server/judge/gates");
    const u = (await understand({ taskId: "jos_exa", request: "Using Main Exa, find Jordan Lee email from his company Tailspin", conversation: null, conns: { One: ONE, "Studio": [] } }))!;
    expect(u.platforms.exa).toBeCloseTo(0.97);
    expect(impliedFromJudge(["gmail", "exa"], u, gate("understand.uses"), ["gmail", "exa", "tavily"]).platforms).toEqual(["exa"]);
    expect(mailboxVerdict(u, gate("understand.mail_role"))).toBe("skip");
  });

  it("falls back to the regex and to today's mailbox rule when gates are not live", async () => {
    useJudgeConfig(tmp, { "understand.uses": { mode: "shadow" }, "understand.mail_role": { mode: "shadow" } });
    h.answer = exaAnswers;
    const { understand, impliedFromJudge, mailboxVerdict } = await import("@/lib/server/judge/understand");
    const { gate } = await import("@/lib/server/judge/gates");
    const u = await understand({ taskId: "jos_exa2", request: "Using Main Exa, find Jordan Lee email", conversation: null, conns: { One: ONE, "Studio": [] } });
    expect(impliedFromJudge(["gmail", "exa"], u, gate("understand.uses"), ["gmail", "exa"])).toMatchObject({ platforms: ["gmail", "exa"], acted: false });
    expect(mailboxVerdict(u, gate("understand.mail_role"))).toBeNull();
  });

  it("records uses only where Jev disagrees with the keywords, one row for mail_role and only drops for trim", async () => {
    useJudgeConfig(tmp, { "understand.uses": { mode: "shadow" } });
    h.answer = exaAnswers;
    const { understand } = await import("@/lib/server/judge/understand");
    const { taskRecords } = await import("@/lib/server/judge/records");
    // Keywords: gmail ("email") and exa. Jev: exa yes (agrees), gmail no (a "remove"), tavily no (agrees).
    await understand({ taskId: "jos_rec", request: "Using Main Exa, find Jordan Lee email from his company Tailspin", conversation: null, conns: { One: ONE, "Studio": [] } });
    const rows = taskRecords("jos_rec");
    const uses = rows.filter((r) => r.gate === "understand.uses");
    expect(uses.map((r) => [r.subject, r.predicted])).toEqual([["gmail", "remove"]]);
    expect(uses[0].score).toBeCloseTo(0.96);
    // No keyword platforms at all: Jev's exa is an "add", scored by its own confidence.
    await understand({ taskId: "jos_rec_add", request: "find x", conversation: null, conns: { One: ONE, "Studio": [] } });
    const adds = taskRecords("jos_rec_add").filter((r) => r.gate === "understand.uses");
    expect(adds.map((r) => [r.subject, r.predicted])).toEqual([["exa", "add"]]);
    expect(adds[0].score).toBeCloseTo(0.97);
    expect(rows.filter((r) => r.gate === "understand.mail_role")).toHaveLength(1);
    expect(rows.filter((r) => r.gate === "trim.connection").every((r) => r.predicted === "drop")).toBe(true);
    expect(rows.filter((r) => r.gate === "trim.connection").map((r) => r.subject)).not.toContain("Main Exa");
  });

  it("never skips the mailbox question for a task Jev reads as having side effects", async () => {
    useJudgeConfig(tmp, { "understand.mail_role": { mode: "live", threshold: 0.9 } });
    h.answer = (q) => ({ ...exaAnswers(q), side_effects: { type: "noul", noul: 0.7 } });
    const { understand, mailboxVerdict } = await import("@/lib/server/judge/understand");
    const { gate } = await import("@/lib/server/judge/gates");
    const u = await understand({ taskId: "jos_se", request: "Find Jordan's email and send him the deck", conversation: null, conns: { One: ONE, "Studio": [] } });
    expect(mailboxVerdict(u, gate("understand.mail_role"))).toBeNull();
  });

  it("sends at most 4000 characters of the request", async () => {
    useJudgeConfig(tmp, { "understand.uses": { mode: "shadow" } });
    h.answer = exaAnswers;
    const { understand } = await import("@/lib/server/judge/understand");
    await understand({ taskId: "jos_long", request: "x".repeat(9000), conversation: null, conns: { One: ONE, "Studio": [] } });
    expect((h.lastState as { request: string }).request).toHaveLength(4000);
  });

  it("returns null and records nothing when mail_role lacks confidence", async () => {
    useJudgeConfig(tmp, { "understand.uses": { mode: "shadow" } });
    h.answer = (q) => {
      const a = exaAnswers(q);
      a.mail_role = { type: "choice", choice: "find_address", probabilities: { operate_mailbox: 0.04, find_address: 0.95, no_mail: 0.01, other: 0 } };
      return a;
    };
    const { understand } = await import("@/lib/server/judge/understand");
    const { taskRecords } = await import("@/lib/server/judge/records");
    const u = await understand({ taskId: "jos_malformed", request: "find x", conversation: null, conns: { One: ONE, "Studio": [] } });
    expect(u).toBeNull();
    const rows = taskRecords("jos_malformed");
    expect(rows).toEqual([]);
  });
});
