"use client";

import { useState } from "react";
import { ApiError, apiSend } from "@/lib/client/api";
import { STATUS_TEXT } from "@/lib/client/format";
import { Button, Modal } from "./ui";

interface BusyTask {
  id: string;
  title: string;
  status: string;
}

/** Lists the tasks HQ named when it refused to change an agent. */
export function BusyTasks({ tasks }: { tasks: BusyTask[] }) {
  if (!tasks.length) return null;
  return (
    <ul className="space-y-1">
      {tasks.map((t) => (
        <li key={t.id} className="text-silver">
          {t.title} · {STATUS_TEXT[t.status] ?? t.status}
        </li>
      ))}
    </ul>
  );
}

/**
 * Confirms, then deletes a sub-agent: its definition and folder (SOP.md, LOGS.md) move to
 * jos-hq/data/agent-history/ and its conversations go; its task history and log entries stay. HQ
 * refuses while one of its tasks is busy.
 */
export function DeleteAgentDialog({ agent, conversations, onClose, onDeleted }: { agent: { workspace: string; key: string }; conversations: number; onClose: () => void; onDeleted: () => void }) {
  const [working, setWorking] = useState(false);
  const [refused, setRefused] = useState<{ message: string; tasks: BusyTask[] } | null>(null);

  const remove = async () => {
    setWorking(true);
    try {
      await apiSend("DELETE", `/api/agents/${agent.workspace}/${encodeURIComponent(agent.key)}`);
      onDeleted();
    } catch (e) {
      if (e instanceof ApiError && e.code === "AGENT_NOT_FOUND") {
        onDeleted(); // already gone, which is what was asked
        return;
      }
      const tasks = e instanceof ApiError ? ((e.details as { tasks?: BusyTask[] } | null)?.tasks ?? []) : [];
      setRefused({ message: e instanceof Error ? e.message : String(e), tasks });
    } finally {
      setWorking(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Delete this agent?"
      testId="delete-agent-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          {!refused && (
            <Button variant="danger" onClick={() => void remove()} disabled={working} data-testid="delete-agent-confirm">
              {working ? "Deleting…" : "Delete agent"}
            </Button>
          )}
        </>
      }
    >
      <p className="break-words text-[13.5px] font-semibold text-paper">{agent.key}</p>
      {refused ? (
        <div className="mt-2 space-y-2 text-[13px] text-silver-hi" role="alert">
          <p>{refused.message}</p>
          <BusyTasks tasks={refused.tasks} />
        </div>
      ) : (
        <p className="mt-2 text-[13px] text-silver-hi">
          Its definition, SOP.md and LOGS.md move to <span className="text-paper">jos-hq/data/agent-history/</span>, and its {conversations} {conversations === 1 ? "conversation is" : "conversations are"} deleted. Its task history and log entries are kept, and the name becomes free.
        </p>
      )}
    </Modal>
  );
}
