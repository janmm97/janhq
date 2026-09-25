# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One operator: Jan, alone at his own Windows desktop. HQ binds to 127.0.0.1, so nobody else
reaches it. He is an expert who knows J/OS's terms (One, Studio, Orchestrator, executors,
planners, SOPs, One Flows) and works in HQ for long stretches, alongside the executors' own
sessions.

## Product Purpose

J/OS HQ is the command center of J/OS, a system in which a root Orchestrator routes each
task to one of two executor workspaces, One and Studio, each on its own account. HQ is the only
thing that starts an executor. The operator uses it to send tasks, watch them route, plan and
run, approve the exact side effects they propose, reconcile interrupted runs, and manage
sub-agents, connections and One Flows.

Success: at any moment the operator can tell what is running, what is waiting on him and what
happened, and can act on it in one step.

## Positioning

Every action passes through gates HQ enforces in code and shows on screen: pinned models
proven at launch, identity checks, read-only planning sessions, approval of the exact payload,
and logs that only HQ writes. The interface shows evidence (runs, events, payload hashes, log
entries), not claims.

## Operating Context

- Tasks take seconds to many minutes. Approvals and intent questions interrupt them and wait
  for the operator.
- One task runs at a time in each workspace; the rest wait in line.
- The record lives in Markdown logs (`ONEMEMORY.md`, `STUDIOMEMORY.md`, `JOSMEMORY.md`, and
  each sub-agent's `LOGS.md`). HQ's SQLite database is telemetry.
- Third-party platforms are reached only through the One CLI, from the executor's own
  directory.

## Capabilities and Constraints

- Surfaces: Dashboard (J1), Agents (J2), Connections (J3), Workflows (J4), chats, task
  pages, Runtime Health, and the approval and confirmation dialogs. The current navigation
  numbers the four sections J1–J4.
- Local only: no external services or CDNs for the UI; fonts are self-hosted.
- Next.js 16, React 19 and Tailwind 4. Playwright end-to-end tests pin behaviour and
  keyboard operation.
- Terms used as-is: One and Studio, Orchestrator, planner, executor, PREVIEW and EXECUTE, the
  Manual / Edit automatically / Plan / Auto modes, SOP.md, LOGS.md, One Flow.

## Brand Commitments

- Name: J/OS; this product is J/OS HQ.
- Typeface: JetBrains Mono (the operator's binding choice, 2026-09-24).

## Evidence on Hand

Real tasks, runs, events, logs, connections, flows and sub-agents from both workspaces. Nothing
may be invented: no fabricated tasks, metrics, agents, connections or results.

## Product Principles

1. State first: what is running, what waits on the operator and what happened are visible
   without digging.
2. Show the proof: every claim of success carries the evidence HQ holds for it
   (verification, payload, log entry).
3. One step to act: approve, answer, reconcile or retry where the question appears.
4. Expert density: J/OS terms are used plainly, and explanation appears only where a
   decision is irreversible or outward-facing.

## Accessibility & Inclusion

Keyboard operable throughout (menus and dialogs close with Escape), with visible focus, and
respect for reduced motion.
