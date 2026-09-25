import { beforeEach, describe, expect, it, vi } from "vitest";

// Display discovery (lib/server/one/discovery.ts) spawns four read-only One CLI runs per scope. Here the
// CLI is a fake that records each run and answers after a short delay, so no test reaches a real account.
const h = vi.hoisted(() => ({ runs: [] as string[] }));
vi.mock("@/lib/server/one/cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/one/cli")>()),
  runOneReadOnly: vi.fn(async (scope: string, args: string[]) => {
    const cmd = args.filter((a) => a !== "--agent").join(" ");
    h.runs.push(`${scope} ${cmd}`);
    await new Promise((r) => setTimeout(r, 20));
    const json =
      cmd === "connection list"
        ? { connections: [{ platform: "gmail", key: "fake::gmail::one-support", name: "Main Support", state: "operational", access: null }] }
        : cmd === "flow list"
          ? { workflows: [] }
          : cmd === "whoami"
            ? { user: { name: "Fake", email: "fake@invalid.test" }, organization: null, keyName: "fake" }
            : { projectRoot: "C:\\JOS\\One", path: "C:\\fake\\config.json", scope: "project" };
    return { ok: true, json, code: 0, stderr: "", durationMs: 20 };
  }),
}));

beforeEach(() => {
  h.runs.length = 0;
  const g = globalThis as Record<string, unknown>;
  delete g.__josDiscovery;
  delete g.__josDiscoveryInFlight;
});

describe("display discovery", () => {
  it("shares one run between concurrent callers of a scope", async () => {
    const { discoverScope } = await import("@/lib/server/one/discovery");
    const [a, b] = await Promise.all([discoverScope("One"), discoverScope("One")]);
    expect(h.runs.sort()).toEqual(["One config path", "One connection list", "One flow list", "One whoami"]);
    expect(b).toBe(a);
    expect(a.connections?.map((c) => c.name)).toEqual(["Main Support"]);
  });

  it("starts a new run once the shared one has finished, when asked for a fresh list", async () => {
    const { discoverScope } = await import("@/lib/server/one/discovery");
    await discoverScope("One");
    await discoverScope("One", { fresh: true });
    expect(h.runs).toHaveLength(8);
  });
});
