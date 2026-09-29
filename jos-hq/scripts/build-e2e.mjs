#!/usr/bin/env node
// Builds HQ for the UI tests into .next-e2e, so a test build never replaces the production build that
// live HQ serves from .next, and points the access key at a throwaway file in case anything is prerendered
// (nothing gated should be: the gated layouts are dynamic). The e2e server (scripts/e2e-server.mjs) serves the same folder.
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = path.join(app, "node_modules", "next", "dist", "bin", "next");
const r = spawnSync(process.execPath, [nextBin, "build"], { cwd: app, stdio: "inherit", env: { ...process.env, JOS_HQ_DIST_DIR: ".next-e2e", JOS_HQ_ACCESS_KEY_FILE: path.join(os.tmpdir(), "jos-hq-e2e-build-access.key") } });
process.exit(r.status ?? 1);
