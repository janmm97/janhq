#!/usr/bin/env node
// One batched screenshot round for the redesign's inspection (Tasks/HQ-Redesign-Plan-2026-09-25.md, Task 11):
// every page of live HQ at 1440 and 390 wide. Read-only: it opens pages, types a purpose into New agent (which
// only asks HQ for suggestions and a draft) and opens the health drawer. It never clicks Write, Send or Approve.
// Usage: node scripts/review-shots.mjs <round>   (saves to .impeccable/review/<round>/)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.JOS_HQ_URL ?? "http://127.0.0.1:4610";
const round = process.argv[2] ?? "round-1";
const out = path.join(app, ".impeccable", "review", round);
fs.mkdirSync(out, { recursive: true });
// HQ's access key (lib/server/access.ts): JOS_HQ_ACCESS_KEY_FILE, else %LOCALAPPDATA%\JOS\hq\access.key.
function hqKey() {
  const f = process.env.JOS_HQ_ACCESS_KEY_FILE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "JOS", "hq", "access.key");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : "";
}
const KEY = hqKey();
const keyed = { headers: { "x-jos-key": KEY } };
const cookie = { cookies: [{ name: "joshq", value: KEY, domain: new URL(base).hostname, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Strict" }], origins: [] };

const chats = (await (await fetch(`${base}/api/chats`, keyed)).json()).chats ?? [];
const agents = (await (await fetch(`${base}/api/agents?workspace=One`, keyed)).json()).agents ?? [];
const pages = [
  ["dashboard", "/"],
  ["agents-one", `/agents?ws=One${agents[0] ? `&agent=${encodeURIComponent(agents[0].key)}` : ""}`],
  ["agents-Studio", "/agents?ws=Studio"],
  ["connections", "/connections"],
  ["workflows", "/workflows"],
  ["new-agent", "/agents/new?workspace=One"],
  ...(chats[0] ? [["chat", `/chat/${chats[0].id}`]] : []),
];

const browser = await chromium.launch({ channel: "chrome" });
let saved = 0;
for (const [width, height] of [
  [1440, 900],
  [390, 844],
]) {
  const page = await browser.newPage({ viewport: { width, height }, storageState: cookie });
  const shot = async (name, fullPage = true) => {
    await page.screenshot({ path: path.join(out, `${name}-${width}.png`), fullPage });
    saved++;
  };
  for (const [name, url] of pages) {
    await page.goto(base + url);
    await page.waitForTimeout(2500); // live data settles; a fresh result finishes developing
    await shot(name);
  }
  // A populated New agent: suggestions and the SOP preview from a typed purpose, nothing written.
  await page.goto(`${base}/agents/new?workspace=One`);
  await page.getByLabel("What is it for?").fill("Triage the Main Support inbox and draft replies for review");
  await page.waitForTimeout(3000);
  await shot("new-agent-filled");
  await page.goto(`${base}/`);
  await page.getByTestId("runtime-indicator").click();
  await page.getByTestId("health-drawer").waitFor();
  await page.waitForTimeout(1500);
  await shot("health", false);
  await page.close();
}
await browser.close();
fs.copyFileSync(path.join(out, "dashboard-1440.png"), path.join(app, ".impeccable", "review", "desktop.png"));
fs.copyFileSync(path.join(out, "dashboard-390.png"), path.join(app, ".impeccable", "review", "mobile.png"));
console.log(`saved ${saved} screenshots to ${path.relative(app, out)}`);
