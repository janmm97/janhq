import { describe, expect, it } from "vitest";
import { classifyCommand, classifyRequest, requestPath } from "../../gateway/lib/classify.mjs";
import { parseOneArgs, looksLikeActionId, looksLikeConnectionKey } from "../../gateway/lib/one-args.mjs";
import { actionPayloadHash, canonicalize } from "../../gateway/lib/canonical.mjs";
import { isWithin, samePath } from "../../gateway/lib/paths.mjs";

const cls = (line: string) => classifyCommand(parseOneArgs(line.split(" ")));

describe("One CLI argument parsing", () => {
  it("parses actions execute with every documented flag", () => {
    const p = parseOneArgs(["--agent", "actions", "execute", "gmail", "conn_mod_def::A::B", "live::gmail::default::abc", "-d", '{"to":"a@b.c"}', "--path-vars", '{"userId":"me"}', "--query-params", '{"q":"x"}', "--dry-run"]);
    expect(p.agent).toBe(true);
    expect(p.command).toBe("actions");
    expect(p.subcommand).toBe("execute");
    const s = p.execute!.segments[0];
    expect(s).toMatchObject({ platform: "gmail", actionId: "conn_mod_def::A::B", connectionKey: "live::gmail::default::abc", data: '{"to":"a@b.c"}', pathVars: '{"userId":"me"}', queryParams: '{"q":"x"}', dryRun: true });
  });

  it("parses parallel segments and flow inputs", () => {
    const p = parseOneArgs(["--agent", "actions", "execute", "--parallel", "gmail", "a", "k1", "--", "slack", "b", "k2", "-d", "{}"]);
    expect(p.execute!.parallel).toBe(true);
    expect(p.execute!.segments.map((s) => s.platform)).toEqual(["gmail", "slack"]);
    const f = parseOneArgs(["--agent", "flow", "execute", "welcome", "-i", "email=a@b.c", "-i", "tier=2", "--dry-run"]);
    expect(f.flow).toMatchObject({ target: "welcome", inputs: { email: "a@b.c", tier: "2" }, dryRun: true });
  });

  it("recognizes id shapes", () => {
    expect(looksLikeActionId("conn_mod_def::GJ3ogsegCio::JfABQ0ohS6WriZn8TvHqYQ")).toBe(true);
    expect(looksLikeConnectionKey("live::gmail::default::800e41d2609c42289bf744dc674d34e0")).toBe(true);
    expect(looksLikeConnectionKey("sk_live_123")).toBe(false);
  });
});

describe("command classification", () => {
  it("reads and meta commands", () => {
    expect(cls("--agent config path").category).toBe("meta");
    expect(cls("--agent whoami").category).toBe("read");
    expect(cls("--agent connection list").category).toBe("read");
    expect(cls("--agent actions search gmail list").category).toBe("read");
    expect(cls("--agent actions knowledge gmail conn_mod_def::A::B").category).toBe("read");
    expect(cls("--agent flow list").category).toBe("read");
    expect(cls("--agent flow validate my-flow").category).toBe("read");
    expect(cls("--version").category).toBe("meta");
  });

  it("previews are not writes, except dry-run --stop-after which runs earlier steps for real", () => {
    expect(cls("--agent actions execute gmail a k --dry-run").category).toBe("preview");
    expect(cls("--agent actions execute gmail a k --mock").category).toBe("preview");
    expect(cls("--agent flow execute f --dry-run").category).toBe("preview");
    expect(cls("--agent flow execute f --mock").category).toBe("preview");
    expect(cls("--agent flow execute f --dry-run --stop-after step3").category).toBe("flow-run");
  });

  it("real executions need classification; config and credential changes are forbidden", () => {
    expect(cls("--agent actions execute gmail a k").category).toBe("needs-dry-run");
    expect(cls("--agent flow execute f").category).toBe("flow-run");
    expect(cls("--agent flow resume run123").category).toBe("flow-run");
    expect(cls("--agent connection delete live::x::y::z").category).toBe("forbidden");
    expect(cls("add gmail").category).toBe("forbidden");
    expect(cls("login").category).toBe("forbidden");
    expect(cls("--agent config set x").category).toBe("forbidden");
    expect(cls("--agent sync schedule add stripe --every 1h").category).toBe("forbidden");
    expect(cls("--agent relay create").category).toBe("forbidden");
    expect(cls("--agent flow create k --definition {}").category).toBe("local-write");
    expect(cls("--agent teleport now").category).toBe("unknown");
  });
});

describe("request classification (from --dry-run output)", () => {
  it("GET is a read", () => {
    expect(classifyRequest("gmail", "GET", "https://api.withone.ai/v1/passthrough/gmail/v1/users/me/settings/filters").category).toBe("read");
  });
  it("One custom read actions are POSTs and still reads", () => {
    expect(classifyRequest("gmail", "POST", "https://api.withone.ai/v1/gmail/get-threads").category).toBe("read");
    expect(classifyRequest("gmail", "POST", "/v1/gmail/get-emails").category).toBe("read");
  });
  it("sends, drafts, posts and charges are writes", () => {
    expect(classifyRequest("gmail", "POST", "/v1/gmail/send-email").category).toBe("write");
    expect(classifyRequest("gmail", "POST", "https://api.withone.ai/v1/passthrough/gmail/v1/users/me/drafts").category).toBe("write");
    expect(classifyRequest("gmail", "POST", "/gmail/v1/users/me/messages/abc/modify").category).toBe("write");
    expect(classifyRequest("slack", "POST", "https://api.withone.ai/v1/passthrough/api/chat.postMessage").category).toBe("write");
    expect(classifyRequest("stripe", "POST", "/v1/charges").category).toBe("write");
    expect(classifyRequest("stripe", "DELETE", "/v1/customers/cus_1").category).toBe("write");
    expect(classifyRequest("google-calendar", "POST", "/calendar/v3/calendars/primary/events").category).toBe("write");
  });
  it("read-like POSTs on research and query endpoints are reads (cost-bearing where paid)", () => {
    expect(classifyRequest("open-router", "POST", "https://api.withone.ai/v1/passthrough/chat/completions")).toMatchObject({ category: "read", paid: true });
    expect(classifyRequest("notion", "POST", "/v1/databases/abc/query").category).toBe("read");
    expect(classifyRequest("notion", "POST", "/v1/search").category).toBe("read");
    expect(classifyRequest("slack", "POST", "/api/conversations.history").category).toBe("read");
    expect(classifyRequest("google-calendar", "POST", "/calendar/v3/freeBusy").category).toBe("read");
    expect(classifyRequest("exa", "POST", "/search")).toMatchObject({ category: "read", paid: true });
  });
  it("Notion's search and query reads stay reads through the One passthrough", () => {
    // The dry-run URL is One's passthrough; requestPath strips /v1/passthrough and leaves Notion's own path.
    expect(classifyRequest("notion", "POST", "https://api.withone.ai/v1/passthrough/search").category).toBe("read");
    expect(classifyRequest("notion", "POST", "https://api.withone.ai/v1/passthrough/databases/abc/query").category).toBe("read");
    expect(classifyRequest("notion", "POST", "https://api.withone.ai/v1/passthrough/data_sources/abc/query").category).toBe("read");
    expect(classifyRequest("notion", "POST", "https://api.withone.ai/v1/passthrough/pages").category).toBe("write");
    expect(classifyRequest("notion", "PATCH", "https://api.withone.ai/v1/passthrough/blocks/abc/children").category).toBe("write");
    expect(classifyRequest("notion", "POST", "https://api.withone.ai/v1/passthrough/pages/abc/search").category).toBe("write");
  });
  it("unknown methods fail closed", () => {
    expect(classifyRequest("gmail", "", "/x").category).toBe("write");
    expect(classifyRequest("notion", "PATCH", "/v1/pages/abc").category).toBe("write");
  });
  it("strips the One origin and passthrough prefix", () => {
    expect(requestPath("https://api.withone.ai/v1/passthrough/gmail/v1/users/me")).toBe("/gmail/v1/users/me");
  });
});

describe("payload hashing and paths", () => {
  it("canonical JSON ignores key order", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe(canonicalize({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 }));
    const h1 = actionPayloadHash({ platform: "gmail", actionId: "a", connectionKey: "k", data: { to: "x", subject: "y" } });
    const h2 = actionPayloadHash({ connectionKey: "k", actionId: "a", platform: "gmail", data: { subject: "y", to: "x" } });
    expect(h1).toBe(h2);
    expect(actionPayloadHash({ platform: "gmail", actionId: "a", connectionKey: "k", data: { to: "z" } })).not.toBe(h1);
  });
  it("empty path variables and query parameters hash like omitted ones; an empty body does not", () => {
    const base = { platform: "gmail", actionId: "a", connectionKey: "k", data: { to: "x" } };
    expect(actionPayloadHash({ ...base, pathVars: {}, queryParams: {} })).toBe(actionPayloadHash(base));
    expect(actionPayloadHash({ ...base, pathVars: { id: "1" } })).not.toBe(actionPayloadHash(base));
    expect(actionPayloadHash({ ...base, data: {} })).not.toBe(actionPayloadHash({ ...base, data: null }));
  });
  it("workspace containment is case-insensitive on Windows and rejects siblings", () => {
    expect(isWithin("C:\\Users\\x\\JOS\\One\\Tasks", "c:\\users\\x\\jos\\one")).toBe(process.platform === "win32");
    expect(isWithin("C:\\Users\\x\\JOS\\One", "C:\\Users\\x\\JOS\\One")).toBe(true);
    expect(isWithin("C:\\Users\\x\\JOS\\OneMore", "C:\\Users\\x\\JOS\\One")).toBe(false);
    expect(isWithin("C:\\Users\\x\\JOS", "C:\\Users\\x\\JOS\\One")).toBe(false);
    expect(samePath("C:\\a\\b\\", "C:\\a\\b")).toBe(true);
  });
});
