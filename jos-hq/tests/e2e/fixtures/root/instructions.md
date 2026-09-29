# J/OS (UI test stand-in)

A minimal instruction file for HQ's UI tests. scripts/e2e-server.mjs copies it into the throwaway J/OS
root as CLAUDE.md and AGENTS.md (the root and each workspace) only when the real files are not there to copy,
as in the GitHub Agent's sparse worktree, which holds jos-hq/ alone.
