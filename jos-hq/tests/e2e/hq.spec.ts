import { expect, test, type Page } from "@playwright/test";

async function newChat(page: Page) {
  await page.goto("/");
  await page.getByTestId("new-chat").click();
  await expect(page).toHaveURL(/\/chat\/chat_/);
  await expect(page.getByTestId("chat-empty")).toBeVisible();
}

async function pickRoute(page: Page, label: "Auto" | "One" | "Studio") {
  await page.getByTestId("composer-route").click();
  await page.getByRole("option", { name: new RegExp(`^${label}`) }).click();
}

async function sendText(page: Page, text: string) {
  const box = page.getByTestId("composer-input");
  await box.fill(text);
  await box.press("Control+Enter");
}

test("1 · navigation between J1–J4 keeps the shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Dashboard");
  for (const [name, url, heading] of [
    ["Agents", /\/agents/, "Agents"],
    ["Connections", /\/connections/, "Connections"],
    ["Workflows", /\/workflows/, "Workflows"],
    ["Dashboard", /\/$/, "Dashboard"],
  ] as const) {
    await page.getByRole("navigation", { name: "J/OS" }).getByRole("link", { name, exact: false }).first().click();
    await expect(page).toHaveURL(url);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
    await expect(page.getByTestId("new-chat")).toBeVisible();
  }
});

test("2 · New Chat opens the immersive chat with the exact text-only empty state", async ({ page }) => {
  await newChat(page);
  await expect(page.getByTestId("chat-title")).toHaveText("Untitled");
  const empty = page.getByTestId("chat-empty");
  await expect(empty.getByRole("heading")).toHaveText("Give J/OS a Tasks");
  await expect(empty).toContainText("Enter creates a new line. Send with Ctrl + Enter or the Send button.");
  await expect(empty.locator("svg, img")).toHaveCount(0);
  expect(await empty.innerText()).not.toMatch(/[*✦✳✱★☆]/);
  await expect(page.getByTestId("composer-input")).toHaveAttribute("placeholder", "Ask anything...");
});

test("3 · Enter and Shift+Enter insert newlines; only Ctrl+Enter sends", async ({ page }) => {
  await newChat(page);
  const box = page.getByTestId("composer-input");
  await box.click();
  await box.pressSequentially("Line one");
  await box.press("Enter");
  await box.pressSequentially("Line two");
  await box.press("Shift+Enter");
  await box.pressSequentially("Line three");
  await expect(box).toHaveValue("Line one\nLine two\nLine three");
  await expect(page.getByTestId("user-message")).toHaveCount(0);
  await box.press("Control+Enter");
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  await expect(page.getByTestId("user-message")).toHaveText("Line one\nLine two\nLine three");
  await expect(box).toHaveValue("");
});

test("4 · the route selector is an explicit selection that wins", async ({ page }) => {
  for (const ws of ["One", "Studio"] as const) {
    await newChat(page);
    await pickRoute(page, ws);
    await sendText(page, "Send Riley and Blake the scorecard");
    await expect(page.getByTestId("route-card")).toContainText(ws);
    await expect(page.getByTestId("route-reason")).toHaveText("Explicit user selection");
  }
});

test("5 · Auto routes decisive named entities to the right business", async ({ page }) => {
  await newChat(page);
  await sendText(page, "Ask Devin about the MSA timeline");
  await expect(page.getByTestId("route-card")).toContainText("One");
  await expect(page.getByTestId("route-reason")).toHaveText("Named entity: Devin");
  await newChat(page);
  await sendText(page, "Ask Blake about the catalogue schedule");
  await expect(page.getByTestId("route-card")).toContainText("Studio");
  await expect(page.getByTestId("route-reason")).toHaveText("Named entity: Blake");
});

test("6 · an ambiguous request asks a useful question and launches nothing", async ({ page }) => {
  await newChat(page);
  await sendText(page, "Tell Riley and Blake what the contract says");
  const card = page.getByTestId("clarify-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Riley");
  await expect(card).toContainText("Blake");
  await expect(card.getByRole("button", { name: "One" })).toBeVisible();
  await expect(page.getByTestId("task-progress")).toContainText("Needs your answer");
  await page.getByTestId("task-stop").click();
  await expect(page.getByTestId("result-card")).toContainText("Cancelled");
});

test("11 · an attached file shows as a chip, is stored by HQ only, and stays referenced on the sent message", async ({ page, baseURL }) => {
  const origins = new Set<string>();
  page.on("request", (r) => origins.add(new URL(r.url()).origin));
  await newChat(page);
  const chatId = page.url().split("/chat/")[1];
  const file = { name: "hq-attachment-test.txt", mimeType: "text/plain", buffer: Buffer.from("harmless attachment for the HQ UI test\n") };

  await page.locator('input[type="file"]').setInputFiles(file);
  const chips = page.getByRole("list", { name: "Attachments" });
  await expect(chips).toContainText("hq-attachment-test.txt");
  await page.getByRole("button", { name: "Remove hq-attachment-test.txt" }).click();
  await expect(chips).toHaveCount(0);

  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByRole("list", { name: "Attachments" })).toContainText("hq-attachment-test.txt");
  const stored = await (await page.request.get(`/api/chats/${chatId}`)).json();
  expect(stored.attachments.map((a: { original_name: string; size: number }) => [a.original_name, a.size])).toEqual([["hq-attachment-test.txt", file.buffer.length]]);

  await page.getByTestId("composer-input").fill("Summarize the attached note in one line");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  await expect(page.getByTestId("message-attachment")).toContainText("hq-attachment-test.txt");
  await expect(page.getByRole("list", { name: "Attachments" })).toHaveCount(0);
  // Nothing in the browser talked to anything but HQ itself.
  expect([...origins]).toEqual([new URL(baseURL!).origin]);
});

test("existing chats reopen from the sidebar with their history", async ({ page }) => {
  await newChat(page);
  const chatUrl = page.url();
  await page.getByTestId("composer-input").fill("Tidy up my notes from the offsite");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  await page.goto("/");
  await page.getByRole("list", { name: "Chats" }).getByRole("link", { name: /Tidy up my notes/ }).first().click();
  await expect(page).toHaveURL(chatUrl);
  await expect(page.getByTestId("user-message")).toHaveText("Tidy up my notes from the offsite");
});

test("a chat is deleted from the sidebar, only after it is confirmed", async ({ page }) => {
  const { chat } = await (await page.request.post("/api/chats", { headers: { "x-jos-hq": "1" }, data: { title: "Scratch chat to delete" } })).json();
  await page.goto("/");
  const chats = page.getByRole("list", { name: "Chats" });
  const del = chats.getByRole("button", { name: "Delete chat Scratch chat to delete" });

  await del.click();
  await page.getByTestId("delete-chat-dialog").getByRole("button", { name: "Keep it" }).click();
  await expect(page.getByTestId("delete-chat-dialog")).toHaveCount(0);
  await expect(chats).toContainText("Scratch chat to delete");

  await del.click();
  await page.getByTestId("delete-chat-confirm").click();
  await expect(chats).not.toContainText("Scratch chat to delete");
  expect((await page.request.get(`/api/chats/${chat.id}`)).status()).toBe(404);
});

test("deleting the open chat returns to the command center", async ({ page }) => {
  await newChat(page);
  const chatId = page.url().split("/chat/")[1];
  await page.getByTestId("chat-delete").click();
  await page.getByTestId("delete-chat-confirm").click();
  await expect(page).toHaveURL(/127\.0\.0\.1:4613\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Dashboard");
  expect((await page.request.get(`/api/chats/${chatId}`)).status()).toBe(404);
});

test("a chat whose task is waiting on you is kept, says why, and deletes once the task is stopped", async ({ page }) => {
  await newChat(page);
  const chatId = page.url().split("/chat/")[1];
  await sendText(page, "Tell Riley and Blake what the contract says");
  await expect(page.getByTestId("clarify-card")).toBeVisible();

  await page.getByTestId("chat-delete").click();
  await page.getByTestId("delete-chat-confirm").click();
  const dialog = page.getByTestId("delete-chat-dialog");
  await expect(dialog).toContainText("Stop or reconcile it first");
  await expect(dialog).toContainText("Needs your answer");
  await dialog.getByRole("button", { name: "Keep it" }).click();
  expect((await page.request.get(`/api/chats/${chatId}`)).status()).toBe(200);

  await page.getByTestId("task-stop").click();
  await expect(page.getByTestId("result-card")).toContainText("Cancelled");
  await page.getByTestId("chat-delete").click();
  await page.getByTestId("delete-chat-confirm").click();
  await expect(page).toHaveURL(/127\.0\.0\.1:4613\/$/);
});

test("12 · Connections is one table with exactly four columns, sorted A→Z", async ({ page }) => {
  await page.goto("/connections");
  const table = page.getByTestId("connections-table");
  await expect(table).toBeVisible();
  await expect(table.locator("thead th")).toHaveText(["Tool Name", "Agent", "Status", "Last Used"]);
  // The fake One CLI's rows: Gmail and Slack (One) and OpenRouter (the Orchestrator).
  await expect(table.locator("tbody tr")).toHaveCount(3);
  const names = await table.locator("tbody tr td:first-child > span:first-child").allInnerTexts();
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
});

test("13 · Workflows shows the truthful empty state, not sample cards", async ({ page }) => {
  await page.goto("/workflows");
  await expect(page.getByText("No workflows yet.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Workflows" })).toHaveCount(0);
});

test("J2 · an executor with no definitions says so", async ({ page }) => {
  await page.goto("/agents?ws=Studio");
  await expect(page.getByText("No sub-agents configured for Studio.").first()).toBeVisible();
});

test("10/11 · selecting an agent shows its conversations; the chat window docks, minimizes, restores, pops out and closes", async ({ page }) => {
  await page.goto("/agents?ws=One");
  await page.getByTestId("agent-row-one_fixture_researcher").click();
  await expect(page.locator("#agent-panel-title")).toHaveText("one_fixture_researcher conversations");
  await page.getByTestId("chat-with-agent").click();
  await expect(page.getByTestId("agent-chat-docked")).toBeVisible();

  const box = page.getByTestId("agent-composer-input");
  await box.click();
  await box.pressSequentially("first line");
  await box.press("Enter");
  await box.pressSequentially("second line");
  await expect(box).toHaveValue("first line\nsecond line");
  await expect(page.getByTestId("agent-user-message")).toHaveCount(0);

  await page.getByTestId("agent-chat-minimize").click();
  await expect(page.getByTestId("agent-chat-minimized")).toBeVisible();
  await page.getByTestId("agent-chat-restore").click();
  await expect(page.getByTestId("agent-chat-docked")).toBeVisible();
  await page.getByTestId("agent-chat-popout").click();
  await expect(page.getByTestId("agent-chat-popped")).toBeVisible();
  await page.getByTestId("agent-chat-dock").click();
  await expect(page.getByTestId("agent-chat-docked")).toBeVisible();

  await page.getByTestId("agent-composer-input").fill("research one line");
  await page.getByTestId("agent-composer-input").press("Control+Enter");
  await expect(page.getByTestId("agent-user-message")).toHaveCount(1);
  await page.getByTestId("agent-chat-close").click();
  await expect(page.getByTestId("agent-chat-docked")).toHaveCount(0);
  await page.getByRole("tab", { name: "Conversations" }).click();
  await expect(page.getByTestId("conversation-list")).toContainText("research one line");
});

async function openAgentSettings(page: Page, key: string) {
  await page.goto("/agents?ws=One");
  await page.getByTestId(`agent-row-${key}`).click();
  await page.getByRole("tab", { name: "Settings" }).click();
}

test("J2 · an agent is edited on its Edit page, HQ rewrites the SOP, and the test print opens its conversation", async ({ page }) => {
  await openAgentSettings(page, "one_fixture_editable");
  await page.getByTestId("agent-edit").click();
  await expect(page).toHaveURL(/\/agents\/One\/one_fixture_editable\/edit$/);
  const form = page.getByTestId("agent-form");
  await expect(form.getByRole("heading", { name: "Edit one_fixture_editable" })).toBeVisible();
  await expect(form.getByLabel("Name")).toBeDisabled();
  await expect(form.getByLabel("Name")).toHaveValue("one_fixture_editable");
  // The e2e copy's One has no Exa connection, so the one it was given shows as not connected, still chosen.
  await expect(form.getByRole("checkbox", { name: /Main Exa/ })).toBeChecked();
  await expect(form.getByRole("checkbox", { name: /Main Support/ })).toBeVisible();
  await expect(form).toContainText("not connected now");
  await expect(form.getByLabel("Anything else it must never do")).toHaveValue("Send, publish, delete or charge anything.");

  await form.getByLabel("Anything else it must never do").fill("Send, publish, delete or charge anything, or contact a person.");
  await expect(form.getByTestId("sop-preview")).toContainText("or contact a person.");
  await expect(form.getByTestId("sop-preview")).toContainText("## Guardrails (set by the J/OS Orchestrator)");
  await form.getByTestId("write-agent").click();
  await expect(form.getByTestId("write-result")).toContainText("Saved");

  const stored = await (await page.request.get("/api/agents/One/one_fixture_editable")).json();
  expect(stored.edit).toMatchObject({ editable: true, answers: { mustNever: "Send, publish, delete or charge anything, or contact a person.", connections: [{ platform: "exa", name: "Main Exa" }] } });

  // The test print sends the purpose as a Plan-mode message in a new conversation with the agent.
  await form.getByTestId("test-print-send").click();
  await form.getByTestId("test-print-open").click();
  await expect(page).toHaveURL(/\/agents\?ws=One&agent=one_fixture_editable&conversation=conv_/);
  await expect(page.getByTestId("agent-chat-docked")).toBeVisible();
  await expect(page.getByTestId("agent-user-message")).toHaveText("UI-test fixture only. HQ edits this definition in the isolated test instance.");
});

test("J2 · an agent is deleted only after it is confirmed, and its conversations go with it", async ({ page }) => {
  await page.request.post("/api/agents/One/one_fixture_disposable/conversations", { headers: { "x-jos-hq": "1" }, data: { title: "Thread to delete" } });
  await openAgentSettings(page, "one_fixture_disposable");
  await page.getByTestId("agent-delete").click();
  const dialog = page.getByTestId("delete-agent-dialog");
  await expect(dialog).toContainText("one_fixture_disposable");
  await expect(dialog).toContainText("1 conversation");
  await dialog.getByRole("button", { name: "Keep it" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("agent-row-one_fixture_disposable")).toBeVisible();

  await page.getByTestId("agent-delete").click();
  await page.getByTestId("delete-agent-confirm").click();
  await expect(page.getByTestId("agent-row-one_fixture_disposable")).toHaveCount(0);
  expect((await page.request.get("/api/agents/One/one_fixture_disposable")).status()).toBe(404);
  expect((await (await page.request.get("/api/agents/One/one_fixture_disposable/conversations")).json()).conversations).toEqual([]);
});

test("J2 · a definition HQ only reads offers neither edit nor delete, and says why", async ({ page }) => {
  await openAgentSettings(page, "one_fixture_researcher");
  await expect(page.getByTestId("agent-edit")).toBeDisabled();
  await expect(page.getByTestId("agent-delete")).toBeDisabled();
  await expect(page.getByTestId("agent-edit-reason")).toContainText("outside the Orchestrator-level agent folders");
});

test("J2 · the agent API refuses a stale edit, an unknown agent, and a request without the HQ header", async ({ page }) => {
  const h = { "x-jos-hq": "1" };
  const data = { connections: [{ platform: "exa", name: "Main Exa" }], purpose: "p", mayDo: "m", mustNever: "n", baseHash: "stale", confirm: true };
  const stale = await page.request.patch("/api/agents/One/one_fixture_editable", { headers: h, data });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error.code).toBe("AGENT_CHANGED");
  const unknown = await page.request.delete("/api/agents/One/one_nobody", { headers: h });
  expect(unknown.status()).toBe(404);
  expect((await unknown.json()).error.code).toBe("AGENT_NOT_FOUND");
  const unguarded = await page.request.delete("/api/agents/One/one_fixture_editable");
  expect((await unguarded.json()).error.code).toBe("CSRF_GUARD");
  expect((await page.request.get("/api/agents/One/one_fixture_editable")).status()).toBe(200);
});

test("runtime health is derived from checks, opens as a drawer and closes with Escape", async ({ page }) => {
  await page.goto("/");
  const indicator = page.getByTestId("runtime-indicator");
  await expect(indicator).not.toContainText("Checking", { timeout: 60_000 });
  // The UI-test instance runs on a J/OS copy without One project configs: it must NOT report Healthy.
  await expect(indicator).toContainText(/Blocked|Attention/);
  await indicator.click();
  await expect(page.getByTestId("health-drawer")).toBeVisible();
  await expect(page.getByTestId("health-drawer")).toContainText("Claude Code Opus 5.5 (medium)");
  await expect(page.getByTestId("health-drawer")).toContainText("GPT 6 Sol (medium)");
  // Each workspace's planner pin is shown with its executor's.
  await expect(page.getByTestId("health-drawer")).toContainText("gpt-6-astra · effort medium");
  await expect(page.getByTestId("health-drawer")).toContainText("claude-opus-5-5 · effort medium");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("health-drawer")).toHaveCount(0);
});

test("menus are keyboard operable and close with Escape", async ({ page }) => {
  await newChat(page);
  const mode = page.getByTestId("composer-mode");
  await expect(mode).toHaveAccessibleName("Mode: Auto");
  await mode.focus();
  await page.keyboard.press("ArrowDown");
  const list = page.getByRole("listbox", { name: "Mode" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("option")).toHaveText([/Manual/, /Edit automatically/, /Plan/, /Auto/]);
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await mode.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(mode).toHaveAccessibleName(/Mode: (Plan|Edit automatically)/);
});

test("the Needs-you chip shows what waits on the operator, opens it, and takes the keyboard", async ({ page }) => {
  await newChat(page);
  await sendText(page, "Tell Riley and Blake what the contract says");
  await expect(page.getByTestId("clarify-card")).toBeVisible();
  await expect(page.getByTestId("needs-you")).toBeVisible();
  await page.goto("/");
  const chip = page.getByTestId("needs-you");
  const { items } = await (await page.request.get("/api/attention")).json();
  expect(items.length).toBeGreaterThan(0);
  await expect(chip).toHaveText(`Needs you · ${items.length}`);
  await expect(chip).toHaveAttribute("href", items[0].href);

  // Keyboard: Tab from the search reaches the chip, which shows the safelight ring; Enter opens it.
  await page.locator("#jos-search").focus();
  await page.keyboard.press("Tab");
  await expect(chip).toBeFocused();
  expect(await chip.evaluate((el) => getComputedStyle(el).outlineColor)).toBe("rgb(255, 176, 0)");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL((u) => u.pathname === items[0].href);

  // Leave nothing waiting for the tests after this one.
  for (const i of items) await page.request.post(`/api/tasks/${i.taskId}/cancel`, { headers: { "x-jos-hq": "1" }, data: {} });
  await page.goto("/");
  await expect(page.getByTestId("needs-you")).toHaveCount(0);
});

test("a very long chat title stays on its line in the sidebar, and the tagline is gone", async ({ page }) => {
  const title = "A very long chat title that keeps going ".repeat(5).trim();
  await page.request.post("/api/chats", { headers: { "x-jos-hq": "1" }, data: { title } });
  await page.goto("/");
  const link = page.getByRole("list", { name: "Chats" }).getByRole("link", { name: title });
  await expect(link).toHaveAttribute("title", title);
  expect((await link.boundingBox())!.width).toBeLessThanOrEqual(264);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByText(/INTELLIGENCE/i)).toHaveCount(0);
});

test("J1 · the bench shows both bays with their pins and lines, a readout replaces the gauges, and finished work dries below", async ({ page }) => {
  await page.goto("/");
  for (const [ws, pins] of [
    ["One", "plans + executes on Claude Code Opus 5.5 · medium"],
    ["Studio", "plans on GPT 6 Astra · executes on GPT 6 Sol"],
  ] as const) {
    const bay = page.getByTestId(`bay-${ws}`);
    await expect(bay.getByRole("heading", { level: 2 })).toHaveText(ws);
    await expect(bay).toContainText(pins);
    await expect(bay).toContainText("Line empty.");
  }
  const circles = page.getByTestId("circles");
  await expect(circles.getByTestId("circle")).toHaveCount(7);
  for (const label of ["Completed", "In line", "Failed", "Abandoned", "Agents created", "Running", "Avg cost"]) await expect(circles).toContainText(label);
  await expect(circles).not.toContainText(" of ");
  await expect(circles).toContainText("$0.00");
  await expect(page.getByText("Tasks Completed")).toHaveCount(0);
  await expect(page.getByText("Recent activity")).toHaveCount(0);
  await expect(page.getByTestId("drying-line").or(page.getByText("No finished tasks in this range."))).toBeVisible();
});

test("the session row carries the strip, and a fresh result develops in unless motion is reduced", async ({ page }) => {
  for (const reduce of [false, true]) {
    await page.emulateMedia({ reducedMotion: reduce ? "reduce" : "no-preference" });
    await newChat(page);
    await sendText(page, "Tell Riley and Blake what the contract says");
    await expect(page.getByTestId("clarify-card")).toBeVisible();
    // Routing asked a question: the task waits on the operator at Compose.
    const strip = page.getByTestId("session-row").getByTestId("test-strip");
    await expect(strip.locator("li").first()).toContainText("Compose");
    await expect(strip.locator('li[aria-current="step"]')).toHaveAttribute("data-state", "waiting");
    await page.getByTestId("task-stop").click();
    const result = page.getByTestId("result-card");
    await expect(result).toContainText("Cancelled");
    expect(await result.evaluate((el) => getComputedStyle(el).animationName)).toBe(reduce ? "none" : "develop");
  }
});

test("J2 · New agent is a page: the key previews live, no live connection is said plainly, and Write waits for the answers", async ({ page }) => {
  await page.goto("/agents/new?workspace=One");
  const form = page.getByTestId("agent-form");
  await expect(form.getByRole("heading", { level: 1 })).toContainText("New agent");
  await form.getByLabel("What is it for?").fill("Triage the Main Support inbox and draft replies");
  await expect(form.getByTestId("agent-key")).toHaveText("→ one_triage_main_support · free");
  await expect(form.getByTestId("sop-preview")).toContainText("Triage the Main Support inbox and draft replies");
  // Exact: a pick's note ("Main Support" is named in the purpose) also labels its checkbox.
  await form.getByLabel("Name", { exact: true }).fill("support triage");
  await expect(form.getByTestId("agent-key")).toHaveText("→ one_support_triage · free");

  // The e2e copy's Studio has no live connections: the form says so, and Write waits for one.
  await page.goto("/agents/new?workspace=Studio");
  await form.getByLabel("What is it for?").fill("Summarise the week's catalogue schedule");
  await expect(form).toContainText("No live Studio connections");
  await expect(form.getByTestId("write-agent")).toBeDisabled();
  await expect(form.getByTestId("write-reason")).toContainText("Choose at least one connection.");
});

test("J2 · New agent suggests from the purpose, asks which one, keeps the operator's ticks, and writes", async ({ page }) => {
  await page.goto("/agents/new?workspace=One");
  const form = page.getByTestId("agent-form");
  const purpose = form.getByLabel("What is it for?");
  const settled = (text: string) => page.waitForResponse((r) => r.url().endsWith("/api/agents/suggest") && (r.request().postData() ?? "").includes(text));

  // 1. A connection the purpose names is ticked for the operator.
  await purpose.fill("Triage the Main Support inbox and draft replies");
  const fromPurpose = form.getByRole("group", { name: "From your purpose" });
  const support = fromPurpose.getByRole("checkbox", { name: /Main Support/ });
  await expect(support).toBeChecked();

  // 2. The operator's untick wins over a later suggestion of the same connection.
  await support.uncheck();
  const second = settled("tickets every morning");
  await purpose.fill("Triage Main Support tickets every morning");
  await second;
  await expect(support).not.toBeChecked();

  // 3. A platform with several connections and none named: HQ asks which one.
  await purpose.fill("Draft replies to customer emails");
  const which = form.getByRole("group", { name: "Which one? One has 2 Gmail connections." });
  await expect(which).toBeVisible();
  await expect(which.getByRole("checkbox", { name: /Main Support/ })).not.toBeChecked();

  // 4. The choices take the keyboard: Tab moves between them with the safelight ring; Space ticks.
  await which.getByRole("checkbox", { name: /Main Support/ }).focus();
  await page.keyboard.press("Tab");
  const jan = which.getByRole("checkbox", { name: /Main Operator/ });
  await expect(jan).toBeFocused();
  expect(await jan.evaluate((el) => getComputedStyle(el).outlineColor)).toBe("rgb(255, 176, 0)");
  await page.keyboard.press("Space");
  await expect(jan).toBeChecked();

  // 5. The default limits (read may; draft, send, delete never) satisfy Write.
  await form.getByLabel("Name", { exact: true }).fill("e2e suggest writer");
  await expect(form.getByTestId("agent-key")).toHaveText("→ one_e2e_suggest_writer · free");
  await form.getByTestId("write-agent").click();

  // 6. The result lists the files HQ wrote, and the agent exists.
  const result = form.getByTestId("write-result");
  await expect(result).toContainText("SOP.md");
  await expect(result).toContainText("LOGS.md");
  expect((await page.request.get("/api/agents/One/one_e2e_suggest_writer")).status()).toBe(200);
  // The test print names the planner pin the suggestions carried.
  await expect(form.getByTestId("test-print")).toContainText("Claude Code Opus 5.5 (medium)");
});

test("J2 · Edit agent is a page pre-filled from its SOP, and a limit toggle works from the keyboard", async ({ page }) => {
  await page.goto("/agents/One/one_fixture_editable/edit");
  const form = page.getByTestId("agent-form");
  await expect(form.getByRole("heading", { level: 1 })).toContainText("Edit one_fixture_editable");
  await expect(form.getByLabel("Name")).toBeDisabled();
  const exa = form.getByRole("checkbox", { name: /Main Exa/ });
  await expect(exa).toBeChecked();
  await expect(form.getByRole("checkbox", { name: /Main Support/ })).toBeVisible();
  await expect(form).toContainText("not connected now");
  await expect(form.getByLabel("Anything else it must never do")).toHaveValue(/^Send, publish, delete or charge anything/);

  // An older SOP's toggles start unset. Tab reaches the toggle, which shows the safelight ring; Space flips it.
  const toggle = form.getByTestId("limit-toggle").first();
  await expect(toggle).toHaveAttribute("data-verdict", "unset");
  await exa.focus();
  await page.keyboard.press("Tab");
  await expect(toggle).toBeFocused();
  expect(await toggle.evaluate((el) => getComputedStyle(el).outlineColor)).toBe("rgb(255, 176, 0)");
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("data-verdict", "may");
  await expect(form.getByTestId("sop-preview")).toContainText('- exa · "Main Exa": use (paid)');
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("data-verdict", "never");
});

test("no page scrolls sideways in a 390 px window", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { chat } = await (await page.request.post("/api/chats", { headers: { "x-jos-hq": "1" }, data: { title: "A narrow window check with a long title that keeps going" } })).json();
  const pages: Array<[string, (p: Page) => ReturnType<Page["getByTestId"]>]> = [
    ["/", (p) => p.getByTestId("bay-One")],
    ["/agents?ws=One", (p) => p.getByTestId("agents-table")],
    ["/connections", (p) => p.getByTestId("connections-table").or(p.getByText("No connections detected."))],
    ["/workflows", (p) => p.getByText("No workflows yet.")],
    ["/agents/new?workspace=One", (p) => p.getByTestId("sop-preview").getByText("Set by J/OS")],
    ["/agents/One/one_fixture_editable/edit", (p) => p.getByTestId("sop-preview").getByText("Set by J/OS")],
    [`/chat/${chat.id}`, (p) => p.getByTestId("chat-empty")],
  ];
  for (const [url, ready] of pages) {
    await page.goto(url);
    await expect(ready(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), url).toBeLessThanOrEqual(0);
  }
});

test("dialogs close with Escape and leave everything as it was", async ({ page }) => {
  await page.request.post("/api/chats", { headers: { "x-jos-hq": "1" }, data: { title: "Escape check chat" } });
  await page.goto("/");
  const chats = page.getByRole("list", { name: "Chats" });
  await chats.getByRole("button", { name: "Delete chat Escape check chat" }).click();
  await expect(page.getByTestId("delete-chat-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("delete-chat-dialog")).toHaveCount(0);
  await expect(chats).toContainText("Escape check chat");

  await openAgentSettings(page, "one_fixture_editable");
  await page.getByTestId("agent-delete").click();
  await expect(page.getByTestId("delete-agent-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("delete-agent-dialog")).toHaveCount(0);
  await expect(page.getByTestId("agent-row-one_fixture_editable")).toBeVisible();
});
