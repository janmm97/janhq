#!/usr/bin/env node
// A fake One CLI for the UI tests (Tasks/HQ-Redesign-Spec-2026-09-25.md, Part 6). scripts/e2e-server.mjs
// copies it to <tmp>/fake-one/node_modules/@withone/cli/bin/cli.js and puts <tmp>/fake-one first on PATH,
// so the throwaway HQ never reaches a real One account and never creates a project config in ~/.one.
// It answers only HQ's read-only discovery, with fixed data: the Orchestrator root has one connection;
// One has three (two Gmail, one Slack) for New agent's suggestions; Studio has none; no scope has flows.
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
  root: [{ platform: "open-router", key: "fake::open-router::root", name: "jos-orchestrator", state: "operational", access: null }],
  One: [
    { platform: "gmail", key: "fake::gmail::one-support", name: "Main Support", state: "operational", access: null },
    { platform: "gmail", key: "fake::gmail::one-jan", name: "Main Operator", state: "operational", access: null },
    { platform: "slack", key: "fake::slack::one", name: "Main Slack", state: "operational", access: null },
  ],
  "Studio": [],
};
if (cmd === "config path") out({ command: "config path", scope: "project", path: path.join(cwd, ".one", "fake-config.json"), projectRoot: cwd, projectSlug: "fake" });
else if (cmd === "whoami") out({ user: { name: "Fake One CLI", email: "fake-one-cli@invalid.test" }, organization: null, keyName: "fake" });
else if (cmd === "connection list") out({ connections: CONNECTIONS[scope] });
else if (cmd === "flow list") out({ workflows: [] });
else if (cmd.startsWith("actions search")) out({ actions: [] });
else {
  out({ error: `The fake One CLI used by the UI tests does not run: one ${args.join(" ")}` });
  process.exit(1);
}
