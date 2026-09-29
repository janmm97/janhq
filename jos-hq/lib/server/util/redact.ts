// Secret redaction applied to everything HQ persists or streams: SQLite rows, SSE events, Markdown
// logs, planner prompts and executor prompts. Connection keys (live::platform::...) are identifiers,
// not credentials, and are left intact.

const PATTERNS: Array<[RegExp, string | ((m: string, ...g: string[]) => string)]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "***REDACTED PRIVATE KEY***"],
  [/\bsk_(live|test)_[A-Za-z0-9]{8,}/g, "sk_$1_***REDACTED***"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "sk-ant-***REDACTED***"],
  [/\bsk-or-v1-[A-Za-z0-9]{16,}/g, "sk-or-v1-***REDACTED***"],
  [/\bsk-[A-Za-z0-9_-]{24,}/g, "sk-***REDACTED***"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "xox?-***REDACTED***"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh?_***REDACTED***"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***REDACTED***"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***REDACTED***"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g, "***REDACTED JWT***"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, "$1 ***REDACTED***"],
  [
    /("?(?:authorization|x-one-secret|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|cookie|set-cookie|signing[_-]?secret)"?\s*[:=]\s*"?)([^"\s,}]{6,})/gi,
    (_m: string, head: string, value: string) => (value.includes("REDACTED") ? `${head}${value}` : `${head}***REDACTED***`),
  ],
];

export function redactSecrets(text: string): string {
  let out = String(text);
  for (const [re, rep] of PATTERNS) {
    out = out.replace(re, rep as never);
  }
  return out;
}

/** True when redaction would change the value, i.e. it appears to carry a credential. */
export function containsSecret(value: unknown): boolean {
  return JSON.stringify(redactDeep(value)) !== JSON.stringify(value);
}

export function redactDeep<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(apiKey|api_key|secret|token|accessToken|refreshToken|password|cookie|x-one-secret)$/i.test(k) && typeof v === "string") {
        out[k] = v.includes("REDACTED") ? v : "***REDACTED***";
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out as T;
  }
  return value;
}
