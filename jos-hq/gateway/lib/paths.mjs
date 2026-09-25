// Path comparison for the workspace boundary. On Windows paths are case-insensitive, so every
// comparison normalizes case; a boundary check that is fooled by `c:\` vs `C:\` is no boundary.
import path from "node:path";

const WIN = process.platform === "win32";

/** Absolute, separator-normalized, trailing-separator-free, case-folded on Windows. */
export function normalizePath(p) {
  let out = path.resolve(String(p));
  if (out.length > 1 && (out.endsWith("\\") || out.endsWith("/")) && !/^[A-Za-z]:[\\/]$/.test(out)) {
    out = out.slice(0, -1);
  }
  return WIN ? out.toLowerCase() : out;
}

export function samePath(a, b) {
  return normalizePath(a) === normalizePath(b);
}

/**
 * Problems with where the One CLI took its config from, per `one --agent config path`. A workspace
 * must use its own project config (`~/.one/projects/<slug>/config.json`, slug = projectRoot with
 * `:`, `\` and `/` as `-`). A fall-back to the global or another project's config can still print a
 * plausible projectRoot, so the scope and the file are checked as well.
 */
export function configOwnershipProblems(cp, expectedProjectRoot) {
  const problems = [];
  if (cp?.scope && cp.scope !== "project") problems.push(`the One CLI resolves the ${cp.scope} config here, not this directory's own project config`);
  if (cp?.path) {
    const slug = String(expectedProjectRoot).replace(/[\\/:]/g, "-").toLowerCase();
    const file = String(cp.path).replace(/\\/g, "/").toLowerCase();
    if (!file.endsWith(`/${slug}/config.json`)) problems.push(`config file ${cp.path} is not the project config for ${expectedProjectRoot}`);
  }
  return problems;
}

/** True when `child` is `parent` itself or lives beneath it. */
export function isWithin(child, parent) {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
