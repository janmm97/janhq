import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The UI tests must never reach a real account (a ruling in Tasks/HQ-Redesign-Plan-2026-09-25.md's run):
// their config expects identities no account has, and the fake One CLI they use never answers with one.
const app = path.join(import.meta.dirname, "..", "..");
type Config = { root: { expectedEmail: string }; workspaces: Record<string, { expectedEmail: string }> };
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(app, p), "utf8")) as Config;
const emails = (c: Config) => [c.root.expectedEmail, ...Object.values(c.workspaces).map((w) => w.expectedEmail)];

describe("the UI tests can never dispatch", () => {
  const e2e = emails(read("tests/e2e/fixtures/hq.e2e.config.json"));
  const live = emails(read("jos-hq.config.json"));

  it("expects only identities no real account has, and none of the live ones", () => {
    expect(e2e.length).toBeGreaterThanOrEqual(3);
    for (const e of e2e) expect(e, e).toMatch(/@invalid\.test$/);
    for (const e of e2e) expect(live).not.toContain(e);
  });

  it("uses a fake One CLI whose whoami matches none of them", () => {
    const fake = fs.readFileSync(path.join(app, "tests", "e2e", "fixtures", "fake-one-cli.cjs"), "utf8");
    const who = /email:\s*"([^"]+)"/.exec(fake)?.[1];
    expect(who).toMatch(/@invalid\.test$/);
    expect(e2e).not.toContain(who);
    expect(live).not.toContain(who);
  });

  it("puts the fake One CLI first on PATH", () => {
    const server = fs.readFileSync(path.join(app, "scripts", "e2e-server.mjs"), "utf8");
    expect(server).toContain("fake-one-cli.cjs");
    expect(server).toContain("[pathKey]: `${fakeOne}${path.delimiter}");
  });
});
