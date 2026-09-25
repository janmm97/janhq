#!/usr/bin/env node
// Isolated HQ instance for UI tests. It runs against a throwaway COPY of the J/OS structure
// (instruction files, logs, .one markers — no credentials), so UI tests never write the real logs.
// A fake One CLI (tests/e2e/fixtures/fake-one-cli.cjs) is first on PATH, so the copy never reaches a real
// One account: discovery sees fixed data (one Orchestrator connection, three for One, none for Studio, no flows). Its
// whoami matches no identity the UI-test config (tests/e2e/fixtures/hq.e2e.config.json) expects, so the
// identity gate blocks every dispatch: UI tests can route, ask and cancel, but can never launch a planner
// or an executor, or touch a platform.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realRoot = path.resolve(app, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-ui-"));
const root = path.join(tmp, "JOS");
for (const f of ["CLAUDE.md", "AGENTS.md"]) fs.cpSync(path.join(realRoot, f), path.join(root, f), { recursive: true });
fs.writeFileSync(path.join(root, "ONEMEMORY.md"), "# J/OS — One session log (UI test copy)\n\n---\n");
fs.writeFileSync(path.join(root, "STUDIOMEMORY.md"), "# Studio — session log (UI test copy)\n\n---\n");
fs.writeFileSync(path.join(root, "JOSMEMORY.md"), "# J/OS — Orchestrator session log (UI test copy)\n\n");
for (const ws of ["One", "Studio"]) {
  for (const f of ["CLAUDE.md", "AGENTS.md"]) fs.cpSync(path.join(realRoot, ws, f), path.join(root, ws, f));
  fs.mkdirSync(path.join(root, ws, ".one"), { recursive: true });
}
fs.mkdirSync(path.join(root, ".one"), { recursive: true });
// Definitions the UI tests edit and delete are copied into the throwaway root, never changed in place.
fs.cpSync(path.join(app, "tests", "e2e", "fixtures", "editable"), path.join(root, ".claude", "agents"), { recursive: true });
// A fake One CLI first on PATH (tests/e2e/fixtures/fake-one-cli.cjs): the throwaway HQ reads fixed data and
// never reaches a real One account. HQ runs <dir of one.cmd>/node_modules/@withone/cli/bin/cli.js.
const fakeOne = path.join(tmp, "fake-one");
const fakeCli = path.join(fakeOne, "node_modules", "@withone", "cli", "bin", "cli.js");
fs.mkdirSync(path.dirname(fakeCli), { recursive: true });
fs.copyFileSync(path.join(app, "tests", "e2e", "fixtures", "fake-one-cli.cjs"), fakeCli);
fs.writeFileSync(path.join(fakeOne, "one.cmd"), `@node "%~dp0node_modules\\@withone\\cli\\bin\\cli.js" %*\r\n`);
fs.writeFileSync(path.join(fakeOne, "one"), `#!/bin/sh\nexec node "$(dirname "$0")/node_modules/@withone/cli/bin/cli.js" "$@"\n`, { mode: 0o755 });
// On Windows the PATH key may be spelled "Path"; replace whichever key exists rather than adding a second one.
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
const port = process.env.JOS_HQ_PORT ?? "4613";
const env = {
  ...process.env,
  // The build scripts/build-e2e.mjs made; live HQ's .next is never touched.
  JOS_HQ_DIST_DIR: ".next-e2e",
  JOS_HQ_JOS_ROOT: root,
  JOS_HQ_DATA_DIR: path.join(tmp, "data"),
  JOS_HQ_CONFIG: path.join(app, "tests", "e2e", "fixtures", "hq.e2e.config.json"),
  JOS_HQ_PORT: port,
  [pathKey]: `${fakeOne}${path.delimiter}${process.env[pathKey] ?? ""}`,
};
console.log(`[e2e-server] J/OS copy at ${root}`);
// Next's own entry point under this node: no shell, so no argument concatenation.
const nextBin = path.join(app, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, process.argv.includes("--dev") ? "dev" : "start", "--port", port, "--hostname", "127.0.0.1"], { cwd: app, env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill());
