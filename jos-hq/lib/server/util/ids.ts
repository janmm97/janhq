import { randomBytes } from "node:crypto";

function stamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Sortable, readable IDs: jos_20260923T031500_a1b2c3 (tasks double as J/OS run IDs). */
export function newId(prefix: "jos" | "exe" | "apr" | "chat" | "msg" | "att" | "conv" | "amsg" | "wfr"): string {
  return `${prefix}_${stamp()}_${randomBytes(3).toString("hex")}`;
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}
