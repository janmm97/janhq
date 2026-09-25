// Canonical JSON and payload hashing. An approval approves a payload, so the thing executed must
// hash identically to the thing approved; key order and whitespace must not change the hash.
import { createHash } from "node:crypto";

export function canonicalize(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

/** Parse a JSON flag value; empty/absent is null. Throws on malformed JSON. */
export function parseJsonArg(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  return JSON.parse(s);
}

/** Parse leniently: returns { ok, value, error }. */
export function tryParseJson(raw) {
  try {
    return { ok: true, value: parseJsonArg(raw), error: null };
  } catch (e) {
    return { ok: false, value: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

/**
 * Path variables, query parameters and flow inputs given as `{}` send exactly what omitting them
 * sends, so both forms are null. A body is not normalized: an empty body and no body can differ.
 */
export function emptyToNull(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return null;
  return value;
}

/**
 * Hash of an external action's identity plus payload. Two commands with the same hash send the
 * same request to the same connection.
 */
export function actionPayloadHash(a) {
  return sha256(
    canonicalize({
      kind: a.kind ?? "one_action",
      platform: a.platform ?? null,
      actionId: a.actionId ?? null,
      connectionKey: a.connectionKey ?? null,
      data: a.data ?? null,
      pathVars: emptyToNull(a.pathVars),
      queryParams: emptyToNull(a.queryParams),
      flowKey: a.flowKey ?? null,
      flowInputs: emptyToNull(a.flowInputs),
    }),
  );
}
