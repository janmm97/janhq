import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { seedInstructionFiles } from "../../scripts/e2e-root.mjs";

// The UI tests' throwaway J/OS root gets the real instruction files when they exist (HQ's own checkout),
// and a fixture where they do not (the GitHub Agent's sparse worktree, which holds jos-hq/ alone).
const app = path.join(import.meta.dirname, "..", "..");
const fixture = path.join(app, "tests", "e2e", "fixtures", "root", "instructions.md");
const all = ["CLAUDE.md", "AGENTS.md", "One/CLAUDE.md", "One/AGENTS.md", "Studio/CLAUDE.md", "Studio/AGENTS.md"];

describe("seedInstructionFiles", () => {
  it("copies the real files unchanged when they are all there", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-root-"));
    const source = path.join(tmp, "src");
    for (const rel of all) {
      fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
      fs.writeFileSync(path.join(source, rel), `real ${rel}\n`);
    }
    const root = path.join(tmp, "JOS");
    const copied = seedInstructionFiles({ source, root, fixture });
    expect(copied.every((c) => !c.fixture)).toBe(true);
    for (const rel of all) expect(fs.readFileSync(path.join(root, rel), "utf8")).toBe(`real ${rel}\n`);
  });

  it("falls back to the fixture for each file that is missing, as in a sparse worktree", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-root-"));
    const source = path.join(tmp, "sparse");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "CLAUDE.md"), "real root\n");
    const root = path.join(tmp, "JOS");
    const copied = seedInstructionFiles({ source, root, fixture });
    expect(copied.filter((c) => c.fixture).map((c) => c.rel)).toEqual(all.slice(1));
    expect(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toBe("real root\n");
    const stand = fs.readFileSync(fixture, "utf8");
    for (const rel of all.slice(1)) expect(fs.readFileSync(path.join(root, rel), "utf8")).toBe(stand);
    // The two files of a workspace stay twins, as HQ's health check expects.
    expect(fs.readFileSync(path.join(root, "One", "CLAUDE.md"), "utf8")).toBe(fs.readFileSync(path.join(root, "One", "AGENTS.md"), "utf8"));
  });

  it("the UI test server uses it, and honours JOS_HQ_E2E_ROOT", () => {
    const server = fs.readFileSync(path.join(app, "scripts", "e2e-server.mjs"), "utf8");
    expect(server).toContain("seedInstructionFiles(");
    expect(server).toContain("process.env.JOS_HQ_E2E_ROOT");
  });
});
