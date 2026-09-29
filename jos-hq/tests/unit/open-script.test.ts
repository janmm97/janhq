// scripts/open.ps1's access-key leak fix (the GitHub Agent Task 16 fix round, applied here too):
// HQ has no unauthenticated health route, so a listening port alone is not proof it's HQ — any
// process could bind 127.0.0.1:$Port and would then receive the access key in the /enter URL this
// script opens. Test-ListenerOwnership confirms *by process* (node.exe, owned by this account,
// launched from this jos-hq folder as `next start`) before the script ever reads or sends the key.
//
// This never starts the real server on 4610 or opens a browser: open.ps1 is dot-sourced with
// -Import (defines the functions without running anything else), against a free port a fake
// listener process binds.
import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const SCRIPTS_DIR = path.resolve(import.meta.dirname, "../../scripts");
const OPEN_PS1 = path.join(SCRIPTS_DIR, "open.ps1");

function readScript(): string {
  return fs.readFileSync(OPEN_PS1, "utf8");
}

function ps(args: string[]) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], { encoding: "utf8", timeout: 20_000 });
}

describe("jos-hq scripts/open.ps1: no hard-coded user path", () => {
  it("never hard-codes C:\\Users\\...", () => {
    expect(readScript()).not.toMatch(/C:\\Users\\/i);
  });
});

describe("jos-hq scripts/open.ps1: listener-ownership check (static)", () => {
  const t = () => readScript();

  it("verifies the listener by process before trusting it", () => {
    expect(t()).toMatch(/Get-NetTCPConnection/);
    expect(t()).toMatch(/Win32_Process/);
    expect(t()).toMatch(/GetOwner/);
    expect(t()).toMatch(/node\.exe/);
  });

  it("checks ownership before reading or sending the access key (Assert-OwnListener runs before $keyFile)", () => {
    const text = t();
    const assertIdx = text.indexOf("Assert-OwnListener");
    const keyFileIdx = text.indexOf("$keyFile");
    expect(assertIdx).toBeGreaterThan(-1);
    expect(keyFileIdx).toBeGreaterThan(-1);
    // The call site (not the function definition, which comes first) is what must precede $keyFile.
    const callSiteIdx = text.indexOf("Assert-OwnListener", assertIdx + "Assert-OwnListener".length);
    expect(callSiteIdx).toBeGreaterThan(-1);
    expect(callSiteIdx).toBeLessThan(keyFileIdx);
  });

  it("never silently swallows a failed ownership check (shows a message box, then stops)", () => {
    expect(t()).toMatch(/MessageBox|msg\.exe|msg /i);
  });

  it("routes a missing/empty access key through Fail() too, not a bare throw (fix round 2, item 1)", () => {
    const text = t();
    const idx = text.indexOf("if (-not $key)");
    expect(idx).toBeGreaterThan(-1);
    const line = text.slice(idx, text.indexOf("\n", idx));
    expect(line).toMatch(/Fail\(/);
    expect(line).not.toMatch(/^\s*throw/);
  });

  it("resolves the key file with the same LOCALAPPDATA -> USERPROFILE\\AppData\\Local fallback as access.ts (fix round 2, item 2)", () => {
    const text = t();
    expect(text).toMatch(/USERPROFILE/);
    expect(text).toMatch(/localAppData/i);
  });

  it("parses the command line into argv rather than substring-matching the raw string (fix round 2, item 3)", () => {
    const text = t();
    expect(text).toMatch(/function Split-CommandLine/);
    expect(text).toMatch(/GetFullPath/);
    expect(text).toMatch(/node_modules\\next\\dist\\bin\\next/);
    expect(text).toMatch(/--port/);
    expect(text).toMatch(/--hostname/);
  });

  it("is syntactically valid PowerShell", () => {
    const r = ps(["-Command", `$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw '${OPEN_PS1.replace(/'/g, "''")}'), [ref]$null)`]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** A fake server, in its own node.exe process, whose command line has nothing to do with HQ: no
 * jos-hq path, no "next", no "start". Real node.exe, right owner (same account) — wrong command
 * line is what must trip the check. */
function startFakeListener(port: number): ChildProcess {
  const script = `require('http').createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end('{"ok":true}')}).listen(${port},'127.0.0.1');setInterval(()=>{},60000);`;
  return spawn(process.execPath, ["-e", script], { stdio: "ignore" });
}

async function waitForListening(port: number, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const up = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port }, () => {
        sock.end();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    });
    if (up) return;
    if (Date.now() > end) throw new Error(`nothing ever listened on 127.0.0.1:${port}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** appDir defaults to the script's own $appDir (jos-hq's real folder) when omitted. */
function checkOwnership(port: number, appDir?: string): { ok: boolean; reason: string } {
  const openPs1 = OPEN_PS1.replace(/'/g, "''");
  const appDirExpr = appDir === undefined ? "$appDir" : `'${appDir.replace(/'/g, "''")}'`;
  const script = [`. '${openPs1}' -Port ${port} -Import`, `$l = Test-ListenerOwnership -Port ${port} -AppDir ${appDirExpr}`, `$l | ConvertTo-Json -Compress`].join("; ");
  const r = ps(["-Command", script]);
  if (r.status !== 0) throw new Error(`the ownership check itself failed to run: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  return { ok: !!parsed.ok, reason: String(parsed.reason ?? "") };
}

describe("jos-hq scripts/open.ps1: Test-ListenerOwnership (dynamic)", () => {
  let child: ChildProcess | null = null;
  afterEach(() => {
    child?.kill();
    child = null;
  });

  it("refuses a fake listener even though it's real node.exe owned by the same account (wrong command line)", async () => {
    const port = await getFreePort();
    child = startFakeListener(port);
    await waitForListening(port);
    const result = checkOwnership(port);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not look like J\/OS HQ's server|not owned by|used by another program/);
  });

  it("reports 'nothing is listening' when the port is free", async () => {
    const port = await getFreePort();
    const result = checkOwnership(port);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/nothing is listening/);
  });
});

// ---------------------------------------------------------------------------------------------
// Fix round 2, item 3: argv is parsed, not substring-matched. A same-user process whose raw
// command line happens to mention the app folder and the words "next"/"start" must still be
// refused unless it is actually node running <appDir>\node_modules\next\dist\bin\next start
// --port <Port> --hostname 127.0.0.1.

const listenerScript = (port: number) => `require('http').createServer((_q,r)=>{r.end('ok')}).listen(${port},'127.0.0.1');setInterval(()=>{},60000);`;

describe("jos-hq scripts/open.ps1: Test-ListenerOwnership parses argv, not the raw string", () => {
  let child: ChildProcess | null = null;
  afterEach(() => {
    child?.kill();
    child = null;
  });

  it("refuses the probe case: node evil.js <appDir> next start", async () => {
    const port = await getFreePort();
    const realAppDir = path.resolve(SCRIPTS_DIR, "..");
    const evilDir = fs.mkdtempSync(path.join(os.tmpdir(), "joshq-evil-"));
    const evilScript = path.join(evilDir, "evil.js");
    fs.writeFileSync(evilScript, listenerScript(port));
    child = spawn(process.execPath, [evilScript, realAppDir, "next", "start"], { stdio: "ignore" });
    await waitForListening(port);
    const result = checkOwnership(port, realAppDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not look like J\/OS HQ's server/);
  });

  it("accepts the real shape: node <appDir>\\node_modules\\next\\dist\\bin\\next start --port <p> --hostname 127.0.0.1", async () => {
    const port = await getFreePort();
    const tempAppDir = fs.mkdtempSync(path.join(os.tmpdir(), "joshq-nextprobe-"));
    const binDir = path.join(tempAppDir, "node_modules", "next", "dist", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, "next"); // no extension, exactly like the real next bin
    fs.writeFileSync(binPath, listenerScript(port));
    child = spawn(process.execPath, [binPath, "start", "--port", String(port), "--hostname", "127.0.0.1"], { stdio: "ignore" });
    await waitForListening(port);
    const result = checkOwnership(port, tempAppDir);
    expect(result.ok).toBe(true);
  });
});
