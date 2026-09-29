#!/usr/bin/env node
// A fake One CLI for the UI tests (Tasks/HQ-Redesign-Spec-2026-09-25.md, Part 6). scripts/e2e-server.mjs
// copies it to <tmp>/fake-one/node_modules/@withone/cli/bin/cli.js and puts <tmp>/fake-one first on PATH,
// so the throwaway HQ never reaches a real One account and never creates a project config in ~/.one.
// It answers only HQ's read-only discovery, with fixed data: the Orchestrator root has one connection;
// One has four (two Gmail, one Slack, one Exa) for New agent's suggestions; Studio has none; no scope has
// flows. It also answers TypeSafe systemone with fixed, keyword-based answers for the judge tests.
const path = require("node:path");

const args = process.argv.slice(2);
const cwd = process.cwd();
const base = path.basename(cwd);
const scope = base === "One" ? "One" : base === "Studio" ? "Studio" : "root";
const out = (v) => process.stdout.write(JSON.stringify(v) + "\n");

if (args[0] === "--version") {
  process.stdout.write("0.0.0-e2e\n");
  process.exit(0);
}
const cmd = (args[0] === "--agent" ? args.slice(1) : args).join(" ");
const CONNECTIONS = {
  root: [
    { platform: "open-router", key: "fake::open-router::root", name: "hq-root", state: "operational", access: null },
    { platform: "typesafe", key: "live::typesafe::e2e-fake", name: "e2e-jev", state: "operational", access: null },
  ],
  One: [
    { platform: "gmail", key: "fake::gmail::one-support", name: "Main Support", state: "operational", access: null },
    { platform: "gmail", key: "fake::gmail::one-quinn", name: "Main Operator", state: "operational", access: null },
    { platform: "slack", key: "fake::slack::one", name: "Main Slack", state: "operational", access: null },
    { platform: "exa", key: "fake::exa::one", name: "Main Exa", state: "operational", access: null },
  ],
  "Studio": [],
};
if (cmd === "config path") out({ command: "config path", scope: "project", path: path.join(cwd, ".one", "fake-config.json"), projectRoot: cwd, projectSlug: "fake" });
else if (cmd === "whoami") out({ user: { name: "Fake One CLI", email: "fake-one-cli@invalid.test" }, organization: null, keyName: "fake" });
else if (cmd === "connection list") out({ connections: CONNECTIONS[scope] });
else if (cmd === "flow list") out({ workflows: [] });
else if (cmd.startsWith("actions search")) out({ actions: [] });
else if (cmd.startsWith("actions execute typesafe ")) {
  const body = JSON.parse(args[args.indexOf("-d") + 1]);
  const req = String(body.state?.request ?? "");
  const answers = {};
  for (const [k, q] of Object.entries(body.questions)) {
    const text = String(q.instructions);
    if (k.startsWith("uses_")) answers[k] = { type: "noul", noul: new RegExp(`\\b${(text.match(/^Is a (\S+) tool/) || [])[1]}\\b`, "i").test(req) ? 0.95 : 0.05 };
    else if (k.startsWith("rel_")) answers[k] = { type: "noul", noul: 0.5 };
    else if (q.type === "noul") answers[k] = { type: "noul", noul: 0.05 };
    else if (q.type === "choice") answers[k] = { type: "choice", choice: /\bfind\b/i.test(req) ? "find_address" : "operate_mailbox", probabilities: {}, confidence: 0.93 };
    else answers[k] = { type: "score", score: 0, probabilities: { "0": 1 }, confidence: 0.95 };
  }
  out({ dryRun: false, request: { method: "POST", url: "https://example.invalid/v1/systemone" }, response: { model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 0 } } });
} else {
  out({ error: `The fake One CLI used by the UI tests does not run: one ${args.join(" ")}` });
  process.exit(1);
}
