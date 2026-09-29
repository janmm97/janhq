// policy.onlyCommands: an agent that may run only a few fixed commands (the GitHub Agent: `jos-check`).
// A command passes only when the whole of it, trimmed, is one of the names followed by plain words:
// no shell syntax at all (no ; & | < > $ backtick quotes parentheses, no newline or tab, no doubled
// space). The pattern has no ambiguity (the separator is not in the word class), so it is linear-time.
const NAME = /^[A-Za-z0-9._-]+$/;

export function onlyCommandsAllows(command, names) {
  if (!Array.isArray(names) || names.length === 0) return false;
  const cmd = String(command ?? "").trim();
  for (const name of names) {
    if (typeof name !== "string" || !NAME.test(name)) return false; // a malformed policy fails closed
    const escaped = name.replace(/[.-]/g, "\\$&");
    if (new RegExp(`^${escaped}( [A-Za-z0-9._/:=-]+)*$`).test(cmd)) return true;
  }
  return false;
}
