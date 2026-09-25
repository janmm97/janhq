import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { flowScopeProblems } from "@/lib/server/flow-scope";
import type { ConnectionInfo } from "@/lib/server/one/discovery";

// An agent's connection scope applied to a One Flow run (spec 3.4): the flow's own actions run inside the One
// CLI, out of the gateway's sight, so HQ reads the definition and places every step's connection first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-flow-scope-"));
const conn = (platform: string, name: string, key: string): ConnectionInfo => ({ platform, name, key, state: "operational", access: null });
const CONNS = [
  conn("notion", "Studio Notion", "live::notion::default::n1"),
  conn("gmail", "Studio gmail", "live::gmail::default::g1"),
  conn("gmail", "Studio gmail 2", "live::gmail::default::g2"),
  conn("exa", "Studio Exa", "live::exa::default::e1"),
];
const NOTION_ONLY = ["live::notion::default::n1"];

function flow(key: string, def: Record<string, unknown>, layout: "folder" | "file" = "folder") {
  const dir = path.join(root, ".one", "flows");
  fs.mkdirSync(layout === "folder" ? path.join(dir, key) : dir, { recursive: true });
  fs.writeFileSync(layout === "folder" ? path.join(dir, key, "flow.json") : path.join(dir, `${key}.flow.json`), JSON.stringify({ key, name: key, ...def }));
}
const action = (id: string, a: Record<string, unknown>) => ({ id, type: "action", action: { actionId: `conn_mod_def::${id}`, ...a } });
function check(flowKey: string, inputs: Record<string, unknown> = {}, scopeKeys = NOTION_ONLY) {
  return flowScopeProblems({ workspaceRoot: root, flowKey, inputs, scopeKeys, connections: CONNS });
}

describe("flowScopeProblems", () => {
  it("passes a flow whose every action resolves inside the agent's connections", () => {
    flow("notes-ok", {
      inputs: { dbKey: { type: "string", default: "live::notion::default::n1" } },
      steps: [
        action("query", { platform: "notion", connection: { platform: "notion" } }),
        action("create", { platform: "notion", connectionKey: "$.input.dbKey" }),
        { id: "shape", type: "code", code: { source: "return 1;" } },
      ],
    });
    expect(check("notes-ok")).toEqual([]);
  });

  it("flags a literal or input-supplied key outside the scope, naming the step and connection", () => {
    flow("mail-literal", { steps: [action("send", { platform: "gmail", connectionKey: "live::gmail::default::g1" })] });
    expect(check("mail-literal").join("\n")).toMatch(/step "send" uses connection "Studio gmail", which is outside this agent's allowed connections/);
    flow("mail-input", { inputs: { gmailKey: { type: "string" } }, steps: [action("send", { platform: "gmail", connectionKey: "$.input.gmailKey" })] });
    expect(check("mail-input", { gmailKey: "live::gmail::default::g1" }).join("\n")).toMatch(/outside this agent's allowed connections/);
    expect(check("mail-input", { gmailKey: "live::gmail::default::g1" }, ["live::gmail::default::g1"])).toEqual([]);
  });

  it("a connection chosen at run time must be one of the agent's, whichever the engine picks", () => {
    flow("late-bound", { steps: [action("send", { platform: "gmail", connection: { platform: "gmail", tag: "support" } })] });
    expect(check("late-bound", {}, ["live::gmail::default::g1"]).join("\n")).toMatch(/"Studio gmail 2" is outside this agent's allowed connections/);
    expect(check("late-bound", {}, ["live::gmail::default::g1", "live::gmail::default::g2"])).toEqual([]);
    // With no connection of that platform allowed at all, passing a key would not help, so HQ does not suggest it.
    expect(check("late-bound").join("\n")).toMatch(/step "send" uses a gmail connection, and none of this agent's allowed connections is gmail$/);
    flow("hinted-input", { inputs: { gmailKey: { type: "string", connection: { platform: "gmail" } } }, steps: [action("send", { platform: "gmail", connectionKey: "$.input.gmailKey" })] });
    expect(check("hinted-input", {}, ["live::gmail::default::g1"]).join("\n")).toMatch(/outside this agent's allowed connections/);
  });

  it("finds actions nested in loops, conditions, parallel, while and paginate steps", () => {
    flow("nested", {
      steps: [
        { id: "each", type: "loop", loop: { over: "$.steps.x.output", as: "i", steps: [action("inLoop", { platform: "gmail", connectionKey: "live::gmail::default::g1" })] } },
        { id: "branch", type: "condition", condition: { expression: "true", then: [], else: [action("inElse", { platform: "exa", connection: { platform: "exa" } })] } },
        { id: "fan", type: "parallel", parallel: { steps: [action("inParallel", { platform: "gmail", connectionKey: "live::gmail::default::g2" })] } },
        { id: "again", type: "while", while: { condition: "false", steps: [action("inWhile", { platform: "exa", connection: { platform: "exa" } })] } },
        { id: "pages", type: "paginate", paginate: { action: { platform: "gmail", actionId: "a", connectionKey: "live::gmail::default::g1" }, maxPages: 3 } },
      ],
    });
    const out = check("nested").join("\n");
    for (const id of ["inLoop", "inElse", "inParallel", "inWhile", "pages"]) expect(out).toContain(`step "${id}"`);
  });

  it("checks a sub-flow with the inputs its caller passes, and flags one chosen at run time", () => {
    flow("child", { inputs: { key: { type: "string" } }, steps: [action("childSend", { platform: "gmail", connectionKey: "$.input.key" })] }, "file");
    flow("parent", { inputs: { k: { type: "string" } }, steps: [{ id: "call", type: "flow", flow: { key: "child", inputs: { key: "$.input.k" } } }] });
    expect(check("parent", { k: "live::notion::default::n1" })).toEqual([]);
    expect(check("parent", { k: "live::gmail::default::g1" }).join("\n")).toMatch(/step "childSend" uses connection "Studio gmail"/);
    flow("dynamic", { inputs: { target: { type: "string" } }, steps: [{ id: "pick", type: "flow", flow: { key: "$.steps.choose.output.key" } }] });
    expect(check("dynamic").join("\n")).toMatch(/step "pick" runs a sub-flow chosen at run time/);
  });

  it("flags what it cannot place: a step-output key, an unknown step type, an unreadable flow", () => {
    flow("from-step", { steps: [action("send", { platform: "notion", connectionKey: "$.steps.lookup.output.key" })] });
    expect(check("from-step").join("\n")).toMatch(/step "send" takes its connection from \$\.steps\.lookup\.output\.key/);
    flow("odd", { steps: [{ id: "mystery", type: "teleport", teleport: {} }] });
    expect(check("odd").join("\n")).toMatch(/step "mystery" has a step type HQ does not know \(teleport\)/);
    expect(check("missing-flow").join("\n")).toMatch(/could not read flow missing-flow's definition/);
    expect(check("../outside").join("\n")).toMatch(/could not read flow/);
  });

  it("does not mistake data that mentions an actionId for an action", () => {
    flow("data-only", { steps: [action("create", { platform: "notion", connection: { platform: "notion" }, data: { properties: { Action: { platform: "gmail", actionId: "x", connectionKey: "live::gmail::default::g1" } } } })] });
    expect(check("data-only")).toEqual([]);
  });
});
