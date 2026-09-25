// Side-effect classification for One CLI commands.
//
// Categories:
//   meta         - no platform contact (help, version, config path, guide, cache status)
//   read         - reads One or platform state without side effects
//   preview      - --dry-run / --mock: resolves a request without performing it
//   needs-dry-run- a real `actions execute`; the gateway must dry-run it to learn method + URL
//   flow-run     - a real flow execution or resume: write-class, runs only through approvals
//   local-write  - writes local One state or files in the workspace (flow create, mem writes)
//   forbidden    - account/connection/config changes that HQ never performs through an executor
//   unknown      - anything unrecognized; always blocked (fail closed)
//
// For `actions execute` the dry-run request is classified by classifyRequest(). Anything that is
// not provably a read is a write. Reads that cost money (OpenRouter, Exa, Tavily, Firecrawl) are
// still reads: they have no external side effect, and cost is governed by the cost guardrail.

export function classifyCommand(parsed) {
  const { command, subcommand } = parsed;
  if (!command) {
    const g = parsed.globalFlags ?? [];
    if (g.some((f) => ["--version", "-v", "-V", "--help", "-h"].includes(f))) return { category: "meta", reason: "global flag" };
    return { category: "unknown", reason: "no command" };
  }
  switch (command) {
    case "help":
    case "guide":
    case "platforms":
      return { category: "meta", reason: `${command} is documentation` };
    case "whoami":
      return { category: "read", reason: "identity read" };
    case "list":
      return { category: "read", reason: "connection list alias" };
    case "connection":
    case "connections":
      if (subcommand === "list" || subcommand === null) return { category: "read", reason: "connection list" };
      if (subcommand === "delete") return { category: "forbidden", reason: "connection delete is irreversible" };
      return { category: "unknown", reason: `connection ${subcommand}` };
    case "config":
      if (subcommand === "path") return { category: "meta", reason: "config path" };
      return { category: "forbidden", reason: "One access-control configuration is changed by the operator, not an executor" };
    case "add":
    case "login":
    case "logout":
    case "init":
    case "update":
    case "upgrade":
      return { category: "forbidden", reason: `\`one ${command}\` changes credentials, connections or the CLI itself` };
    case "cache":
      if (subcommand === "list" || subcommand === "status" || subcommand === null) return { category: "meta", reason: "cache inspection" };
      return { category: "local-write", reason: `cache ${subcommand} modifies the local cache` };
    case "actions":
      if (subcommand === "search" || subcommand === "knowledge") return { category: "read", reason: `actions ${subcommand}` };
      if (subcommand === "execute") {
        const segs = parsed.execute?.segments ?? [];
        if (segs.length === 0) return { category: "unknown", reason: "actions execute without an action" };
        if (segs.every((s) => s.dryRun || s.mock)) return { category: "preview", reason: "dry-run or mock" };
        return { category: "needs-dry-run", reason: "real action execution" };
      }
      return { category: "unknown", reason: `actions ${subcommand}` };
    case "flow":
      if (["list", "validate", "runs", "inspect"].includes(subcommand)) return { category: "read", reason: `flow ${subcommand}` };
      if (subcommand === "create") return { category: "local-write", reason: "flow create writes .one/flows" };
      if (subcommand === "execute") {
        const f = parsed.flow;
        // --dry-run --stop-after runs every step before the target for real, so it is not a preview.
        if (f && f.mock) return { category: "preview", reason: "flow mock" };
        if (f && f.dryRun && !f.stopAfter) return { category: "preview", reason: "flow dry-run" };
        return { category: "flow-run", reason: f?.stopAfter ? "flow execution up to a step" : "flow execution" };
      }
      if (subcommand === "resume") return { category: "flow-run", reason: "flow resume executes remaining steps" };
      return { category: "unknown", reason: `flow ${subcommand}` };
    case "mem": {
      const reads = ["search", "list", "get", "find-by-key", "find-by-source", "status", "doctor"];
      if (reads.includes(subcommand)) return { category: "read", reason: `mem ${subcommand}` };
      return { category: "local-write", reason: `mem ${subcommand} writes the local memory store` };
    }
    case "sync": {
      const reads = ["list", "profiles", "schema", "query", "search"];
      if (reads.includes(subcommand)) return { category: "read", reason: `sync ${subcommand}` };
      if (subcommand === "schedule") return { category: "forbidden", reason: "scheduled syncs are recurring automation; build a One Flow instead" };
      return { category: "local-write", reason: `sync ${subcommand} pulls platform data into the local store` };
    }
    case "relay":
      if (subcommand === "list") return { category: "read", reason: "relay list" };
      return { category: "forbidden", reason: "relay changes create or remove live webhook routes" };
    default:
      return { category: "unknown", reason: `unrecognized command \`${command}\`` };
  }
}

const SLACK_READ_METHODS = new Set([
  "conversations.list", "conversations.history", "conversations.replies", "conversations.info", "conversations.members",
  "users.list", "users.info", "users.lookupByEmail", "users.profile.get", "users.getPresence", "users.conversations",
  "search.messages", "search.files", "search.all", "auth.test", "team.info", "bots.info", "chat.getPermalink",
  "emoji.list", "files.list", "files.info", "pins.list", "reactions.get", "reactions.list", "reminders.list",
  "reminders.info", "usergroups.list", "usergroups.users.list", "stars.list", "dnd.info",
]);

/** Strip the One origin and passthrough prefix so rules can match the platform path. */
export function requestPath(url) {
  let p = String(url ?? "");
  try {
    p = new URL(p).pathname;
  } catch {
    /* already a path */
  }
  p = p.replace(/^\/v1\/passthrough(?=\/)/, "");
  return p || "/";
}

/**
 * Classify a resolved request (from `--dry-run`) as read or write.
 * @returns {{ category: "read" | "write", reason: string, paid?: boolean }}
 */
export function classifyRequest(platform, method, url) {
  const m = String(method ?? "").toUpperCase();
  const p = requestPath(url);
  const plat = String(platform ?? "").toLowerCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return { category: "read", reason: `${m} request` };
  if (!m) return { category: "write", reason: "unknown method (fail closed)" };

  switch (plat) {
    case "open-router":
      if (/\/(chat\/)?completions$|\/embeddings$|\/responses$/.test(p)) return { category: "read", reason: "model inference", paid: true };
      break;
    case "exa":
      if (/\/(search|contents|findSimilar|answer)$/.test(p)) return { category: "read", reason: "search / retrieval", paid: true };
      break;
    case "tavily":
      if (/\/(search|extract|crawl|map)$/.test(p)) return { category: "read", reason: "search / retrieval", paid: true };
      break;
    case "firecrawl":
      if (/\/(scrape|search|map|crawl|extract|batch\/scrape)$/.test(p)) return { category: "read", reason: "scrape / retrieval", paid: true };
      break;
    case "notion":
      // Through One's passthrough the path arrives without Notion's /v1 prefix (requestPath strips /v1/passthrough).
      if (/^(?:\/v1)?\/search$|^(?:\/v1)?\/(databases|data_sources)\/[^/]+\/query$/.test(p)) return { category: "read", reason: "notion query" };
      break;
    case "google-calendar":
      if (/\/freeBusy$/i.test(p)) return { category: "read", reason: "free/busy query" };
      break;
    case "slack": {
      const method2 = p.split("/").filter(Boolean).pop() ?? "";
      if (SLACK_READ_METHODS.has(method2)) return { category: "read", reason: `slack ${method2}` };
      break;
    }
    default:
      break;
  }
  // One custom read actions are POSTs named get-/list-/search-... (e.g. POST /v1/gmail/get-threads).
  if (/^\/v1\/[a-z0-9-]+\/(get|list|search|find|fetch|read|query|view)-[a-z0-9-]+$/.test(p)) {
    return { category: "read", reason: "One custom read action" };
  }
  return { category: "write", reason: `${m} ${p}` };
}
