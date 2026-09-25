// The identity gate (CLAUDE.md §7). Before any dispatch HQ reads `one --agent config path` and
// `one --agent whoami` from the executor's own working directory and compares BOTH projectRoot and
// email with the contract. The org alone is never enough (Studio's org is null by design, and the two
// Jan accounts differ only by email). A mismatch blocks dispatch; it is never a warning-and-continue.
import { loadConfig, josRoot, workspaceRoot } from "./env";
import { readIdentity, type IdentitySnapshot } from "./one/discovery";
import type { OneScope } from "./one/cli";
// Shared path logic with the executor-side gateway.
import { configOwnershipProblems, samePath } from "../../gateway/lib/paths.mjs";

export interface IdentityVerdict {
  scope: OneScope;
  ok: boolean;
  expected: { projectRoot: string; email: string; org: string | null };
  actual: { projectRoot: string | null; email: string | null; org: string | null; name: string | null; keyName: string | null };
  problems: string[];
  warnings: string[];
  checkedAt: string;
}

export function expectedIdentity(scope: OneScope) {
  const cfg = loadConfig();
  if (scope === "root") return { projectRoot: josRoot(), email: cfg.root.expectedEmail, org: cfg.root.expectedOrg };
  const w = cfg.workspaces[scope];
  return { projectRoot: workspaceRoot(scope), email: w.expectedEmail, org: w.expectedOrg };
}

export function evaluateIdentity(scope: OneScope, snap: IdentitySnapshot): IdentityVerdict {
  const expected = expectedIdentity(scope);
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!snap.ok) problems.push(`identity could not be read: ${snap.error ?? "unknown error"}`);
  if (!snap.projectRoot) problems.push("config path returned no projectRoot");
  else if (!samePath(snap.projectRoot, expected.projectRoot)) {
    const inherits = scope !== "root" && samePath(snap.projectRoot, josRoot());
    problems.push(
      inherits
        ? `projectRoot is ${snap.projectRoot}: this workspace lost its own One config and is inheriting the root's`
        : `projectRoot is ${snap.projectRoot}, expected ${expected.projectRoot}`,
    );
  }
  // A workspace must use ITS OWN project config (shared with jos-approved's execution-time check).
  problems.push(...configOwnershipProblems({ scope: snap.configScope, path: snap.configPath }, expected.projectRoot));
  if (!snap.email) problems.push("whoami returned no email");
  else if (snap.email.toLowerCase() !== expected.email.toLowerCase()) problems.push(`account email is ${snap.email}, expected ${expected.email}`);
  if ((snap.orgName ?? null) !== (expected.org ?? null)) {
    warnings.push(`organization is ${snap.orgName ?? "none"}, contract expects ${expected.org ?? "none"}`);
  }
  return {
    scope,
    ok: problems.length === 0,
    expected,
    actual: { projectRoot: snap.projectRoot, email: snap.email, org: snap.orgName, name: snap.name, keyName: snap.keyName },
    problems,
    warnings,
    checkedAt: snap.checkedAt,
  };
}

/** Live check, never cached: this is the check that catches a silent account collapse. */
export async function verifyIdentity(scope: OneScope): Promise<IdentityVerdict> {
  return evaluateIdentity(scope, await readIdentity(scope));
}
