// The only way HQ reaches TypeSafe Jev: One CLI, root scope, the root's own TypeSafe connection
// (resolved live, never written down), POST /v1/systemone through the one allow-listed argv shape
// (one/cli.ts assertReadOnly). Every failure returns { ok: false } so the caller falls back.
import { runOneReadOnly, TYPESAFE_SYSTEMONE } from "../one/cli";
import { listConnections } from "../one/discovery";
import { redactSecrets } from "../util/redact";
import { scrubPublic } from "../util/public-scrub";
import { judgeConfig } from "./config";
import { recordCall } from "./records";
import type { Answer, Question } from "./types";

export type SystemOneResult = { ok: true; model: string; answers: Record<string, Answer>; callId: number } | { ok: false; error: string; callId: number | null };

const g = globalThis as unknown as { __josJudge?: { key: string | null; keyAt: number; failures: number; openUntil: number } };
function st() {
  return (g.__josJudge ??= { key: null, keyAt: 0, failures: 0, openUntil: 0 });
}

export function resetJudgeClient(): void {
  g.__josJudge = { key: null, keyAt: 0, failures: 0, openUntil: 0 };
}

export function breakerState(): { open: boolean; until: string | null; failures: number } {
  const s = st();
  const open = Date.now() < s.openUntil;
  return { open, until: open ? new Date(s.openUntil).toISOString() : null, failures: s.failures };
}

export async function rootJevKey(force = false): Promise<string | null> {
  const s = st();
  if (!force && s.keyAt && Date.now() - s.keyAt < 5 * 60_000) return s.key;
  const r = await listConnections("root");
  s.key = r.connections?.find((c) => c.platform === "typesafe" && c.state === "operational")?.key ?? null;
  s.keyAt = Date.now();
  return s.key;
}

function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
}

async function prepareState(state: unknown, scrub: boolean): Promise<unknown> {
  let out = mapStrings(state, redactSecrets);
  if (scrub) {
    const { scrubTerms } = await import("../issues");
    // Connection names stay: they are the options Jev picks between.
    const terms = { ...(await scrubTerms()), connections: [] };
    out = mapStrings(out, (s) => scrubPublic(s, terms));
  }
  return out;
}

function answersFor(json: unknown, questions: Record<string, Question>, pin: string): { ok: true; model: string; answers: Record<string, Answer>; tokens: number | null } | { ok: false; error: string; model: string | null } {
  const resp = ((json as { response?: unknown })?.response ?? json) as { model?: unknown; answers?: Record<string, { type?: unknown }>; usage?: { input_tokens?: unknown } } | undefined;
  const model = typeof resp?.model === "string" ? resp.model : null;
  if (!resp || !resp.answers) return { ok: false, error: "no answers in the response", model };
  if (model !== pin) return { ok: false, error: `model changed: answered by ${model ?? "?"}, pinned ${pin}`, model };
  const bad = Object.entries(questions).filter(([k, q]) => resp.answers![k]?.type !== q.type).map(([k]) => k);
  if (bad.length) return { ok: false, error: `answers missing or wrong type: ${bad.join(", ")}`, model };

  // Validate answer payloads
  const malformed: string[] = [];
  for (const [k, q] of Object.entries(questions)) {
    const ans = resp.answers![k] as unknown as { type: string; noul?: unknown; choice?: unknown; probabilities?: unknown; confidence?: unknown; score?: unknown };
    if (q.type === "noul") {
      if (typeof ans.noul !== "number" || !Number.isFinite(ans.noul) || ans.noul < 0 || ans.noul > 1) malformed.push(k);
    } else if (q.type === "choice") {
      const crit = q.criteria;
      const validCrit = typeof crit === "object" && crit !== null && !Array.isArray(crit);
      if (typeof ans.choice !== "string" || !validCrit || !(ans.choice in (crit as Record<string, unknown>))) malformed.push(k);
      if (typeof ans.confidence !== "number" || !Number.isFinite(ans.confidence) || ans.confidence < 0 || ans.confidence > 1) malformed.push(k);
      if (!ans.probabilities || typeof ans.probabilities !== "object") malformed.push(k);
    } else if (q.type === "score") {
      if (typeof ans.score !== "number" || !Number.isFinite(ans.score)) malformed.push(k);
      if (typeof ans.confidence !== "number" || !Number.isFinite(ans.confidence) || ans.confidence < 0 || ans.confidence > 1) malformed.push(k);
      if (!ans.probabilities || typeof ans.probabilities !== "object") malformed.push(k);
    }
  }
  if (malformed.length) return { ok: false, error: `malformed answers: ${malformed.join(", ")}`, model };

  return { ok: true, model, answers: resp.answers as unknown as Record<string, Answer>, tokens: typeof resp.usage?.input_tokens === "number" ? resp.usage.input_tokens : null };
}

const retryable = (text: string) => /\b(429|529)\b|too many requests|overloaded/i.test(text);

/** The response can be nominally `ok` (no top-level `error`, per `runOne`) while the parsed
 * envelope itself carries an error nested under `response` — an upstream rate limit, say. Pull
 * that text out so it drives retry/failure decisions the same as a transport-level failure. */
function envelopeErrorText(json: unknown): string | null {
  const j = json as { response?: { error?: unknown; status?: unknown; detail?: unknown }; error?: unknown } | undefined;
  const parts = [j?.response?.error, j?.error, j?.response?.status, j?.response?.detail].filter((v) => v !== undefined && v !== null);
  return parts.length ? parts.map(String).join(" ") : null;
}

function hasAnswers(json: unknown): boolean {
  const resp = ((json as { response?: unknown })?.response ?? json) as { answers?: unknown } | undefined;
  return !!resp && typeof resp === "object" && resp.answers != null;
}

export async function systemOne(o: { taskId: string | null; decision: string; state: unknown; questions: Record<string, Question> }): Promise<SystemOneResult> {
  const cfg = judgeConfig();
  if (!cfg) return { ok: false, error: "judge not configured", callId: null };
  if (breakerState().open) return { ok: false, error: "circuit open", callId: null };
  const started = Date.now();
  const fail = (error: string, model: string | null = null): SystemOneResult => {
    const s = st();
    s.failures += 1;
    if (s.failures >= 3) s.openUntil = Date.now() + 5 * 60_000;
    return { ok: false, error, callId: recordCall({ taskId: o.taskId, decision: o.decision, model, inputTokens: null, durationMs: Date.now() - started, ok: false, error }) };
  };
  const key = await rootJevKey();
  if (!key) return fail("no operational TypeSafe connection at the root");
  const body = { state: await prepareState(o.state, cfg.scrub), model: cfg.model, questions: o.questions };
  const args = ["--agent", "actions", "execute", "typesafe", TYPESAFE_SYSTEMONE, key, "-d", JSON.stringify(body)];
  let r = await runOneReadOnly("root", args, cfg.timeoutMs);
  let envText = envelopeErrorText(r.json);
  if ((!r.ok || !hasAnswers(r.json)) && retryable(`${r.error ?? ""} ${r.stderr} ${envText ?? ""}`)) {
    await new Promise((res) => setTimeout(res, 1000));
    r = await runOneReadOnly("root", args, cfg.timeoutMs);
    envText = envelopeErrorText(r.json);
  }
  if (!r.ok) return fail(envText ?? r.error ?? "systemone call failed");
  const parsed = answersFor(r.json, o.questions, cfg.pin);
  if (!parsed.ok) return fail(envText ?? parsed.error, parsed.model);
  const s = st();
  s.failures = 0;
  s.openUntil = 0;
  const callId = recordCall({ taskId: o.taskId, decision: o.decision, model: parsed.model, inputTokens: parsed.tokens, durationMs: Date.now() - started, ok: true, error: null });
  return { ok: true, model: parsed.model, answers: parsed.answers, callId };
}
