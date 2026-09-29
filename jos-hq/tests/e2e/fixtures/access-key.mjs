// The UI tests' HQ access key. scripts/e2e-server.mjs writes it to a throwaway key file (never the real
// %LOCALAPPDATA%\JOS\hq\access.key) and playwright.config.ts gives every browser context its joshq cookie.
export const E2E_ACCESS_KEY = "e2e0".repeat(16);
