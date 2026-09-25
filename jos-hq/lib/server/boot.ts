// One-time server boot: open the database, reconcile anything a previous HQ process left running
// (never marking it complete by assumption), and warm the runtime health report.
import { db } from "./db";
import { reconcileAfterRestart } from "./dispatch";
import { kickLines, lineTick, reconcileTasksAfterRestart } from "./orchestrator";
import { healthReport } from "./health";
import { emit } from "./events";

const g = globalThis as unknown as { __josBoot?: Promise<void> };

export function ensureBoot(): Promise<void> {
  g.__josBoot ??= (async () => {
    db();
    const execs = await reconcileAfterRestart();
    const tasks = await reconcileTasksAfterRestart();
    if (execs || tasks) {
      emit({ system: "hq", type: "hq_restart_reconciled", level: "warning", visibility: "chat", summary: `HQ started: ${execs} execution(s) and ${tasks} task(s) from a previous run could not be proven finished and were marked interrupted or needs-reconciliation.` });
    }
    // Waiting tasks keep their places across a restart: start whoever is first in each line now.
    kickLines();
    // And once a minute, for what no event reports: an orphaned executor exiting on its own.
    setInterval(() => void lineTick().catch(() => undefined), 60_000).unref();
    void healthReport({ fresh: true }).catch(() => undefined);
  })();
  return g.__josBoot;
}
