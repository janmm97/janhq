// Path comparison for the workspace boundary. On Windows paths are case-insensitive, so every
// comparison normalizes case; a boundary check that is fooled by `c:\` vs `C:\` is no boundary.
import fs from "node:fs";
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

/**
 * The path with every link resolved: a junction or symlink inside a workspace can point anywhere, and
 * isWithin alone compares only the spelling. For a path that does not exist yet, the nearest existing
 * ancestor is resolved and the rest re-appended (the rest cannot hold a link, since it does not exist).
 * Throws on anything other than "does not exist", so callers fail closed.
 */
export function realpathNearest(p) {
  let cur = path.resolve(String(p));
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch (e) {
      const code = e && typeof e === "object" ? e.code : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      const parent = path.dirname(cur);
      if (parent === cur) throw e;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** True when `child` is `parent` itself or lives beneath it. */
export function isWithin(child, parent) {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
