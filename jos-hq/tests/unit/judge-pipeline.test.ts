import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rawPlan } from "./fixtures/plans";
import { useJudgeConfig } from "./fixtures/judge";
import { systemOne } from "@/lib/server/judge/client";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-judge-pipe-"));
const josRoot = path.join(tmp, "JOS");
process.env.JOS_HQ_JOS_ROOT = josRoot;
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");
for (const d of ["One", "Studio", ".claude/agents", ".codex/agents"]) fs.mkdirSync(path.join(josRoot, d), { recursive: true });
Object.assign(globalThis, { __josOneCli: { ok: false, shim: null, cliJs: null, node: process.execPath, version: null, error: "One CLI disabled in unit tests" }, __josOneCliAt: Number.MAX_SAFE_INTEGER });

const h = vi.hoisted(() => {
  const c = (platform: string, name: string) => ({ platform, name, key: `live::${platform}::default::${name.replace(/\W/g, "")}`, state: "operational", access: null });
  return {
    CONNS: {
      One: [c("gmail", "Acme Riley"), c("gmail", "Main Riley"), c("gmail", "Main Support"), c("gmail", "Main Operator"), c("gmail", "Acme Support"), c("exa", "Main Exa")],
      "Studio": [c("gmail", "Studio gmail"), c("exa", "Studio Exa")],
      root: [c("typesafe", "hq-jev")],
    } as Record<string, unknown[]>,
    calls: [] as Array<{ phase: string; prompt: string }>,
    script: [] as Array<(c: { phase: string; prompt: string }) => unknown>,
    jev: null as null | ((q: Record<string, { instructions: unknown }>) => Record<string, unknown>),
    /** Set to make the mocked systemOne throw instead of returning a result, to exercise the fallback. */
    throwJev: null as string | null,
    /** Set to make the fast-path decision throw instead of deciding, to exercise stagePlan's fail-safe. */
    throwFastpath: null as string | null,
    /** Set to make findCandidates throw, to exercise logCheckJudged's fail-safe (D3). */
    throwFindCandidates: null as string | null,
    /** Set to make the trim.connection gate throw, to exercise promptConnections' fail-safe (D4). */
    throwTrim: null as string | null,
  };
});
vi.mock("@/lib/server/one/discovery", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/one/discovery")>()),
  listConnections: vi.fn(async (scope: string) => ({ connections: h.CONNS[scope], error: null })),
  listFlows: vi.fn(async () => ({ flows: [], error: null })),
}));
vi.mock("@/lib/server/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/identity")>()),
  verifyIdentity: vi.fn(async (scope: string) => ({ scope, ok: true, expected: { projectRoot: "", email: "", org: null }, actual: { projectRoot: `C:\\JOS\\${scope}`, email: "one-operator@example.com", org: null, name: null, keyName: null }, problems: [], warnings: [], checkedAt: "" })),
}));
vi.mock("@/lib/server/judge/client", () => ({
  systemOne: vi.fn(async (o: { questions: Record<string, { instructions: unknown }> }) => {
    if (h.throwJev) throw new Error(h.throwJev);
    return h.jev ? { ok: true, model: "jev-1.13.0", answers: h.jev(o.questions), callId: 1 } : { ok: false, error: "off", callId: null };
  }),
  breakerState: () => ({ open: false, until: null, failures: 0 }),
  rootJevKey: async () => "live::typesafe::default::janhqjev",
}));
vi.mock("@/lib/server/memory", async (orig) => {
  const actual = await orig<typeof import("@/lib/server/memory")>();
  return {
    ...actual,
    findCandidates: (...args: Parameters<typeof actual.findCandidates>) => {
      if (h.throwFindCandidates) throw new Error(h.throwFindCandidates);
      return actual.findCandidates(...args);
    },
  };
});
vi.mock("@/lib/server/judge/gates", async (orig) => {
  const actual = await orig<typeof import("@/lib/server/judge/gates")>();
  return {
    ...actual,
    gate: (key: Parameters<typeof actual.gate>[0]) => {
      if (h.throwTrim && key === "trim.connection") throw new Error(h.throwTrim);
      return actual.gate(key);
    },
  };
});
vi.mock("@/lib/server/judge/fastpath", async (orig) => {
  const actual = await orig<typeof import("@/lib/server/judge/fastpath")>();
  return {
    ...actual,
    decideFastPath: (o: Parameters<typeof actual.decideFastPath>[0]) => {
      if (h.throwFastpath) throw new Error(h.throwFastpath);
      return actual.decideFastPath(o);
    },
  };
});
vi.mock("@/lib/server/dispatch", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/dispatch")>()),
  assertRuntimeReady: vi.fn(async () => ({ ok: true })),
  dispatch: vi.fn(async (req: { phase: string; prompt: string }) => {
    const call = { phase: req.phase, prompt: req.prompt };
    h.calls.push(call);
    const next = h.script.shift();
    const executionId = `exe_${h.calls.length}`;
    const exit = next ? await next(call) : { plan: null, structured: null, error: "no scripted outcome" };
    return { executionId, identity: {}, done: Promise.resolve({ executionId, status: "exited", exit: { code: 0, timedOut: false, killed: false, resultText: null, durationMs: 1, structured: null, plan: null, error: null, ...(exit as object) }, verification: { ok: true, model: "m", effort: "medium", cwd: "", mainModels: [] } }) };
  }),
}));

function exaJev(q: Record<string, { instructions: unknown }>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) {
    const text = String(v.instructions);
    if (k.startsWith("uses_")) out[k] = { type: "noul", noul: /\bexa\b/.test(text) ? 0.97 : 0.04 };
    else if (k.startsWith("rel_")) out[k] = { type: "noul", noul: /Exa/.test(text) ? 0.9 : 0.05 };
  }
  out.mail_role = { type: "choice", choice: "find_address", probabilities: { operate_mailbox: 0.04, find_address: 0.95, no_mail: 0.01, other: 0 }, confidence: 0.93 };
  out.complexity = { type: "score", score: 0.1, probabilities: { "0": 0.92, "1": 0.07, "2": 0.01, "3": 0 }, confidence: 0.9 };
  out.side_effects = { type: "noul", noul: 0.03 };
  return out;
}
async function planWith(over: Record<string, unknown> = {}) {
  const { coercePlan } = await import("@/lib/server/executors/plan-schema");
  const r = coercePlan(rawPlan(over));
  if (!r.ok) throw new Error(r.error);
  return r.plan;
}
function done(answer = "Found it.") {
  return { structured: { status: "completed", answer, summary: answer, identity_check: { project_root: "C:\\JOS\\One", email: "one-operator@example.com", passed: true }, proposed_actions: [], artifacts: [], verification: { performed: true, passed: true, method: "read back", evidence: "exa result" }, limitations: [], learned: [], needs_user_input: "" } };
}
async function waitFor(taskId: string, statuses: string[], ms = 15000) {
  const { getTask } = await import("@/lib/server/tasks");
  const end = Date.now() + ms;
  for (;;) {
    const t = getTask(taskId)!;
    if (statuses.includes(t.status)) return t;
    if (Date.now() > end) throw new Error(`task ${taskId} is ${t.status}, waited for ${statuses.join("/")}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
async function send(text: string) {
  const { submitTask } = await import("@/lib/server/orchestrator");
  const { createChat } = await import("@/lib/server/tasks");
  const chat = createChat("t");
  return submitTask({ chatId: chat.id, text, routeSelection: "auto", mode: "auto" });
}
const EXA = "Using Main Exa, find Jordan Lee email from his company Tailspin";

beforeEach(async () => {
  h.calls.length = 0;
  h.script.length = 0;
  h.jev = null;
  h.throwJev = null;
  h.throwFastpath = null;
  h.throwFindCandidates = null;
  h.throwTrim = null;
  vi.mocked(systemOne).mockClear();
  // The orchestrator opens a log entry before planning (CLAUDE.md §14); these must exist to be rewritten.
  fs.writeFileSync(path.join(josRoot, "ONEMEMORY.md"), "# One log\n\n---\n");
  fs.writeFileSync(path.join(josRoot, "STUDIOMEMORY.md"), "# Studio log\n\n---\n");
  fs.writeFileSync(path.join(josRoot, "JOSMEMORY.md"), "# J/OS log\n");
  const { run } = await import("@/lib/server/db");
  for (const t of ["tasks", "executions", "events", "chats", "chat_messages", "approvals", "approval_actions"]) run(`DELETE FROM ${t}`);
});

describe("the 2026-09-29 Exa request", () => {
  it("with judge off, still asks which mailbox (today's behaviour), and never calls Jev", async () => {
    useJudgeConfig(tmp, {});
    h.jev = null;
    const t = await send(EXA);
    const s = await waitFor(t.id, ["needs_clarification"]);
    expect(s.route).toBe("One");
    expect(s.context_json).toContain("Which One mailbox");
    expect(vi.mocked(systemOne).mock.calls.length).toBe(0);
  });
  it("with mail_role live, routes to One and asks no mailbox question", async () => {
    useJudgeConfig(tmp, { "understand.mail_role": { mode: "live", threshold: 0.9 }, "understand.uses": { mode: "shadow" } });
    h.jev = exaJev;
    h.script.push(async () => ({ plan: await planWith() }), async () => done());
    const t = await send(EXA);
    const s = await waitFor(t.id, ["completed", "unverified", "needs_clarification", "failed", "blocked"]);
    expect(s.status).toBe("completed");
    expect(s.route).toBe("One");
    expect(h.calls[0].prompt).toContain("Do not ask which mailbox");
  });
  it("when the judge layer throws, falls back to today's routing and still asks which mailbox", async () => {
    useJudgeConfig(tmp, { "understand.mail_role": { mode: "live", threshold: 0.9 }, "understand.uses": { mode: "shadow" } });
    h.jev = exaJev;
    h.throwJev = "TypeSafe upstream 500";
    const t = await send(EXA);
    const s = await waitFor(t.id, ["needs_clarification", "failed", "blocked"]);
    expect(s.status).toBe("needs_clarification");
    expect(s.route).toBe("One");
    expect(s.context_json).toContain("Which One mailbox");
  });
});

describe("fast path", () => {
  it("skips the planning session for the Exa lookup", async () => {
    useJudgeConfig(tmp, { "understand.mail_role": { mode: "live", threshold: 0.9 }, fastpath: { mode: "live", threshold: 0.8 } });
    h.jev = exaJev;
    h.script.push(async () => done());
    const t = await send(`${EXA} (fast 1)`);
    const s = await waitFor(t.id, ["completed", "unverified", "failed", "blocked", "needs_clarification"]);
    expect(s.status).toBe("completed");
    expect(h.calls.map((c) => c.phase)).toEqual(["preview"]);
    expect(h.calls[0].prompt).toContain("FAST PATH (no planning session)");
    expect(h.calls[0].prompt).toContain('"Main Exa"');
  });
  it("bounce plans once", async () => {
    useJudgeConfig(tmp, { "understand.mail_role": { mode: "live", threshold: 0.9 }, fastpath: { mode: "live", threshold: 0.8 } });
    h.jev = exaJev;
    const bounce = { structured: { ...done().structured, status: "needs_planning", needs_user_input: "needs a Gmail send too" } };
    h.script.push(async () => bounce, async () => ({ plan: await planWith() }), async () => bounce);
    const t = await send(`${EXA} (fast 2)`);
    const s = await waitFor(t.id, ["completed", "unverified", "failed", "blocked"]);
    expect(h.calls.map((c) => c.phase)).toEqual(["preview", "plan", "preview"]);
    expect(h.calls[2].prompt).not.toContain("FAST PATH");
    expect(s.status).toBe("unverified");
  });
  it("fails safe when the fast-path decision throws: plans normally instead of skipping", async () => {
    useJudgeConfig(tmp, { "understand.mail_role": { mode: "live", threshold: 0.9 }, fastpath: { mode: "live", threshold: 0.8 } });
    h.jev = exaJev;
    h.throwFastpath = "fastpath boom";
    h.script.push(async () => ({ plan: await planWith() }), async () => done());
    const t = await send(`${EXA} (fast 3)`);
    const s = await waitFor(t.id, ["completed", "unverified", "failed", "blocked", "needs_clarification"]);
    expect(h.calls.map((c) => c.phase)).toEqual(["plan", "preview"]);
    expect(s.status).toBe("completed");
  });
  it("bounces a fast-path preview that proposes a side effect, before any approval", async () => {
    useJudgeConfig(tmp, { "understand.mail_role": { mode: "live", threshold: 0.9 }, fastpath: { mode: "live", threshold: 0.8 } });
    h.jev = exaJev;
    const proposal = { kind: "one_action", title: "Email the notes", platform: "gmail", action_id: "conn_mod_def::gmail::send", connection_key: "live::gmail::default::g1", connection_name: "Main Riley", method: "POST", target: "x", data_json: "{}", path_vars_json: "", query_params_json: "", flow_key: "", flow_inputs_json: "", side_effect: "send", idempotent: false, expected_calls: 1, estimated_cost: "", dry_run_ok: true };
    const withAction = { structured: { ...done().structured, proposed_actions: [proposal] } };
    h.script.push(async () => withAction, async () => ({ plan: await planWith() }), async () => done());
    const t = await send(`${EXA} (fast 4)`);
    const s = await waitFor(t.id, ["completed", "unverified", "failed", "blocked", "needs_clarification"]);
    expect(h.calls.map((c) => c.phase)).toEqual(["preview", "plan", "preview"]);
    expect(s.status).toBe("completed");
    const { all } = await import("@/lib/server/db");
    expect(all("SELECT * FROM approvals WHERE task_id = ?", [t.id])).toEqual([]);
  });
});

describe("D3 repeat fail-safe", () => {
  it("falls back to the lexical log check when the candidates lookup throws, and plans normally", async () => {
    useJudgeConfig(tmp, { "understand.mail_role": { mode: "live", threshold: 0.9 }, "repeat.same_as": { mode: "live", threshold: 0.9 } });
    h.jev = exaJev;
    h.throwFindCandidates = "candidates boom";
    h.script.push(async () => ({ plan: await planWith() }), async () => done());
    const t = await send(`${EXA} (fallback 1)`);
    const s = await waitFor(t.id, ["completed", "unverified", "failed", "blocked", "needs_clarification"]);
    expect(s.status).toBe("completed");
    expect(h.calls.map((c) => c.phase)).toEqual(["plan", "preview"]);
    const { all } = await import("@/lib/server/db");
    const failed = all<{ level: string; summary: string }>("SELECT level, summary FROM events WHERE task_id = ? AND type = 'judge_failed'", [t.id]);
    expect(failed.some((e) => e.level === "warning" && e.summary.includes("candidates boom"))).toBe(true);
  });
});

describe("D4 trim", () => {
  it("leaves connections Jev is confident are irrelevant out of the PREVIEW prompt, with a note", async () => {
    useJudgeConfig(tmp, { "understand.mail_role": { mode: "live", threshold: 0.9 }, "trim.connection": { mode: "live", threshold: 0.8 } });
    h.jev = exaJev;
    h.script.push(async () => ({ plan: await planWith() }), async () => done());
    const t = await send(`${EXA} (trim 1)`);
    const s = await waitFor(t.id, ["completed", "unverified", "failed", "blocked", "needs_clarification"]);
    expect(s.status).toBe("completed");
    expect(h.calls.map((c) => c.phase)).toEqual(["plan", "preview"]);
    const preview = h.calls[1].prompt;
    expect(preview).toContain('"Main Exa"');
    expect(preview).not.toContain('"Main Riley"');
    expect(preview).toMatch(/\d+ more connection\(s\) judged irrelevant were left out/);
  });
  it("fails safe when the trim step throws: PREVIEW keeps every connection and HQ logs judge_failed", async () => {
    useJudgeConfig(tmp, { "understand.mail_role": { mode: "live", threshold: 0.9 }, "trim.connection": { mode: "live", threshold: 0.8 } });
    h.jev = exaJev;
    h.throwTrim = "trim boom";
    h.script.push(async () => ({ plan: await planWith() }), async () => done());
    const t = await send(`${EXA} (trim 2)`);
    const s = await waitFor(t.id, ["completed", "unverified", "failed", "blocked", "needs_clarification"]);
    expect(s.status).toBe("completed");
    expect(h.calls.map((c) => c.phase)).toEqual(["plan", "preview"]);
    const preview = h.calls[1].prompt;
    expect(preview).toContain('"Main Riley"');
    expect(preview).not.toContain("more connection(s) judged irrelevant");
    const { all } = await import("@/lib/server/db");
    const failed = all<{ level: string; summary: string }>("SELECT level, summary FROM events WHERE task_id = ? AND type = 'judge_failed'", [t.id]);
    expect(failed.some((e) => e.level === "warning" && e.summary.includes("trim boom"))).toBe(true);
  });
});

describe("Jev never settles a route (C1)", () => {
  it("with understand.uses live, a Slack + Drive request still asks which business, and says how Jev read it", async () => {
    const c = (platform: string, name: string) => ({ platform, name, key: `live::${platform}::default::${name.replace(/\W/g, "")}`, state: "operational", access: null });
    const saved = { One: h.CONNS.One, "Studio": h.CONNS["Studio"] };
    h.CONNS.One = [...saved.One, c("slack", "Main Slack")];
    h.CONNS["Studio"] = [...saved["Studio"], c("google-drive", "Studio Drive")];
    try {
      useJudgeConfig(tmp, { "understand.uses": { mode: "live", threshold: 0.5 }, "understand.mail_role": { mode: "live", threshold: 0.9 } });
      h.jev = (q) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(q)) {
          const text = String(v.instructions);
          if (k.startsWith("uses_")) out[k] = { type: "noul", noul: /Is a slack tool/.test(text) ? 0.95 : /Is a google-drive tool/.test(text) ? 0.45 : 0.02 };
          else if (k.startsWith("rel_")) out[k] = { type: "noul", noul: 0.5 };
        }
        out.mail_role = { type: "choice", choice: "no_mail", probabilities: { operate_mailbox: 0.01, find_address: 0.01, no_mail: 0.97, other: 0.01 }, confidence: 0.95 };
        out.complexity = { type: "score", score: 1, probabilities: { "0": 0.1, "1": 0.8, "2": 0.1, "3": 0 }, confidence: 0.8 };
        out.side_effects = { type: "noul", noul: 0.6 };
        return out;
      };
      const t = await send("Summarize the Slack thread and file it in Drive");
      const s = await waitFor(t.id, ["needs_clarification", "failed", "blocked", "completed", "unverified"]);
      expect(s.status).toBe("needs_clarification");
      expect(s.route).toBeNull();
      const ctx = JSON.parse(s.context_json!);
      expect(ctx.pendingQuestion.kind).toBe("route");
      const { all } = await import("@/lib/server/db");
      const msg = all<{ data_json: string }>("SELECT data_json FROM chat_messages WHERE task_id = ? AND kind = 'clarify'", [t.id]);
      expect(JSON.parse(msg[0].data_json).judge.join(" ")).toMatch(/Jev read the tools as slack .*keeps the keyword route/);
      const drive = all<{ predicted: string; acted: number; fallback_reason: string | null }>("SELECT predicted, acted, fallback_reason FROM judge_records WHERE task_id = ? AND gate = 'understand.uses'", [t.id]);
      expect(drive).toEqual([{ predicted: "remove", acted: 0, fallback_reason: "route guard: Jev never settles a route" }]);
    } finally {
      h.CONNS.One = saved.One;
      h.CONNS["Studio"] = saved["Studio"];
    }
  });
});

describe("mailbox skip safety (I3)", () => {
  it("asks which mailbox when the mail intent arrives only in a later answer", async () => {
    useJudgeConfig(tmp, { "understand.mail_role": { mode: "live", threshold: 0.9 }, "understand.uses": { mode: "shadow" } });
    h.jev = exaJev;
    const t = await send("Look up Jordan Lee at Tailspin");
    const s1 = await waitFor(t.id, ["needs_clarification", "failed", "blocked"]);
    expect(JSON.parse(s1.context_json!).pendingQuestion.kind).toBe("route");
    const { answerClarification } = await import("@/lib/server/orchestrator");
    await answerClarification(t.id, "One, and email him what you find");
    const end = Date.now() + 15000;
    for (;;) {
      const { getTask } = await import("@/lib/server/tasks");
      const cur = getTask(t.id)!;
      if (cur.status === "needs_clarification" && JSON.parse(cur.context_json!).pendingQuestion?.kind === "mailbox") break;
      if (["failed", "blocked", "completed", "unverified"].includes(cur.status) || Date.now() > end) throw new Error(`task is ${cur.status}: ${cur.context_json}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    const { getTask } = await import("@/lib/server/tasks");
    expect(getTask(t.id)!.context_json).toContain("Which One mailbox");
  });
});

describe("D3 after a fast-path bounce", () => {
  it("asks Jev about repeats once per task, not again when the bounce comes back to planning", async () => {
    useJudgeConfig(tmp, { "understand.mail_role": { mode: "live", threshold: 0.9 }, fastpath: { mode: "live", threshold: 0.8 }, "repeat.same_as": { mode: "live", threshold: 0.9 } });
    const request = `${EXA} please`;
    fs.writeFileSync(path.join(josRoot, "ONEMEMORY.md"), `# One log\n\n---\n\n## 2026-09-20 · Exa lookup <!-- jos:run=jos_old_exa -->\n\n- **Status:** blocked\n- **Asked:** ${request}\n- **Outcome:** the lookup failed\n`);
    h.jev = (q) => {
      const out = exaJev(q);
      for (const k of Object.keys(q)) if (k.startsWith("same_as_")) out[k] = { type: "noul", noul: 0.3 };
      return out;
    };
    const bounce = { structured: { ...done().structured, status: "needs_planning", needs_user_input: "needs more than one read" } };
    h.script.push(async () => bounce, async () => ({ plan: await planWith() }), async () => done());
    const t = await send(request);
    await waitFor(t.id, ["completed", "unverified", "failed", "blocked"]);
    expect(h.calls.map((c) => c.phase)).toEqual(["preview", "plan", "preview"]);
    const repeatCalls = vi.mocked(systemOne).mock.calls.filter(([o]) => (o as { decision: string }).decision === "repeat");
    expect(repeatCalls).toHaveLength(1);
    const { all } = await import("@/lib/server/db");
    expect(all("SELECT id FROM judge_records WHERE task_id = ? AND gate = 'repeat.same_as'", [t.id])).toHaveLength(1);
  });
});
