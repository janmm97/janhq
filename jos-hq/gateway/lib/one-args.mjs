// Parse a One CLI argv into a structure the gateway can reason about. Only flags documented in
// the installed One skill (SKILL.md, references/flows.md) are given meaning; anything else is kept
// verbatim and treated as boolean, and an unrecognizable shape is classified "unknown" (blocked).

const VALUE_FLAGS_EXECUTE = new Set([
  "-d",
  "--data",
  "--path-vars",
  "--query-params",
  "--headers",
  "--output",
  "--max-concurrency",
]);
const VALUE_FLAGS_FLOW = new Set(["-i", "--input", "--stop-after", "--output-file", "--definition"]);
const VALUE_FLAGS_OTHER = new Set(["-t", "--type", "--section", "--limit", "--tags", "--weight", "--config", "--where", "--every", "--tag"]);

function splitEq(token) {
  const i = token.indexOf("=");
  if (token.startsWith("--") && i > 2) return [token.slice(0, i), token.slice(i + 1)];
  return [token, undefined];
}

/**
 * Parse one command segment (no `--` separators).
 * @param {string[]} tokens
 * @param {Set<string>} valueFlags
 */
function parseSegment(tokens, valueFlags) {
  const positionals = [];
  const flags = {}; // flag -> array of values (true for boolean)
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    if (raw.startsWith("-") && raw !== "-") {
      const [name, inline] = splitEq(raw);
      if (inline !== undefined) {
        (flags[name] ??= []).push(inline);
      } else if (valueFlags.has(name) && i + 1 < tokens.length) {
        (flags[name] ??= []).push(tokens[++i]);
      } else {
        (flags[name] ??= []).push(true);
      }
    } else {
      positionals.push(raw);
    }
  }
  return { positionals, flags };
}

function first(flags, ...names) {
  for (const n of names) {
    const v = flags[n];
    if (v && v.length) return v[v.length - 1];
  }
  return undefined;
}

function has(flags, ...names) {
  return names.some((n) => flags[n] && flags[n].length > 0);
}

/**
 * @typedef {Record<string, Array<string | true>>} FlagMap
 * @typedef {{ platform: string | null, actionId: string | null, connectionKey: string | null, extraPositionals: string[],
 *   data: string | true | undefined, pathVars: string | true | undefined, queryParams: string | true | undefined,
 *   headers: string | true | undefined, output: string | true | undefined, dryRun: boolean, mock: boolean, flags: FlagMap }} ExecSegment
 * @typedef {{ target: string | null, inputs: Record<string, string>, dryRun: boolean, mock: boolean,
 *   stopAfter: string | true | null, allowBash: boolean, flags: FlagMap }} FlowRun
 * @typedef {{ agent: boolean, command: string | null, subcommand: string | null, raw: string[], globalFlags: string[],
 *   execute: { parallel: boolean, segments: ExecSegment[] } | null, flow: FlowRun | null,
 *   other?: { positionals: string[], flags: FlagMap } }} ParsedOne
 */

/**
 * @param {string[]} argv arguments after `one`
 * @returns {ParsedOne}
 */
export function parseOneArgs(argv) {
  const tokens = argv.map(String);
  const agent = tokens.includes("--agent");
  const rest = tokens.filter((t) => t !== "--agent");

  // Leading global flags such as --version / --help, then up to two command words.
  const globalFlags = [];
  let idx = 0;
  while (idx < rest.length && rest[idx].startsWith("-")) globalFlags.push(rest[idx++]);
  const words = [];
  while (idx < rest.length && !rest[idx].startsWith("-") && words.length < 2) words.push(rest[idx++]);
  const command = words[0] ?? null;
  /** @type {ParsedOne} */
  const out = {
    agent,
    command,
    subcommand: null,
    raw: tokens,
    globalFlags,
    execute: null,
    flow: null,
  };

  if (!command) return out;

  const multi = new Set(["actions", "flow", "connection", "connections", "config", "cache", "mem", "sync", "relay", "guide"]);
  if (multi.has(command)) out.subcommand = words[1] ?? null;

  if (command === "actions" && out.subcommand === "execute") {
    const afterIdx = rest.indexOf("execute") + 1;
    const segTokens = rest.slice(afterIdx);
    const parallel = segTokens.includes("--parallel");
    const segments = [];
    let cur = [];
    for (const t of segTokens) {
      if (t === "--parallel") continue;
      if (t === "--" && parallel) {
        segments.push(cur);
        cur = [];
      } else cur.push(t);
    }
    segments.push(cur);
    const parsedSegs = segments
      .filter((s) => s.length > 0)
      .map((s) => {
        const { positionals, flags } = parseSegment(s, VALUE_FLAGS_EXECUTE);
        return {
          platform: positionals[0] ?? null,
          actionId: positionals[1] ?? null,
          connectionKey: positionals[2] ?? null,
          extraPositionals: positionals.slice(3),
          data: first(flags, "-d", "--data"),
          pathVars: first(flags, "--path-vars"),
          queryParams: first(flags, "--query-params"),
          headers: first(flags, "--headers"),
          output: first(flags, "--output"),
          dryRun: has(flags, "--dry-run"),
          mock: has(flags, "--mock"),
          flags,
        };
      });
    out.execute = { parallel, segments: parsedSegs };
  }

  if (command === "flow" && (out.subcommand === "execute" || out.subcommand === "resume")) {
    const afterIdx = rest.indexOf(out.subcommand) + 1;
    const { positionals, flags } = parseSegment(rest.slice(afterIdx), VALUE_FLAGS_FLOW);
    const inputs = {};
    for (const v of [...(flags["-i"] ?? []), ...(flags["--input"] ?? [])]) {
      if (typeof v !== "string") continue;
      const eq = v.indexOf("=");
      if (eq > 0) inputs[v.slice(0, eq)] = v.slice(eq + 1);
    }
    out.flow = {
      target: positionals[0] ?? null, // flow key for execute, run id for resume
      inputs,
      dryRun: has(flags, "--dry-run"),
      mock: has(flags, "--mock"),
      stopAfter: first(flags, "--stop-after") ?? null,
      allowBash: has(flags, "--allow-bash"),
      flags,
    };
  }

  // Keep a parse of the remaining tokens for other commands (used only for display).
  if (!out.execute && !out.flow) {
    const { positionals, flags } = parseSegment(rest.slice(words.length), VALUE_FLAGS_OTHER);
    out.other = { positionals, flags };
  }
  return out;
}

const ACTION_ID_RE = /^conn_mod_def::[^:\s]+::[^:\s]+$/;
const CONNECTION_KEY_RE = /^(live|test)::[a-z0-9-]+::[^:\s]+::[^:\s]+$/;

export function looksLikeActionId(s) {
  return typeof s === "string" && ACTION_ID_RE.test(s);
}

export function looksLikeConnectionKey(s) {
  return typeof s === "string" && CONNECTION_KEY_RE.test(s);
}
