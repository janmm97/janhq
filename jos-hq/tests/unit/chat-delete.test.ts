import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// A throwaway J/OS root and database, so no real log, task or upload is touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-chat-delete-"));
const josRoot = path.join(tmp, "JOS");
beforeAll(() => {
  fs.mkdirSync(path.join(josRoot, "One"), { recursive: true });
  fs.mkdirSync(path.join(josRoot, "Studio"), { recursive: true });
});
process.env.JOS_HQ_JOS_ROOT = josRoot;
process.env.JOS_HQ_DATA_DIR = path.join(tmp, "data");

async function chatWithTask(status: string) {
  const { createChat, createTaskRow, updateTask, addMessage } = await import("@/lib/server/tasks");
  const chat = createChat("Delete me");
  const task = createTaskRow({ chatId: chat.id, origin: "chat", request: "Summarise the notes", mode: "auto", routeSelection: "auto", context: { clarifications: [] } });
  updateTask(task.id, { status: status as never });
  addMessage(chat.id, "user", "text", "Summarise the notes", task.id);
  return { chat, task };
}

// 2026-09-23: Jan asked to delete chats. Deleting removes the conversation; the record stays —
// tasks and their telemetry are kept, detached, and the memory logs are never touched.
describe("deleting a chat", () => {
  it("removes the chat, its messages, its attachments and its uploads folder, and keeps its tasks detached", async () => {
    const { deleteChat } = await import("@/lib/server/tasks");
    const { saveAttachment } = await import("@/lib/server/attachments");
    const { get, all } = await import("@/lib/server/db");
    const { uploadsDir } = await import("@/lib/server/env");
    const { chat, task } = await chatWithTask("completed");
    await saveAttachment(chat.id, new File(["notes"], "notes.txt", { type: "text/plain" }));
    const folder = path.join(uploadsDir(), chat.id);
    expect(fs.existsSync(folder)).toBe(true);

    expect(deleteChat(chat.id)).toEqual({ deleted: true });

    expect(get("SELECT id FROM chats WHERE id = ?", [chat.id])).toBeUndefined();
    expect(all("SELECT id FROM chat_messages WHERE chat_id = ?", [chat.id])).toEqual([]);
    expect(all("SELECT id FROM attachments WHERE chat_id = ?", [chat.id])).toEqual([]);
    expect(fs.existsSync(folder)).toBe(false);
    expect(get<{ chat_id: string | null; status: string }>("SELECT chat_id, status FROM tasks WHERE id = ?", [task.id])).toEqual({ chat_id: null, status: "completed" });
  });

  it("leaves the memory logs byte for byte as they were", async () => {
    const { deleteChat } = await import("@/lib/server/tasks");
    const { chat, task } = await chatWithTask("completed");
    const log = path.join(josRoot, "JOSMEMORY.md");
    const before = `# J/OS log\n\n## 2026-09-23 · Summarise <!-- jos:run=${task.id} -->\n\n- **Status:** done\n`;
    fs.writeFileSync(log, before);

    expect(deleteChat(chat.id)).toEqual({ deleted: true });
    expect(fs.readFileSync(log, "utf8")).toBe(before);
  });

  it.each(["in_line", "executing", "needs_clarification", "awaiting_approval", "interrupted", "needs_reconciliation"])("refuses while a task is %s, and changes nothing", async (status) => {
    const { deleteChat, chatMessages } = await import("@/lib/server/tasks");
    const { get } = await import("@/lib/server/db");
    const { chat, task } = await chatWithTask(status);

    expect(deleteChat(chat.id)).toEqual({ deleted: false, reason: "busy", tasks: [{ id: task.id, title: task.title, status }] });
    expect(get("SELECT id FROM chats WHERE id = ?", [chat.id])).toBeDefined();
    expect(chatMessages(chat.id)).toHaveLength(1);
    expect(get<{ chat_id: string }>("SELECT chat_id FROM tasks WHERE id = ?", [task.id])?.chat_id).toBe(chat.id);
  });

  it("refuses while an executor process may still be alive, even if its task already ended", async () => {
    const { deleteChat } = await import("@/lib/server/tasks");
    const { run } = await import("@/lib/server/db");
    const { chat, task } = await chatWithTask("failed");
    run(
      `INSERT INTO executions(id, task_id, phase, workspace, cwd, adapter, runtime, binary, model, effort, pid, status, created_at)
       VALUES ('exec_orphan', ?, 'execute', 'One', 'x', 'claude', 'claude', 'claude.exe', 'claude-opus-5', 'medium', 4242, 'needs_reconciliation', ?)`,
      [task.id, new Date().toISOString()],
    );

    expect(deleteChat(chat.id)).toMatchObject({ deleted: false, reason: "busy" });
  });

  it("reports a chat that does not exist", async () => {
    const { deleteChat } = await import("@/lib/server/tasks");
    expect(deleteChat("chat_nope")).toEqual({ deleted: false, reason: "not_found" });
  });

  it("writes no message into a chat that has been deleted", async () => {
    const { deleteChat, addMessage } = await import("@/lib/server/tasks");
    const { all } = await import("@/lib/server/db");
    const { chat, task } = await chatWithTask("completed");
    deleteChat(chat.id);

    expect(addMessage(chat.id, "assistant", "result", "Late result", task.id)).toBeNull();
    expect(all("SELECT id FROM chat_messages WHERE chat_id = ?", [chat.id])).toEqual([]);
  });
});
