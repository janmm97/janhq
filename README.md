<div align="center">

# J/OS HQ

**A local command center that orchestrates AI coding agents, with a human in the loop. It routes,
plans, gates and verifies every task that [Claude Code](https://claude.com/product/claude-code) and
[Codex CLI](https://github.com/openai/codex) run on your real systems, and nothing leaves the machine
without your approval.**

[![Claude Code by Anthropic](https://img.shields.io/badge/Claude_Code-Anthropic-d97757?logo=claude&logoColor=white)](https://claude.com/product/claude-code)
[![Codex CLI by OpenAI](https://img.shields.io/badge/Codex_CLI-OpenAI-412991?logo=openai&logoColor=white)](https://github.com/openai/codex)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: view only](https://img.shields.io/badge/license-view_only-6a6a6a)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/janmm97/janhq?color=6a6a6a)](https://github.com/janmm97/janhq/commits)

<img src="docs/jos-hq-ai-agent-command-center.gif" width="100%" alt="J/OS HQ demo: an AI agent task is routed to the right workspace, planned read-only, approved once by the operator, then verified and logged">

<sub>The 59-second tour, looping: one request is routed, planned read-only, approved once and verified.</sub>

</div>

---

## What is J/OS HQ?

**J/OS HQ is a self-hosted, local-first command center that orchestrates AI agents acting on real
business systems.** You type a request once, in a local browser dashboard. HQ works out which
business workspace it belongs to and plans it in a read-only session against the live connected
systems. It then hands the plan to an executor agent:
[Claude Code](https://claude.com/product/claude-code) by [Anthropic](https://www.anthropic.com) in
one workspace, [Codex CLI](https://github.com/openai/codex) by [OpenAI](https://openai.com) in the
other. Its guardrails dry-run every external write (send, create, delete, publish, charge) and hold
it until the operator approves the exact payload; that payload then runs exactly once. HQ also
checks the account behind every write, so a request never runs against the wrong organization's
connections. It verifies the real outcome, logs every task twice in plain Markdown, and listens on
`127.0.0.1` only. It is a Next.js 16 and TypeScript app, and it reaches third-party platforms
through the [One](https://www.withone.ai) CLI and One Flows, never through direct API calls.

This repository is the HQ application, published as a portfolio project. The code is real and runs
daily. People, companies and connection names in it are stand-ins.

## Why put a human approval gate in front of AI agents?

An agent that can send email, raise invoices or publish needs guardrails: a wrong guess must never
reach a real customer. HQ is built around the three ways that goes wrong:

| Risk | What HQ does about it |
|---|---|
| The agent acts as the wrong account | Each workspace folder is its own account. HQ checks the project root and account email before every write, and a mismatch blocks rather than warns. |
| The plan relies on a capability that isn't there | Plans are checked against live connections and against the gateway's own record of which action docs were actually read. Anything unchecked is flagged. |
| A side effect nobody approved | Executors reach platforms only through a gateway that refuses any write that is not an approved, hashed payload. |

A human approval gate means nothing with a side effect runs until a person has seen it. Before
Claude Code or Codex CLI can send an email, raise an invoice, publish a post or charge a card, HQ
dry-runs the action and shows the operator the exact payload it would send, not a summary of it.
Once approved, HQ hashes that payload and runs only that exact payload, and only once: one approval
is one send. The same gate catches the other two failures, an agent acting as the wrong account and
a plan that relies on a capability nobody confirmed, because every write passes the identity check
and every step is checked against what was actually looked up. In Auto mode the operator's standing
approval replaces the wait, but HQ's own dry-run and validation still run on every action, and
anything it cannot validate still stops for a person.

## How does J/OS HQ work?

Every task moves through six fixed stations, the same test strip you see in the UI and the video:

| # | Station | What happens |
|---|---|---|
| 1 | **Compose** · route and plan | HQ routes the request: an explicit choice first, then named people and flows, then which workspace holds a live connection for it. If that still leaves doubt, it asks instead of guessing. It checks the logs for a close repeat (at least 0.75 overlap on content words), and otherwise plans in a read-only session bounded to 10 minutes. |
| 2 | **Test strip** · preview | The executor runs in preview. It resolves real IDs and dry-runs every write to propose it, while the gateway refuses any write. |
| 3 | **Expose** · approve | You see each proposed action with its exact payload and HQ's own dry-run, and approve or reject it. |
| 4 | **Develop** · execute once | The approved payload runs exactly once, and only if its hash matches what you approved. |
| 5 | **Fix** · verify | HQ verifies the outcome, not the exit code: a sent-message ID, a read-back of the created record, a flow's terminal event. |
| 6 | **Dry** · log | The task is logged twice, once when it is routed and once when its result has been evaluated. An interrupted task is never reported as done. |

## Features

J/OS HQ's guardrails run in a local dashboard on your own machine. Routing, planning, approval and
verification are enforced in code, not left to an agent's own judgment.

- **Routes every request to the right business.** Two executor workspaces (here called **One** and
  **Studio**) each authenticate as a different account. A wrong guess would run live actions
  against the wrong organization, so HQ asks rather than guesses.
- **Plans before it acts.** Each new task gets a read-only planning session inside its target
  workspace. The session inspects real connections and reads every action's documentation before
  it proposes a step.
- **Skips work it has already done.** A close repeat of a finished task reuses that task's plan as
  a reference. A single read-only lookup on one connection can take a fast path that skips
  planning, and it still runs where no write is possible.
- **Gates side effects in code.** Every external tool call an agent makes (send, create, delete,
  publish, charge) is dry-run first, approved as an exact payload, hashed, and then executed exactly
  once. In Auto mode your standing approval replaces the wait, but HQ's own dry-run and validation
  still apply.
- **Pins runtimes and proves them.** Each workspace runs a fixed harness, model and reasoning effort
  for planning and for execution. HQ checks every launch against its pin, and blocks rather than
  quietly substituting another model.
- **One task at a time per workspace.** Each business has its own line, the two lines never wait on
  each other, and the line survives restarts.
- **Sub-agents with enforced scope.** You build an agent from two answers: which connections, and how
  it may use them. HQ writes its operating procedure and guardrails, and the gateway allows the
  agent only its own connections.
- **Workflows are One Flows.** Multi-step automations are built, validated and dry-run as
  [One Flow](https://www.withone.ai/products/flows) dependency graphs, not shell scripts.
- **Submit issue.** A failed task can become a GitHub issue. HQ scrubs names, emails, connection
  names and IDs from the report, and you read it before it is filed.
- **Locked down by default.** HQ listens on `127.0.0.1` only, and its API needs a per-user access key
  and a same-origin request.

## How is it different from running Claude Code or Codex CLI directly?

HQ does not replace Claude Code or Codex CLI; it orchestrates them. It runs each agent as the
executor for one workspace, and adds the parts a business needs around it:

| Aspect | An agent on its own | The same agent under J/OS HQ |
|---|---|---|
| **Account** | Whatever the shell is logged in to | Checked before every write; a mismatch blocks |
| **Side effects** | Governed by the agent's own permission prompts | Dry-run, exact-payload approval, hash-checked, exactly once |
| **Plan** | Formed as it goes | Read-only planning session, checked against live connections |
| **Done means** | The command succeeded | The real outcome was read back |
| **Record** | Terminal scrollback | Markdown logs, written twice per task |
| **Concurrency** | Anything goes | One task per workspace, queued in order |

## Architecture

```text
                    Operator (browser, 127.0.0.1:4610)
                                  |
                              J/OS HQ  (Next.js app, SQLite telemetry, Markdown logs)
     understand -> route -> check logs -> plan (read-only) -> validate -> prompt -> dispatch
                                  |
              +-------------------+-------------------+
              |                                       |
       JOS/One  workspace                      JOS/Studio  workspace
       Claude Code executor                    Codex CLI executor
       own One account                         own One account
              |                                       |
        One gateway (dry-run, approval, exactly-once execution, connection scope)
              |                                       |
                      One CLI  ->  third-party platforms
```

The design rests on a few decisions:

| Decision | Why |
|---|---|
| The workspace folder is the account boundary | The One CLI resolves credentials by working directory, so HQ checks `projectRoot` and the account email before every write. A mismatch blocks rather than warns. |
| The planner is reasoning; the environment is truth | A plan is checked against live connections and against the gateway's record of which actions were actually looked up. |
| Approval is enforced, not requested | The gateway dry-runs every action to learn the real request, and refuses any write that isn't an approved, hashed payload. |
| Tool success is not objective success | A task is complete only after its outcome is verified: sent-message IDs, a read-back of the created record, and the terminal event of a flow run. |

## Tech stack

- **App:** [Next.js](https://nextjs.org) 16, [React](https://react.dev) 19,
  [TypeScript](https://www.typescriptlang.org), [Tailwind CSS](https://tailwindcss.com) 4
- **State:** Node's built-in [SQLite](https://nodejs.org/api/sqlite.html) (WAL) for telemetry, and
  Markdown logs as the durable record
- **Executors:** [Claude Code](https://code.claude.com/docs/en/overview) by Anthropic (One workspace)
  and [Codex CLI](https://github.com/openai/codex) by OpenAI (Studio workspace)
- **Integrations:** the [One](https://www.withone.ai) CLI (actions, flows, relay), reached only
  through HQ's gateway
- **Tests:** [Vitest](https://vitest.dev) (unit and integration) and [Playwright](https://playwright.dev)
  (end to end, against a fake One CLI)
- **Design:** a darkroom theme in greyscale with one amber safelight, set in
  [JetBrains Mono](https://www.jetbrains.com/lp/mono/) (see [`jos-hq/DESIGN.md`](jos-hq/DESIGN.md))

## Repository layout

```text
jos-hq/
  app/            pages: dashboard, chats, tasks, agents, connections, workflows
  components/     the UI (a darkroom theme: greyscale and one amber accent)
  lib/server/     orchestrator, routing, planning, dispatch, approvals, queue, logs, issues
  gateway/        the One gateway and guard that executors run behind
  bin/jos.mjs     CLI: dispatch a prepared prompt through HQ
  tests/          unit, integration and e2e suites
  DESIGN.md       the design system
```

## Run it locally

HQ expects to live at `JOS/jos-hq`, next to its two workspaces, each with its own One CLI project
config (`one init` in each folder, project scope):

```text
JOS/
  jos-hq/     this app
  One/        executor workspace A
  Studio/     executor workspace B
```

```powershell
cd JOS/jos-hq
npm install
npm run build
npm run start          # http://127.0.0.1:4610
npm test               # unit and integration
npm run test:e2e       # end to end, against a fake One CLI
```

Set the expected account for each scope, and the runtime pins, in `jos-hq/jos-hq.config.json`. The
values there are placeholders. HQ writes a per-user access key on its first request, and a browser
gets in through HQ's own launcher; `jos-hq/README.md` explains both.

## FAQ

**Is J/OS HQ open source?**
No. The source is published to be read and evaluated, under a view-only license. You may run it
privately to evaluate it; reuse needs permission. See [LICENSE](LICENSE).

**Which AI agents does it run?**
[Claude Code](https://claude.com/product/claude-code) by Anthropic plans and executes in the One
workspace. [Codex CLI](https://github.com/openai/codex) by OpenAI runs in the Studio workspace, with
one pinned model for planning and another for execution. Each pin is checked at every launch.

**How does it orchestrate Claude Code and Codex CLI together?**
Each request goes to exactly one workspace, and that workspace's own pinned agent plans and executes
it end to end: Claude Code in One, Codex CLI in Studio. Each workspace runs one task at a time, the
two workspaces' lines never wait on each other, and every launch is checked against its pinned
model and reasoning effort before it counts as started.

**Can an agent send an email or charge a card without my approval?**
Not through HQ. The gateway dry-runs every action and refuses any external write that is not an
approved, hashed payload. Auto mode is your standing approval, but HQ still validates every action
and stops on anything it could not validate.

**Does it need a cloud server?**
No. HQ runs on your machine and listens on `127.0.0.1` only. The only outside calls are the agents'
own model calls and the platform calls that go through One.

**What are One and One Flow?**
[One](https://www.withone.ai) is an integration platform whose CLI gives an agent authenticated
actions on third-party platforms. [One Flow](https://www.withone.ai/products/flows) is its workflow
engine. HQ builds every workflow as a One Flow dependency graph, then validates and dry-runs it
before it counts as done.

**Are the names in the repository real?**
No. People, companies, email addresses and connection names are stand-ins, and so is every name in
the video.

## License

All rights reserved. You may read the code and run it privately to evaluate it; reuse needs
permission. See [LICENSE](LICENSE).

---

Built by [@janmm97](https://github.com/janmm97) with [Claude Code](https://claude.com/product/claude-code).
