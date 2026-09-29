// D1 (spec §6): one combined Jev call that reads a request against the live tool catalog: which tools
// it needs as instruments, what role email plays, how complex it is, whether it has side effects, and
// which connections could matter. It never picks One or Studio; it only feeds routing step 3's implied
// platforms, the mailbox question, the fast path (D2) and prompt trimming (D4).
import type { WorkspaceId } from "../env";
import type { ConnectionInfo } from "../one/discovery";
import { impliedPlatforms } from "../routing";
import { toolCatalog, toolLine, toolsFor, type Tool } from "./catalog";
import { systemOne } from "./client";
import type { Gate } from "./gates";
import { fill, gateVersion, questionText } from "./questions";
import { recordJudgment } from "./records";
import type { ChoiceAnswer, NoulAnswer, NoulCriteria, Question, ScoreAnswer } from "./types";

export interface UnderstandResult {
  model: string;
  platforms: Record<string, number>;
  mailRole: { choice: string; confidence: number };
  complexity: { score: number; confidence: number; single: number };
  sideEffects: number;
  relevance: Record<string, number>;
  recordIds: { uses: Record<string, number>; mailRole: number | null; trim: Record<string, number> };
}

export function understandQuestions(tools: Tool[]): { questions: Record<string, Question>; platformKeys: Record<string, string>; relKeys: Record<string, string> } {
  const cat = toolCatalog();
  const questions: Record<string, Question> = {};
  const platformKeys: Record<string, string> = {};
  const relKeys: Record<string, string> = {};
  const uses = questionText("understand.uses");
  [...new Set(tools.map((t) => t.platform))].sort().forEach((p, i) => {
    platformKeys[`uses_${i}`] = p;
    questions[`uses_${i}`] = { type: "noul", instructions: fill(uses.instructions, { platform: p, purpose: cat[p]?.purpose ?? p }), criteria: uses.criteria as unknown as NoulCriteria };
  });
  const mail = questionText("understand.mail_role");
  questions.mail_role = { type: "choice", instructions: mail.instructions, criteria: mail.criteria as unknown as Record<string, string> };
  const cx = questionText("understand.complexity");
  questions.complexity = { type: "score", instructions: cx.instructions, criteria: cx.criteria as unknown as string[] };
  const se = questionText("understand.side_effects");
  questions.side_effects = { type: "noul", instructions: se.instructions, criteria: se.criteria as unknown as NoulCriteria };
  const rel = questionText("trim.connection");
  tools.forEach((t, i) => {
    relKeys[`rel_${i}`] = t.name;
    questions[`rel_${i}`] = { type: "noul", instructions: fill(rel.instructions, { name: t.name }), criteria: rel.criteria as unknown as NoulCriteria };
  });
  return { questions, platformKeys, relKeys };
}

export async function understand(i: { taskId: string | null; request: string; conversation: string | null; conns: Record<WorkspaceId, ConnectionInfo[] | null> }): Promise<UnderstandResult | null> {
  const tools = toolsFor([...(i.conns.One ?? []), ...(i.conns["Studio"] ?? [])]);
  if (!tools.length) return null;
  const { questions, platformKeys, relKeys } = understandQuestions(tools);
  const state = {
    // Bounded: the body travels on the One CLI's command line (Windows caps it near 32k characters).
    request: i.request.slice(0, 4000),
    earlier: i.conversation?.trim() ? i.conversation.trim().slice(-2000) : null,
    tools: Object.fromEntries(tools.map((t) => [t.name, toolLine(t)])),
  };
  const r = await systemOne({ taskId: i.taskId, decision: "understand", state, questions });
  if (!r.ok) return null;
  const a = r.answers;
  const mr = a.mail_role as ChoiceAnswer;
  const cx = a.complexity as ScoreAnswer;
  const u: UnderstandResult = {
    model: r.model,
    platforms: Object.fromEntries(Object.entries(platformKeys).map(([k, p]) => [p, (a[k] as NoulAnswer).noul])),
    mailRole: { choice: mr.choice, confidence: mr.confidence },
    complexity: { score: cx.score, confidence: cx.confidence, single: cx.probabilities["0"] ?? 0 },
    sideEffects: (a.side_effects as NoulAnswer).noul,
    relevance: Object.fromEntries(Object.entries(relKeys).map(([k, n]) => [n, (a[k] as NoulAnswer).noul])),
    recordIds: { uses: {}, mailRole: null, trim: {} },
  };

  // Validate all numeric fields are finite before recording anything
  if (!Number.isFinite(u.sideEffects) || !Number.isFinite(u.complexity.score) || !Number.isFinite(u.complexity.confidence) || !Number.isFinite(u.complexity.single) || !Number.isFinite(u.mailRole.confidence)) {
    return null;
  }
  for (const n of Object.values(u.platforms)) {
    if (!Number.isFinite(n)) return null;
  }
  for (const n of Object.values(u.relevance)) {
    if (!Number.isFinite(n)) return null;
  }

  const base = { callId: r.callId, taskId: i.taskId, model: r.model, acted: false, fallbackReason: null };
  // Only disagreements with routing's keyword list are recorded: those are the only readings that can
  // change anything, and pooling every easy "not used" platform would make the gate look accurate.
  const vUses = gateVersion("understand.uses");
  const keywords = impliedPlatforms(i.request);
  for (const [p, n] of Object.entries(u.platforms)) {
    const jevUses = n >= 0.5;
    if (jevUses === keywords.includes(p)) continue;
    u.recordIds.uses[p] = recordJudgment({ ...base, gate: "understand.uses", version: vUses, subject: p, predicted: jevUses ? "add" : "remove", score: jevUses ? n : 1 - n, answer: { noul: n } });
  }
  u.recordIds.mailRole = recordJudgment({ ...base, gate: "understand.mail_role", version: gateVersion("understand.mail_role"), subject: null, predicted: mr.choice, score: mr.confidence, answer: mr });
  const vTrim = gateVersion("trim.connection");
  for (const [name, n] of Object.entries(u.relevance)) {
    if (1 - n < 0.5) continue; // only drops are tuned (spec 7.1)
    u.recordIds.trim[name] = recordJudgment({ ...base, gate: "trim.connection", version: vTrim, subject: name, predicted: "drop", score: 1 - n, answer: { noul: n } });
  }
  return u;
}

/**
 * Routing step 3's implied platforms. Live: Jev adds a platform it is sure is an instrument and removes
 * one it is sure is not (only platforms a workspace owns). Otherwise the regex result stands.
 */
export function impliedFromJudge(regex: string[], u: UnderstandResult | null, g: Gate, owned: string[]): { platforms: string[]; acted: boolean; changed: boolean } {
  if (!u || !g.live || g.threshold === null) return { platforms: regex, acted: false, changed: false };
  const t = g.threshold;
  const kept = regex.filter((p) => !(p in u.platforms) || u.platforms[p] > 1 - t);
  const added = Object.entries(u.platforms).filter(([p, n]) => n >= t && owned.includes(p) && !kept.includes(p)).map(([p]) => p);
  const platforms = [...kept, ...added];
  return { platforms, acted: true, changed: platforms.join() !== regex.join() };
}

/** "ask": the task operates a mailbox; "skip": it does not; null: not sure, so today's rule decides.
 * A skip also needs Jev to read the task as side-effect free: a wrongly skipped question on a task that
 * sends could send from a mailbox nobody chose. */
export function mailboxVerdict(u: UnderstandResult | null, g: Gate): "ask" | "skip" | null {
  if (!u || !g.live || g.threshold === null || u.mailRole.confidence < g.threshold) return null;
  if (u.mailRole.choice === "operate_mailbox") return "ask";
  if ((u.mailRole.choice === "find_address" || u.mailRole.choice === "no_mail") && u.sideEffects < 0.5) return "skip";
  return null;
}

const ROLE_TEXT: Record<string, string> = { operate_mailbox: "operate a mailbox", find_address: "find an address", no_mail: "no mail", other: "other" };

export function judgeSummary(u: UnderstandResult): string {
  const tools = Object.entries(u.platforms).filter(([, n]) => n >= 0.5).map(([p, n]) => `${p} ${n.toFixed(2)}`).join(", ") || "none";
  return `Jev: tools ${tools} · mail: ${ROLE_TEXT[u.mailRole.choice] ?? u.mailRole.choice} (${u.mailRole.confidence.toFixed(2)}) · single lookup ${u.complexity.single.toFixed(2)} · side effects ${u.sideEffects.toFixed(2)}`;
}
