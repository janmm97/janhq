import fs from "node:fs";
import path from "node:path";

/** Points HQ at a copy of jos-hq.config.json with the given judge section (a new path each call, so loadConfig re-reads). */
export function useJudgeConfig(tmp: string, decisions: Record<string, { mode: string; threshold?: number }>, extra: Record<string, unknown> = {}): string {
  const base = JSON.parse(fs.readFileSync(path.join(process.cwd(), "jos-hq.config.json"), "utf8"));
  const p = path.join(tmp, `hq.judge.${Date.now()}.${Math.random().toString(36).slice(2)}.config.json`);
  fs.writeFileSync(p, JSON.stringify({ ...base, judge: { model: "jev-1.13.0", pin: "jev-1.13.0", scrub: false, timeoutMs: 8000, decisions, ...extra } }));
  process.env.JOS_HQ_CONFIG = p;
  return p;
}
