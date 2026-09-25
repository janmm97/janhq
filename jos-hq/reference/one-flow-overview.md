# One Flow — overview

Copied from https://www.withone.ai/products/flows on 2026-09-24 for J/OS planning sessions, which
have no web access. The One skill's references/flows.md is authoritative for syntax.

- A flow is JSON with a consistent structure: steps, data references, branching, retries, loops
  and reusable sub-flows.
- Step types:
  - action: call any API across 851+ platforms with managed auth
  - transform: reshape data with JMESPath expressions
  - code: run inline JavaScript for custom logic
  - condition: branch on if/then/else with selector-based expressions
  - loop: iterate over arrays with per-item step execution
  - parallel: run multiple steps concurrently with configurable limits
  - while: repeat steps until a condition is met
  - paginate: auto-paginate through list APIs, collecting all results
  - flow: reuse sub-flows as building blocks
  - file-read: load data from local files into the workflow
  - file-write: persist output to files
  - bash: run shell commands when system access is needed
- Data between steps: selectors such as `$.steps.<stepId>.response.<field>`; string fields
  support `{{ }}` template interpolation.
- Error handling per step: retry (count, delay, exponential backoff), continue (log and move on
  for non-blocking steps), fallback (route execution to an alternate step when the primary
  fails). Steps can be guarded with `if` and `unless`.
- Testing: a dry run validates selectors, templates, auth and step dependencies without calling
  any API; mock mode simulates API responses for end-to-end tests without touching production.
- Interruption: Ctrl+C saves state, and `one flow resume` picks up exactly where the run stopped.
