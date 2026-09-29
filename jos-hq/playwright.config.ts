import { defineConfig } from "@playwright/test";
import { E2E_ACCESS_KEY } from "./tests/e2e/fixtures/access-key.mjs";

// UI acceptance tests run against an isolated HQ instance (scripts/e2e-server.mjs) on port 4613 that
// uses a throwaway copy of the J/OS structure. Requires `npm run build` first. Uses installed Chrome.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4613",
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    // HQ's pages and API need the access key; the server's is E2E_ACCESS_KEY (scripts/e2e-server.mjs).
    storageState: {
      cookies: [{ name: "joshq", value: E2E_ACCESS_KEY, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Strict" }],
      origins: [],
    },
  },
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: "http://127.0.0.1:4613/api/chats",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { JOS_HQ_PORT: "4613" },
  },
});
