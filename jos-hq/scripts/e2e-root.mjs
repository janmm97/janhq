// The instruction files HQ's UI tests copy into their throwaway J/OS root (scripts/e2e-server.mjs): the
// root's and each workspace's CLAUDE.md and AGENTS.md. They come from JOS_HQ_E2E_ROOT when it is set,
// else from the real J/OS root above jos-hq; a file that is not there (the GitHub Agent's sparse worktree
// holds jos-hq/ alone) is replaced by tests/e2e/fixtures/root/instructions.md, so the UI tests run there too.
import fs from "node:fs";
import path from "node:path";

export const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"];
export const WORKSPACES = ["One", "Studio"];

/** Copies each instruction file from `source` into `root`, or the fixture where `source` lacks it. Returns what was copied from where. */
export function seedInstructionFiles({ source, root, fixture }) {
  const copied = [];
  for (const dir of ["", ...WORKSPACES]) {
    for (const f of INSTRUCTION_FILES) {
      const rel = dir ? path.join(dir, f) : f;
      const real = path.join(source, rel);
      const from = fs.existsSync(real) ? real : fixture;
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.copyFileSync(from, path.join(root, rel));
      copied.push({ rel: rel.split(path.sep).join("/"), fixture: from === fixture });
    }
  }
  return copied;
}
