import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useJudgeConfig } from "./fixtures/judge";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-judge-client-"));
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
process.env.JOS_HQ_JOS_ROOT = path.join(tmp, "JOS");

const h = vi.hoisted(() => ({
  rootConns: [{ platform: "typesafe", key: "live::typesafe::default::root", name: "hq-jev", state: "operational", access: null }] as Array<Record<string, unknown>>,
  calls: [] as string[][],
  reply: null as null | ((args: string[]) => unknown),
}));
vi.mock("@/lib/server/one/discovery", async (orig) => ({ ...(await orig<typeof import("@/lib/server/one/discovery")>()), listConnections: vi.fn(async () => ({ connections: h.rootConns, error: null })) }));
vi.mock("@/lib/server/one/cli", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/one/cli")>()),
  runOneReadOnly: vi.fn(async (_scope: string, args: string[]) => {
    h.calls.push(args);
    return h.reply!(args);
  }),
}));
vi.mock("@/lib/server/issues", () => ({
  scrubTerms: vi.fn(async () => ({
    people: ["Jordan Lee"],
    companies: ["Tailspin"],
    accounts: [],
    connections: [{ name: "Main Exa", platform: "exa" }],
  })),
}));

const Q = { a: { type: "noul" as const, instructions: "Is `x` true?" }, b: { type: "choice" as const, instructions: "Pick", criteria: { p: "P", q: "Q" } } };
const good = { ok: true, json: { response: { model: "jev-1.13.0", answers: { a: { type: "noul", noul: 0.9 }, b: { type: "choice", choice: "p", probabilities: { p: 0.9, q: 0.1 }, confidence: 0.85 } }, usage: { input_tokens: 42, output_tokens: 3 } } }, code: 0, stderr: "", durationMs: 90 };

beforeEach(async () => {
  useJudgeConfig(tmp, { "understand.uses": { mode: "auto" } });
  h.calls.length = 0;
  h.rootConns = [{ platform: "typesafe", key: "live::typesafe::default::root", name: "hq-jev", state: "operational", access: null }];
  (await import("@/lib/server/judge/client")).resetJudgeClient();
});

describe("systemOne", () => {
  it("calls the root TypeSafe connection with the pinned model and returns typed answers", async () => {
    h.reply = () => good;
    const { systemOne } = await import("@/lib/server/judge/client");
    const r = await systemOne({ taskId: "jos_x", decision: "understand", state: { request: "hi" }, questions: Q });
    expect(r).toMatchObject({ ok: true, model: "jev-1.13.0" });
    const [args] = h.calls;
    expect(args.slice(0, 6)).toEqual(["--agent", "actions", "execute", "typesafe", "conn_mod_def::GNh4bXcHPaU::V2ndvy5CQJmYHvkElwVM_w", "live::typesafe::default::root"]);
    expect(JSON.parse(args[7])).toMatchObject({ model: "jev-1.13.0", state: { request: "hi" } });
  });
  it("client rejects incomplete answers", async () => {
    h.reply = () => ({ ...good, json: { response: { ...good.json.response, answers: { a: good.json.response.answers.a } } } });
    const { systemOne } = await import("@/lib/server/judge/client");
    expect(await systemOne({ taskId: null, decision: "understand", state: "x", questions: Q })).toMatchObject({ ok: false, error: expect.stringMatching(/missing or wrong type: b/) });
  });
  it("model mismatch is a failure", async () => {
    h.reply = () => ({ ...good, json: { response: { ...good.json.response, model: "jev-1.14.0" } } });
    const { systemOne } = await import("@/lib/server/judge/client");
    expect(await systemOne({ taskId: null, decision: "understand", state: "x", questions: Q })).toMatchObject({ ok: false, error: expect.stringMatching(/model changed/) });
  });
  it("no root key → fails without executing", async () => {
    h.rootConns = [{ platform: "typesafe", key: "live::typesafe::default::root", name: "hq-jev", state: "failed", access: null }];
    h.reply = () => good;
    const { systemOne } = await import("@/lib/server/judge/client");
    expect(await systemOne({ taskId: null, decision: "understand", state: "x", questions: Q })).toMatchObject({ ok: false, error: expect.stringMatching(/no operational TypeSafe/) });
    expect(h.calls).toEqual([]);
  });
  it("redacts secret-shaped strings from state before it leaves the process", async () => {
    h.reply = () => good;
    const { systemOne } = await import("@/lib/server/judge/client");
    const secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    await systemOne({ taskId: null, decision: "understand", state: { request: `use key ${secret} now` }, questions: Q });
    const [args] = h.calls;
    expect(args[7]).not.toContain(secret);
    expect(args[7]).toContain("sk-ant-***REDACTED***");
  });
  it("scrubs public terms from state when judge.scrub is on, but leaves connection names alone", async () => {
    useJudgeConfig(tmp, { "understand.uses": { mode: "auto" } }, { scrub: true });
    h.reply = () => good;
    const { systemOne } = await import("@/lib/server/judge/client");
    await systemOne({ taskId: null, decision: "understand", state: { request: "Jordan Lee at Tailspin uses Main Exa" }, questions: Q });
    const [args] = h.calls;
    expect(args[7]).not.toContain("Jordan Lee");
    expect(args[7]).not.toContain("Tailspin");
    expect(args[7]).toContain("Main Exa");
  });
  it("retries when the parsed envelope nests a rate-limit error although the CLI call itself is ok", async () => {
    let n = 0;
    h.reply = () => (n++ === 0 ? { ok: true, json: { response: { error: "429 Too Many Requests" } }, code: 0, stderr: "", durationMs: 5 } : good);
    const { systemOne } = await import("@/lib/server/judge/client");
    const r = await systemOne({ taskId: null, decision: "understand", state: "x", questions: Q });
    expect(r).toMatchObject({ ok: true, model: "jev-1.13.0" });
    expect(h.calls.length).toBe(2);
  });
  it("retries once on 429 and opens the breaker after 3 failures", async () => {
    let n = 0;
    h.reply = () => (n++ === 0 ? { ok: false, json: { error: "429 Too Many Requests" }, code: 1, stderr: "", durationMs: 5, error: "429 Too Many Requests" } : good);
    const { systemOne, breakerState } = await import("@/lib/server/judge/client");
    expect((await systemOne({ taskId: null, decision: "understand", state: "x", questions: Q })).ok).toBe(true);
    expect(h.calls.length).toBe(2);
    h.reply = () => ({ ok: false, json: undefined, code: null, stderr: "", durationMs: 5, error: "timed out after 8000 ms" });
    for (let i = 0; i < 3; i++) await systemOne({ taskId: null, decision: "understand", state: "x", questions: Q });
    expect(breakerState().open).toBe(true);
    const before = h.calls.length;
    expect(await systemOne({ taskId: null, decision: "understand", state: "x", questions: Q })).toMatchObject({ ok: false, error: "circuit open" });
    expect(h.calls.length).toBe(before);
  });
  it("rejects malformed choice answer (missing confidence)", async () => {
    h.reply = () => ({ ...good, json: { response: { ...good.json.response, answers: { a: good.json.response.answers.a, b: { type: "choice", choice: "p", probabilities: { p: 0.9, q: 0.1 } } } } } });
    const { systemOne } = await import("@/lib/server/judge/client");
    expect(await systemOne({ taskId: null, decision: "understand", state: "x", questions: Q })).toMatchObject({ ok: false, error: expect.stringMatching(/malformed answers/) });
  });
  it("rejects malformed noul answer (string instead of number)", async () => {
    h.reply = () => ({ ...good, json: { response: { ...good.json.response, answers: { a: { type: "noul", noul: "0.9" }, b: good.json.response.answers.b } } } });
    const { systemOne } = await import("@/lib/server/judge/client");
    expect(await systemOne({ taskId: null, decision: "understand", state: "x", questions: Q })).toMatchObject({ ok: false, error: expect.stringMatching(/malformed answers/) });
  });
  it("treats a choice question whose own criteria is not an object as malformed, without throwing", async () => {
    h.reply = () => good;
    const { systemOne } = await import("@/lib/server/judge/client");
    const badQ = { a: Q.a, b: { type: "choice" as const, instructions: "Pick", criteria: "x" as unknown as Record<string, string> } };
    await expect(systemOne({ taskId: null, decision: "understand", state: "x", questions: badQ })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/malformed answers/) });
  });
});
