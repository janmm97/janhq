# J/OS HQ

J/OS HQ is the local command center for J/OS. It is the Orchestrator's loop as a
service — route, open the log, discover, plan, write the executor prompt, dispatch,
verify, close the log — and it is the **only** thing in J/OS that starts an executor
session (`../CLAUDE.md` §6a). It runs on this machine, binds to `127.0.0.1`, and talks
to third-party platforms only through the One CLI, from the executor's own directory.

## Run it

Prerequisites, all as verified on 2026-09-23:

- Node 24 or later, and `npm`.
- The One CLI (`@withone/cli` 1.57.1), with `JOS/`, `JOS/One/` and `JOS/Studio/` each logged
  in under its own `.one/` (`../CLAUDE.md` §7).
- Claude Code as the native `claude.exe` on `PATH` (2.1.278) for the One executor.
- A Codex CLI of at least `0.155.0-alpha.2.6` for the Studio executor. The Codex desktop
  app ships one; the npm-global Codex 0.147.0 cannot run the GPT 6 models and is skipped.

```sh
cd jos-hq
npm install
npm run build
npm run start
```

Then open **<http://127.0.0.1:4610>**. `npm run start` runs in the foreground; Ctrl+C
stops it. To run it in the background instead — stop whatever is on the port, rebuild,
start, log to `data/server-4610.log` — and to stop it again:

```powershell
powershell -File jos-hq\scripts\restart.ps1 -Build   # restart; omit -Build to restart without rebuilding
powershell -File jos-hq\scripts\stop.ps1             # stop
```

Stopping HQ stops any executor still running; that task comes back *Interrupted* on the
next start and waits for you to say what happened.

`jos-hq.config.json` holds everything HQ checks against: the expected account for each
scope, the planner and executor pins for each workspace (`workspaces.<ws>.planner` and
`.executor`; a planner uses its executor's harness and binary) and the limits, including
`limits.planTimeoutMs` for a planning session. To pin a binary, set `claudeBin` /
`codexBin` there, or `JOS_HQ_CLAUDE_BIN` / `JOS_HQ_CODEX_BIN`.

## Use it

- **Chat** — give J/OS a task. The composer has a route selector (Auto, One, Studio) and a
  mode selector: *Manual* (reads until you approve anything), *Edit automatically*
  (local edits allowed), *Plan* (plan only, nothing runs) and *Auto* (the default).
  **Ctrl+Enter or the Send button sends**; plain Enter is a newline. **+** attaches files:
  HQ stores them in `data/uploads/`, and the planning session and the executor read them in
  place — nothing is uploaded anywhere. The trash icon (on a sidebar chat, or in
  the chat's header) deletes a chat after you confirm: its messages and attachments go; its
  task history and log entries stay. HQ refuses while a task in it is running, waiting on
  you, or needs reconciling — stop or reconcile it first.
- **J1 Dashboard** — task outcomes, the live state of the Orchestrator and both
  executors, the five most-used connections, active sub-agents, recent activity.
- **J2 Agents** — sub-agents per executor, their conversations, and *New agent*, which
  asks the two §6b questions and writes three files: a minimal definition
  (`one_<name>.md` or `studio_<name>.toml`), its `SOP.md` (the instructions) and an empty
  `LOGS.md` (the agent's memory, written by HQ), the last two in a folder named after the
  definition. An agent's **Settings** tab shows all three paths and has *Edit agent*, which
  re-asks the two questions pre-filled from the SOP and rewrites it with HQ's current
  guardrails (the name stays fixed, `LOGS.md` is never touched), and *Delete agent*, which
  moves the definition and its whole folder to `data/agent-history/` and deletes its
  conversations after you confirm; its task history and log entries stay, and the name is
  free again. Edit also keeps the old files there first, and both refuse while one of the
  agent's tasks is running, waiting on you, or needs reconciling. An agent in the old
  format (instructions inside the definition) is read-only until *Migrate* (or
  `jos agents migrate`) moves its instructions into `SOP.md` word for word. An SOP HQ did
  not write can be deleted but not edited, and an agent outside `JOS/.claude/agents/` and
  `JOS/.codex/agents/` can be neither.
- **J3 Connections** — every live connection in both workspaces, and when HQ last saw it
  used.
- **J4 Workflows** — the One Flows that exist in each workspace, with dry-run and run.
  **+ New Workflow** opens a chat marked *Builds a One Flow*: every task in it must end with
  a saved flow, whatever the message says, and HQ checks the live `flow list` itself before
  calling it verified.
- **Runtime Health** — the indicator in the top bar. *Verify models* re-proves all four
  pins (each workspace's planner and executor) with a short read-only launch each.

From a root Claude or Codex session, hand HQ a finished executor prompt instead of
starting an executor:

```sh
node jos-hq/bin/jos.mjs dispatch --to <One|Studio> --prompt-file <file> [--mode edit|manual|auto]   # default edit
node jos-hq/bin/jos.mjs watch <taskId>        # also: status, approve, reject, cancel, health
node jos-hq/bin/jos.mjs agents migrate        # old-format agents → definition + SOP.md + LOGS.md (safe to repeat)
```

## What happens to a task

1. **Route** — explicit selection, then named entities, named flows, topic signals, live
   connections; anything still unsettled is asked, with what HQ found. Tool names such as
   Gmail are not topics, and nothing else — fit, the planner, recency — breaks a tie.
2. **Log** — the entry opens in `ONEMEMORY.md`, `STUDIOMEMORY.md` or `JOSMEMORY.md` the
   moment the destination is known, anchored `<!-- jos:run=<task id> -->`.
3. **Discover** — identity (`config path` and `whoami`), the pinned runtime, connections
   and flows, live, from the executor's own directory. An identity mismatch or a missing
   runtime blocks here, before any planning is paid for. A request that does something
   with One's mail and names no mailbox gets asked which of the four.
4. **Wait in line** — one task runs in each workspace at a time. If `JOS/One` or `JOS/Studio` is
   busy, the task waits here, in the order tasks were sent, and starts by itself when the task
   ahead ends. A task holds its workspace until it ends, through an approval or a question too,
   and a task that needs reconciliation keeps holding it. Plan mode waits too: it launches a
   planning session. After a restart the line resumes.
5. **Check the logs** — HQ looks for a close repeat of the request in the route's log,
   `JOSMEMORY.md` and, for an agent task, its `LOGS.md` (word overlap ≥ 0.75, same names,
   emails, URLs, numbers and quoted phrases). A repeat whose newest match ended *done* skips
   planning and hands the executor that entry and its saved plan, as reference only; any
   other match is planned again with its lessons.
6. **Plan** — a read-only planning session in the workspace, on the planner pin (One:
   Claude Code `claude-opus-5-5`; Studio: Codex `gpt-6-astra`; both medium). It checks its
   identity, looks up every action it will use (`search` → `knowledge`), resolves real IDs
   with reads, designs any One Flow, and returns a structured plan. The gateway refuses every
   write while it plans. HQ checks the plan against live connections and against the gateway's
   record of the session's `knowledge` calls, and flags anything it cannot confirm. If
   planning fails, Manual and Plan mode stop; Edit and Auto go on without a plan.
7. **PREVIEW run** — the executor does every read, and dry-runs and proposes every side
   effect. Nothing outward-facing can run in this phase.
8. **Approval** — each proposed action appears with its exact payload, HQ's own dry-run
   of it, and whether the executor dry-ran that identical payload. Approve or reject. In
   **Auto** mode HQ approves every action it validated by itself (recorded as "Auto
   mode"), so nothing waits for you; an action with validation problems still stops.
   Manual and Edit automatically always wait.
9. **EXECUTE run** — only the approved actions, each through `jos-approved run <n>`,
   exactly once, with the identity re-checked at that moment.
10. **Verify and close** — the result is judged against the objective (tool success is not
    objective success), then the log entry is closed, and for an agent task the agent's
    `LOGS.md` entry with it.

## What is enforced in code

- **One dispatcher.** Only `JOS/One` and `JOS/Studio` can be targets. Dispatch requested from
  inside an executor, or by an executor process, is refused, and so is a thin prompt.
- **Pinned runtimes, proven per launch.** One: Claude Code (≥ 2.1.280), `claude-opus-5-5`,
  effort `medium`, for both the planner and the executor, proven by the stream's init event
  plus a PreToolUse hook that reads the effort before the first tool runs. Studio: Codex,
  planner `gpt-6-astra` (GPT 6 Astra) and executor `gpt-6-sol` (GPT 6 Sol),
  `model_reasoning_effort` `medium`, proven from the session rollout. Anything else is
  blocked and shown in Runtime Health — never substituted, and a pinned binary is never
  quietly swapped for another installed one. For One, Claude Code's model fallback is off
  and sub-agents are pinned to the same model, and HQ refuses to certify a run in which any
  turn used another model.
- **Read-only planning.** In the PLAN phase the gateway lets reads through and refuses every
  external write, flow run and local One write; the Claude planner has no edit or delegation
  tools at all.
- **Agent scope.** An agent task runs with its `SOP.md` in every prompt and with the gateway
  limited to the SOP's allowed connections; approval flags a proposal outside them, so no one,
  Auto mode included, can approve it. For a One Flow run, whose actions the gateway cannot
  see, HQ checks the flow's definition (`lib/server/flow-scope.ts`) and flags every step whose
  connection it cannot place inside them. A missing SOP, or no readable or live allowed
  connection, blocks the task; a missing `LOGS.md` is recreated with a warning.
- **Identity.** `projectRoot` and email must both match, from the workspace's own project
  config (`scope: project`, the config file keyed to that directory). Checked at every
  dispatch and again at the moment of each approved write. The org is informational only.
- **The One gateway.** Inside an executor, `one` is `gateway/one-gateway.mjs`. It refuses
  platform calls until the launch is verified, runs `one` only from the workspace,
  classifies each `actions execute` from a dry-run of the real request, lets reads
  through, and refuses writes except through `jos-approved`. It fails closed on anything
  it cannot classify.
- **Approvals.** An approval covers an exact payload (canonical-JSON hash). Claiming it is
  atomic and single-use; an ambiguous result is recorded as ambiguous and never retried
  automatically.
- **The Claude hook** (`gateway/claude-guard.mjs`) blocks delegation (`claude`, `codex`,
  `jos … dispatch`), web tools, MCP servers, the One CLI by path, writes outside the
  workspace, and edits to `CLAUDE.md`, `AGENTS.md` or `.one/` outside `.one/flows/`.
- **Secrets** are redacted from everything HQ stores or streams — SQLite, SSE, the logs,
  planner and executor prompts, and the raw output kept in each run folder. Connection
  keys are identifiers and stay visible. A proposed action whose payload looks like it
  carries a credential cannot be approved: redacting it would change what runs, so HQ
  keeps only the redacted copy and blocks the approval.
- **The browser** can only reach HQ's own API. Mutations need the `x-jos-hq` header and a
  same-origin request. There is no shell endpoint.
- **Restarts.** A task that was live when HQ stopped comes back *Interrupted* or *Needs
  reconciliation*, never Complete, and its log entry gets an `Interrupted` note.

## Test it

```sh
npm test                       # 293 unit and integration tests (gateway and jos-approved as real processes)
npm run test:e2e               # builds into .next-e2e, then 30 Playwright UI tests against a throwaway copy of J/OS
node scripts/e2e-live.mjs all  # live scenarios on the real HQ, real executors
npm run prove:dispatch         # launch proof for both executors, with evidence in data/proof/
```

The Playwright copy runs a fake One CLI (`tests/e2e/fixtures/fake-one-cli.cjs`), which
`scripts/e2e-server.mjs` puts first on PATH. So discovery sees fixed data and never
reaches a real One account. Its config (`tests/e2e/fixtures/hq.e2e.config.json`) expects
`…@invalid.test` identities, so the identity gate blocks every dispatch: UI tests can
route, ask and cancel, but cannot reach a planner, an executor or a platform.
`tests/unit/e2e-isolation.test.ts` keeps both true. Until 2026-09-25 the copy used the
real One CLI, which resolved a real account for the copy's folders and once launched a
real planning session.

The UI tests build into `.next-e2e` (`npm run build:e2e`), never into `.next`, so a test
run cannot replace the build live HQ serves. `scripts/review-shots.mjs` screenshots live
HQ read-only for design review. `scripts/review-states.mjs` screenshots the populated
states from a throwaway instance seeded with design-review fixture rows. The look is
recorded in `DESIGN.md`: a black-and-white darkroom with one amber safelight, in
JetBrains Mono, where every task is a print moving through six stations (Compose, Test
strip, Expose, Develop, Fix, Dry).

The live scenarios (`plan`, `one-read`, `Studio-read`, `ambiguous`, `gmail-ambiguous`,
`approval-reject`, `cancel`, `attachment`, `restart`, `logs`, `root-boundary`) spend real
money (below) and write real log entries, and **they always reject approvals** — they
never execute an outward-facing action. They send in Edit automatically mode for that
reason; a scenario sent in Auto would have its action approved and run for real.
`restart` restarts the real HQ mid-run.

Two scenarios need a deliberately misconfigured, isolated instance —
`restart.ps1 -Port 4612 -Config <file> -DataDir <dir>`, then
`JOS_HQ_URL=http://127.0.0.1:4612 node scripts/e2e-live.mjs <scenario>`:
`runtime-missing` (a config whose `claudeBin` does not exist and whose `minCodexVersion`
no Codex meets) and `identity-Studio` (a config expecting a fake Studio email). An isolated
instance still writes the real logs unless `JOS_HQ_JOS_ROOT` points at a copy, as the UI
tests do, so these scenarios say in their own request text that they are deliberate.

## Evidence, 2026-09-23

| Scenario | Result |
|---|---|
| Launch proof, One | a separate `claude.exe` in `JOS\One`; `claude-opus-5` in the init event and every turn; effort `medium` via the hook; identity `one-operator@example.com`; cancel killed the process tree |
| Launch proof, Studio | Codex 0.155.0-alpha.2.6 (desktop app) in `JOS\Studio`; `gpt-6-astra`, effort `medium` from the rollout; identity `studio-owner@example.com`; cancel killed the process tree |
| One read-only task | Verified Complete (11 connections reported); `ONEMEMORY.md` closed done |
| Studio read-only task | Verified Complete; `STUDIOMEMORY.md` closed done |
| Plan mode | primary timed out at the ~30 s passthrough ceiling; `z-ai/glm-5.3` planned and was credited as the fallback |
| Approval gate, rejected | the One executor dry-ran a Gmail draft and proposed it rather than attempting the write; the approval showed the exact payload and HQ's own dry-run (`POST …/gmail/create-draft`); rejected — nothing was created. The gateway refusing a direct write is proven by the integration tests |
| Approval gate, approved | Jan's first live approval (task `jos_20260923T065044_4e27f1`): a Gmail draft in Main Operator proposed with its exact payload — HQ's dry-run OK, the executor's dry-run matching — approved once in the UI, created exactly once by `jos-approved` (message `1a0cb52f2a689377`), read back by the executor (draft `r467057827839822454`, label DRAFT, not sent), Verified Complete, and seen by Jan in Gmail |
| Cancellation | a running Studio execution was stopped mid-run, 10 s after launch; process tree killed; log closed abandoned |
| Ambiguous request | "Summarize my unread email" asked which business (Gmail is in both); cancelled; `JOSMEMORY.md` closed abandoned |
| Ambiguous Gmail | "Send this from Gmail" asked which business, then — answered One — which of One's four mailboxes; no executor launched |
| Attachments | a file attached in each workspace was read by the executor, which returned its token exactly — One and Studio both Verified Complete; the token never reached the planner |
| Connection telemetry | the One run's real Gmail read (label names only) moved J3 Last Used for Gmail from "never" to the call's time and put Gmail in J1 Top Connections |
| Restart mid-run | HQ restarted while a Studio run was executing: the task came back Interrupted, the log gained an `Interrupted` note, nothing claimed completion; reconciled as abandoned |
| Root boundary | root, arbitrary path, dispatch from inside `JOS\One`, executor-origin dispatch and a thin prompt refused; header-less and foreign-origin mutations got 403; Health confirms the root is `operator@example.com`, holds only OpenRouter, and cannot execute |
| Identity regression | isolated instances expecting the wrong One email, and the wrong Studio email, blocked before any launch; Health showed Blocked while read-only discovery kept working |
| Runtime missing | an isolated instance with a missing pinned Claude binary and an impossible Codex minimum: Health named each cause; both tasks blocked before planning — no launch, no planner call, no fallback |
| Logging | 19 HQ tasks across the three logs: each has exactly one entry in one log, closed at most once |
| Runtime Health probe | both executors re-verified after the model-pinning change, and again after the stream-redaction change |

Measured cost: a One (Claude Code) launch reported **$0.18–$0.99** at list price
(`total_cost_usd`). A cold start costs about $0.60 even for a two-command probe, because
each launch is a new session and rebuilds its prompt cache. Codex does not report a
cost. A planner call is about $0.003.

Since 2026-09-24 the OpenRouter planner call is gone: a new task may run a planning session
instead, which is a launch like any other and costs like one. A done repeat found in the
logs skips it.

## Not yet exercised, and known limits

- **Workflows and sub-agent chat have not run live**, because no One Flows and no
  sub-agent definitions exist yet. Both pages show truthful empty states.
- **Approve → execute has run live once** (a Gmail draft); an ambiguous outcome — the
  "never retry, check first" path — has so far only been exercised by the integration
  tests.
- **On Studio there is no hook.** Delegation, web access and hand-built HTTP calls are ruled
  out by the prompt and Codex's defaults; external writes through One are still blocked
  by the gateway, and the sandbox confines file writes to `JOS/Studio` and `~/.one`. In
  manual mode, holding back local file edits is asked of the executor, not enforced.
- **These are guardrails, not a sandbox.** An executor runs as the local user. The
  gateway and hook stop mistakes and drift; they would not stop an executor set on
  getting around them.
- Claude Code does not report the effort level in its output; HQ reads it from the hook at
  the first tool call, which every prompt's mandatory identity check makes. A run that
  somehow calls no tool is never certified.
- The credential check on proposed payloads is pattern-based, so it can refuse an
  innocent payload (an email that says "password: …") and cannot recognise a secret in a
  format it does not know.
- HQ sees what the executor streams. Anything Claude Code or Codex does internally that
  never reaches the stream is outside what HQ can verify.

## Where things live

```text
jos-hq/
├── app/                  pages (J1–J4, chat, task detail) and the one API route
├── components/           UI
├── lib/server/           orchestrator, routing, planning (sessions and plan check), memory
│                         (log-first reuse, agent history), agents and agent-files (SOP/LOGS),
│                         prompt, dispatch, identity, logs, approvals, health, telemetry, SQLite
├── reference/            HQ's copy of the One Flow overview, embedded in planner briefs
├── lib/server/executors/ the Claude (One) and Codex (Studio) adapters and launch proof
├── gateway/              `one` gateway, `jos-approved`, the Claude hook, PATH shims
├── bin/jos.mjs           the CLI for root sessions
├── scripts/              restart, stop, live scenarios, launch proof, UI test server,
│                         design-review screenshots
├── tests/                unit, integration, Playwright
├── jos-hq.config.json    expected identities, planner and executor pins, limits
└── data/                 (git-ignored) hq.sqlite, runs/<task>/<execution>/, uploads/
```

`data/` is telemetry, not memory: the three root logs remain the record. Each run folder
keeps the prompt, the policy the gateway enforced, the launch arguments, and the raw
output stream. `AGENTS.md` and `CLAUDE.md` in this folder are written by `next dev` (Next
16's agent notes); they are not J/OS instruction files.
