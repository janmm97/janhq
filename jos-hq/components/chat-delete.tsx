"use client";

import { useCallback, useState } from "react";
import { ApiError, apiSend } from "@/lib/client/api";
import { STATUS_TEXT } from "@/lib/client/format";
import { Button, Modal } from "./ui";

export function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M2.5 3.5h9M5.5 3.5V2.3h3v1.2M3.7 3.5l.6 8.2h5.4l.6-8.2M5.8 6v3.6M8.2 6v3.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface BusyTask {
  id: string;
  title: string;
  status: string;
}

/**
 * Confirms, then deletes a chat: its messages and attachments go, its task history and log entries
 * stay. HQ refuses while one of its tasks is running, waiting on the operator, or unreconciled.
 */
export function DeleteChatDialog({ chat, onClose, onDeleted }: { chat: { id: string; title: string } | null; onClose: () => void; onDeleted: (id: string) => void }) {
  const [working, setWorking] = useState(false);
  const [refused, setRefused] = useState<{ message: string; tasks: BusyTask[] } | null>(null);
  const close = useCallback(() => {
    setRefused(null);
    onClose();
  }, [onClose]);
  if (!chat) return null;

  const remove = async () => {
    setWorking(true);
    try {
      await apiSend("DELETE", `/api/chats/${chat.id}`);
      setRefused(null);
      onDeleted(chat.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === "CHAT_NOT_FOUND") {
        setRefused(null);
        onDeleted(chat.id); // already gone, which is what was asked
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
      onClose={close}
      title="Delete this chat?"
      testId="delete-chat-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Keep it
          </Button>
          {!refused && (
            <Button variant="danger" onClick={() => void remove()} disabled={working} data-testid="delete-chat-confirm">
              {working ? "Deleting…" : "Delete chat"}
            </Button>
          )}
        </>
      }
    >
      <p className="break-words text-[13.5px] font-medium text-paper">{chat.title}</p>
      {refused ? (
        <div className="mt-2 space-y-2 text-[13px] text-silver-hi" role="alert">
          <p>{refused.message}</p>
          {refused.tasks.length > 0 && (
            <ul className="space-y-1">
              {refused.tasks.map((t) => (
                <li key={t.id} className="text-silver">
                  {t.title} · {STATUS_TEXT[t.status] ?? t.status}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="mt-2 text-[13px] text-silver-hi">Its messages and attachments are removed. Its task history and log entries are kept.</p>
      )}
    </Modal>
  );
}
