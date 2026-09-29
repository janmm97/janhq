// Simple write-deny patterns (policy.denyWriteGlobs), matched case-insensitively against a path
// relative to the workspace. A pattern is either
//   - a segment pattern, matched against every segment: a literal name or a glob whose only wildcard is
//     `*` (e.g. `tsconfig*.json`, `*.config.*`), or
//   - a root pattern starting with `/`, matched against the whole relative path (e.g. `/.gitignore`);
//     one that also ends with `/` names a folder, and matches it and everything under it
//     (e.g. `/jos-hq/scripts/public/`).
// No regex: matching is a linear scan. Used by the Claude guard and by the GitHub Agent's commit check.
export function segmentMatches(seg, pattern) {
  const parts = pattern.split("*");
  if (parts.length === 1) return seg === pattern;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (seg.length < first.length + last.length || !seg.startsWith(first) || !seg.endsWith(last)) return false;
  let at = first.length;
  const end = seg.length - last.length;
  for (const mid of parts.slice(1, -1)) {
    if (!mid) continue;
    const i = seg.indexOf(mid, at);
    if (i < 0 || i + mid.length > end) return false;
    at = i + mid.length;
  }
  return true;
}

/** Throws on a pattern that cannot mean what it looks like: a bare `/`, `*` in a root pattern, a separator in a segment pattern. */
export function validatePattern(p) {
  if (typeof p !== "string" || !p) return;
  if (p.startsWith("/")) {
    if (p.replace(/\//g, "") === "") throw new Error(`write-deny pattern ${JSON.stringify(p)} is a bare "/"`);
    if (p.includes("*")) throw new Error(`root write-deny pattern ${JSON.stringify(p)} may not contain "*"`);
    if (p.includes("\\")) throw new Error(`root write-deny pattern ${JSON.stringify(p)} must use "/"`);
  } else if (p.includes("/") || p.includes("\\")) {
    throw new Error(`segment write-deny pattern ${JSON.stringify(p)} may not contain a path separator`);
  }
}

/**
 * NTFS spellings that name a file other than the one they seem to: an alternate data stream
 * (`package.json::$DATA` writes package.json itself) or a trailing dot or space (Win32 strips them).
 * A path with such a segment is refused outright rather than matched.
 */
export function hasAmbiguousSegment(rel) {
  return String(rel)
    .split(/[\\/]/)
    .filter(Boolean)
    .some((s) => s.includes(":") || s.endsWith(".") || s.endsWith(" "));
}

/** True when `rel` (forward slashes, relative to the workspace) matches any of `patterns`. Throws on a malformed pattern. */
export function writeDenied(rel, patterns) {
  const r = String(rel).replace(/\\/g, "/").toLowerCase();
  const segs = r.split("/").filter(Boolean);
  const whole = segs.join("/");
  for (const p of patterns) validatePattern(p);
  return patterns.some((p) => {
    if (typeof p !== "string" || !p) return false;
    const pat = p.toLowerCase();
    if (pat.startsWith("/")) {
      const target = pat.slice(1).split("/").filter(Boolean).join("/");
      return whole === target || (pat.endsWith("/") && whole.startsWith(`${target}/`));
    }
    return segs.some((seg) => segmentMatches(seg, pat));
  });
}
