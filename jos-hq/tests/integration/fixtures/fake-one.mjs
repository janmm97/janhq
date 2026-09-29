// Stand-in for the real One CLI in gateway tests. It never contacts anything. Real executions are
// appended to FAKE_ONE_LOG so a test can prove whether a write ever ran.
import { appendFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const log = (line) => appendFileSync(process.env.FAKE_ONE_LOG, line + "\n");
const has = (f) => args.includes(f);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (args.includes("config") && args.includes("path")) {
  // Shaped like the real CLI: the project config lives under ~/.one/projects/<slug>/config.json.
  const root = process.env.FAKE_PROJECT_ROOT;
  const slug = root.replace(/[\\/:]/g, "-");
  const scope = process.env.FAKE_CONFIG_SCOPE ?? "project";
  const file = scope === "project" ? path.join(path.dirname(root), ".one", "projects", slug, "config.json") : path.join(path.dirname(root), ".one", "config.json");
  out({ command: "config path", scope, path: file, projectRoot: root, projectSlug: slug });
} else if (args.includes("whoami")) {
  out({ user: { email: process.env.FAKE_EMAIL, name: "Test" }, organization: null });
} else if (args[1] === "actions" && args[2] === "execute") {
  const actionId = args[4];
  const i = args.indexOf("-d");
  const data = i >= 0 ? args[i + 1] : "";
  const request = actionId === "act_read" ? { method: "GET", url: "https://api.withone.ai/v1/passthrough/gmail/v1/users/me/labels" } : { method: "POST", url: "https://api.withone.ai/v1/gmail/send-email" };
  if (has("--dry-run") || has("--mock")) {
    out({ dryRun: true, request });
  } else {
    log(`EXECUTED ${actionId} ${data}`);
    out({ dryRun: false, request, response: { id: "msg_123", threadId: "thr_9" } });
  }
} else if (args[1] === "flow" && args[2] === "execute") {
  log(`FLOW ${args[3]}`);
  out({ event: "flow:start", flowKey: args[3] });
  out({ event: "step:complete", status: "success" });
  const status = process.env.FAKE_FLOW_STATUS ?? "success";
  if (status !== "missing") out({ event: "workflow:result", runId: "fixture-run", status, ...(status === "failed" ? { error: "No endpoints found that can handle the requested parameters" } : {}) });
} else if (args[1] === "connection" && args[2] === "list") {
  out({ connections: [] });
} else {
  log(`OTHER ${args.join(" ")}`);
  out({ ok: true });
}
