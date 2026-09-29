# Opens J/OS HQ in an app window, starting it first when nothing listens on the port. The desktop
# shortcut (install-shortcut.ps1) runs this. The key travels once, to /enter, which turns it into the
# joshq cookie; HQ refuses pages and API calls without it (lib/server/access.ts).
#
# HQ has no unauthenticated health route (every /api/* route needs the access key), so a listening
# port alone is not proof this is HQ: any process could bind it and would then receive the access
# key in the /enter URL this script opens next. Before ever reading or sending that key, this script
# also confirms *by process* that whatever is actually listening on 127.0.0.1:$Port is HQ's own
# `next start`: node.exe, owned by the account running this script, launched from this jos-hq folder.
# If that doesn't hold, it stops rather than send the key anywhere.
#   powershell -File jos-hq\scripts\open.ps1 [-Port 4610]
# -Import defines the functions below without running anything else, so tests can dot-source this
# file (". open.ps1 -Port <n> -Import") and call them directly, without starting a real server or
# risking a real MessageBox.
param([int]$Port = 4610, [switch]$Import)
$ErrorActionPreference = "Stop"
$appDir = Split-Path -Parent $PSScriptRoot
$base = "http://127.0.0.1:$Port"

function Fail([string]$message) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($message, "J/OS HQ", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
  } catch {
    try { msg $env:USERNAME $message } catch { }
  }
  throw $message
}

# A small quote-aware command-line splitter: Win32_Process.CommandLine is a single string, not an
# argv array. A double-quoted run is one token even if it contains spaces (e.g. a Program Files
# path); anything else splits on whitespace. Good enough for the plain, generator-produced command
# lines this checks (node, npm's cmd shims, next's own bin) — not a general Windows argv parser.
function Split-CommandLine([string]$cmd) {
  $tokens = New-Object System.Collections.Generic.List[string]
  $i = 0
  $n = $cmd.Length
  while ($i -lt $n) {
    while ($i -lt $n -and [char]::IsWhiteSpace($cmd[$i])) { $i++ }
    if ($i -ge $n) { break }
    $sb = New-Object System.Text.StringBuilder
    $inQuotes = $false
    while ($i -lt $n -and ($inQuotes -or -not [char]::IsWhiteSpace($cmd[$i]))) {
      if ($cmd[$i] -eq '"') { $inQuotes = -not $inQuotes; $i++; continue }
      [void]$sb.Append($cmd[$i])
      $i++
    }
    $tokens.Add($sb.ToString())
  }
  return $tokens
}

# The check a foreign process can't spoof by answering HTTP correctly (HQ has no unauthenticated
# health JSON to even check): is whatever the OS says is actually bound to 127.0.0.1:$Port really
# HQ's own `next start`, run by this account, from this folder. Returns @{ ok; reason } rather than
# throwing, so callers (and tests) can inspect it.
#
# A same-user `node evil.js <appDir> next start` must not pass just because the command line
# contains this folder and the words "next"/"start" somewhere — that's why this parses argv rather
# than substring-matching the raw string. restart.ps1's `next.cmd start --port <Port> --hostname
# 127.0.0.1` ends up, once next.cmd hands off to node, with a command line shaped like `"<node.exe>"
# "<appDir>\node_modules\.bin\..\next\dist\bin\next" start --port <Port> --hostname 127.0.0.1` (the
# `.bin\..\` comes from next.cmd's own `%dp0%\..\next\...`, and GetFullPath below collapses it) —
# that exact shape, not merely a mention of it, is required.
function Test-ListenerOwnership([int]$Port, [string]$AppDir) {
  $conn = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) {
    return @{ ok = $false; reason = "nothing is listening on 127.0.0.1:$Port" }
  }
  $connPid = $conn.OwningProcess
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$connPid" -ErrorAction SilentlyContinue
  if (-not $proc) {
    return @{ ok = $false; reason = "port $Port is used by another program: pid $connPid (no process information)" }
  }
  if ($proc.Name -ne "node.exe") {
    return @{ ok = $false; reason = "port $Port is used by another program: $($proc.Name) ($connPid)" }
  }
  $owner = $null
  try { $owner = (Invoke-CimMethod -InputObject $proc -MethodName GetOwner -ErrorAction Stop).User } catch { }
  if (-not $owner -or $owner -ne $env:USERNAME) {
    return @{ ok = $false; reason = "port $Port's node.exe (pid $connPid) is not owned by $env:USERNAME" }
  }

  $tokens = Split-CommandLine ([string]$proc.CommandLine)
  # tokens[0] is node.exe itself (a bare "node" or its full path); find the first argument after it
  # that isn't an option (doesn't start with "-").
  $scriptArg = $null
  $afterScript = @()
  for ($idx = 1; $idx -lt $tokens.Count; $idx++) {
    if ($tokens[$idx].StartsWith("-")) { continue }
    $scriptArg = $tokens[$idx]
    $afterScript = if ($idx + 1 -lt $tokens.Count) { $tokens[($idx + 1)..($tokens.Count - 1)] } else { @() }
    break
  }
  $expectedScript = Join-Path $AppDir "node_modules\next\dist\bin\next"
  $resolvedScript = $null
  if ($scriptArg) { try { $resolvedScript = [System.IO.Path]::GetFullPath($scriptArg) } catch { $resolvedScript = $scriptArg } }
  $scriptMatches = $resolvedScript -and ($resolvedScript.TrimEnd('\') -ieq $expectedScript.TrimEnd('\'))
  $startMatches = $afterScript.Count -gt 0 -and $afterScript[0] -eq "start"
  $hasPort = $false
  $hasHostname = $false
  for ($j = 0; $j -lt $afterScript.Count - 1; $j++) {
    if ($afterScript[$j] -eq "--port" -and $afterScript[$j + 1] -eq [string]$Port) { $hasPort = $true }
    if ($afterScript[$j] -eq "--hostname" -and $afterScript[$j + 1] -eq "127.0.0.1") { $hasHostname = $true }
  }
  if (-not ($scriptMatches -and $startMatches -and $hasPort -and $hasHostname)) {
    return @{ ok = $false; reason = "port $Port's node.exe (pid $connPid) does not look like J/OS HQ's server" }
  }
  return @{ ok = $true; reason = ""; name = $proc.Name; pid = $connPid }
}

function Assert-OwnListener {
  $listener = Test-ListenerOwnership -Port $Port -AppDir $appDir
  if (-not $listener.ok) { Fail($listener.reason) }
}

if ($Import) { return }

if (-not (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
  & (Join-Path $PSScriptRoot "restart.ps1") -Port $Port
}

# Whether HQ was already listening or restart.ps1 just started it, confirm by process before ever
# reading or sending the key — this is what stops a foreign listener from ever receiving it.
Assert-OwnListener

# The same resolution as accessKeyFile() in lib/server/access.ts: JOS_HQ_ACCESS_KEY_FILE overrides;
# otherwise LOCALAPPDATA, and if that's unset too, USERPROFILE\AppData\Local (access.ts falls back
# to os.homedir(), which resolves from USERPROFILE on Windows).
$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
$keyFile = if ($env:JOS_HQ_ACCESS_KEY_FILE) { $env:JOS_HQ_ACCESS_KEY_FILE } else { Join-Path $localAppData "JOS\hq\access.key" }
if (-not (Test-Path $keyFile)) {
  # HQ writes the key when it first serves a request; a keyless /enter is refused but creates it.
  try { Invoke-WebRequest -UseBasicParsing -Uri "$base/enter" -TimeoutSec 5 | Out-Null } catch { }
}
$key = if (Test-Path $keyFile) { (Get-Content -Raw $keyFile).Trim() } else { "" }
if (-not $key) { Fail("No HQ access key at $keyFile") }
$url = "$base/enter?k=$key"

$browsers = @(
  (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
  (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
  (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
  (Join-Path $localAppData "Google\Chrome\Application\chrome.exe")
)
$browser = $browsers | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($browser) {
  Start-Process -FilePath $browser -ArgumentList "--app=$url"
} else {
  Start-Process $url
}
