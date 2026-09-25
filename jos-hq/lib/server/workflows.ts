// J4 "Run": a One Flow is run by its owning executor through the normal pipeline. The owner comes
// from live `flow list` (never from a directory listing or the flow's name). The PREVIEW phase
// inspects, validates and dry-runs the flow and proposes its execution with exact inputs; HQ re-runs
// `flow validate` and a dry-run itself; the operator approves; EXECUTE runs it once via jos-approved.
import { isWorkspaceId, type WorkspaceId } from "./env";
import { run } from "./db";
import { listFlows } from "./one/discovery";
import { submitTask } from "./orchestrator";
import { createChat } from "./tasks";
import { newId } from "./util/ids";
import { nowIso } from "./util/time";
import type { TaskMode } from "./executors/types";

export async function runWorkflow(id: string, mode: TaskMode, inputs: Record<string, string> = {}) {
  const i = id.indexOf(":");
  const ws = id.slice(0, i);
  const key = id.slice(i + 1);
  if (!isWorkspaceId(ws) || !key) throw new Error(`Invalid workflow id "${id}"`);
  const flows = await listFlows(ws);
  if (!flows.flows) throw new Error(`Flow discovery failed for ${ws}: ${flows.error}`);
  const flow = flows.flows.find((f) => f.key === key);
  if (!flow) throw new Error(`No workflow "${key}" exists in ${ws} (live flow list).`);
  const chat = createChat(`Run workflow: ${flow.name || key}`);
  const inputText = Object.keys(inputs).length ? ` Operator-provided inputs: ${JSON.stringify(inputs)}.` : "";
  const text = `Run the One Flow "${flow.name || key}" (key ${key}) that lives in the ${ws} workspace.${inputText} Read the flow's description and inputs (flow list), validate it, and dry-run it with the inputs it needs. Propose its execution as a one_flow action with the exact inputs for operator approval; after approval run it once with jos-approved, then verify the real outcome (flow inspect of the run, and a read of the resulting state).`;
  const task = submitTask({ chatId: chat.id, text, displayText: `Run workflow “${flow.name || key}” (${ws})`, routeSelection: ws, mode, origin: "workflow", flow: { workspace: ws, key }, title: `Run ${flow.name || key}` });
  const runId = newId("wfr");
  run("INSERT INTO workflow_runs(id, task_id, workspace, flow_key, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)", [runId, task.id, ws, key, nowIso()]);
  run("UPDATE tasks SET context_json = json_set(COALESCE(context_json, '{}'), '$.workflowRunId', ?) WHERE id = ?", [runId, task.id]);
  return { taskId: task.id, chatId: chat.id, runId, workspace: ws as WorkspaceId };
}

export function recordWorkflowRunResult(runId: string, status: string) {
  const label = status === "completed" ? "Verified" : status === "unverified" ? "Ran (unverified)" : status === "rejected" ? "Rejected" : status === "cancelled" ? "Cancelled" : status === "needs_reconciliation" ? "Needs reconciliation" : "Failed";
  run("UPDATE workflow_runs SET status = ?, ended_at = ? WHERE id = ?", [label, nowIso(), runId]);
}
