// Per-execution policy written by the HQ dispatch service. Read-only for the executor.
import { readFileSync } from "node:fs";

export function loadPolicy() {
  const file = process.env.JOS_HQ_POLICY_FILE;
  const executionId = process.env.JOS_HQ_EXECUTION_ID;
  if (!file || !executionId || !process.env.JOS_HQ_SERVER || !process.env.JOS_HQ_GATEWAY_NONCE) {
    return { ok: false, error: "not running under a J/OS HQ dispatch (JOS_HQ_* environment missing)" };
  }
  try {
    const policy = JSON.parse(readFileSync(file, "utf8"));
    if (policy.executionId !== executionId) {
      return { ok: false, error: "policy file does not belong to this execution" };
    }
    return { ok: true, policy };
  } catch (e) {
    return { ok: false, error: `cannot read HQ policy file: ${e instanceof Error ? e.message : String(e)}` };
  }
}
