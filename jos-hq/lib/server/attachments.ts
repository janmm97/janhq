// Local attachment store. Files are written under jos-hq/data/uploads/<chat>/ and never uploaded
// anywhere; an executor reads them in place (read-only) when a task references them.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { run, all } from "./db";
import { uploadsDir } from "./env";
import { newId } from "./util/ids";
import { nowIso } from "./util/time";

export const MAX_BYTES = 25 * 1024 * 1024;

function safeName(name: string): string {
  const base = path.basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "_").slice(0, 120);
  return base || "file";
}

export async function saveAttachment(chatId: string | null, file: File) {
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than ${MAX_BYTES / 1024 / 1024} MB`);
  const id = newId("att");
  const dir = path.join(/*turbopackIgnore: true*/ uploadsDir(), chatId ?? "no-chat");
  fs.mkdirSync(dir, { recursive: true });
  const stored = path.join(dir, `${id}-${safeName(file.name)}`);
  const buf = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(stored, buf, { flag: "wx" });
  const sha256 = createHash("sha256").update(buf).digest("hex");
  run("INSERT INTO attachments(id, chat_id, task_id, original_name, stored_path, size, sha256, mime, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)", [
    id,
    chatId,
    safeName(file.name),
    stored,
    buf.length,
    sha256,
    file.type || null,
    nowIso(),
  ]);
  return { id, name: safeName(file.name), size: buf.length, sha256 };
}

export function deleteUnusedAttachment(id: string): boolean {
  const rows = all<{ stored_path: string; task_id: string | null }>("SELECT stored_path, task_id FROM attachments WHERE id = ?", [id]);
  const r = rows[0];
  if (!r || r.task_id) return false;
  try {
    fs.unlinkSync(r.stored_path);
  } catch {
    /* already gone */
  }
  run("DELETE FROM attachments WHERE id = ?", [id]);
  return true;
}

/** Removes a deleted chat's uploads folder. Only a folder directly under uploads/ is ever removed. */
export function removeChatUploads(chatId: string) {
  const root = path.resolve(uploadsDir());
  const dir = path.resolve(root, chatId);
  if (path.dirname(dir) !== root) return;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
