# Stop whatever listens on the HQ port, optionally rebuild, and start `next start` in the background.
#   powershell -File jos-hq\scripts\restart.ps1 [-Build] [-Port 4610] [-Config <file>] [-DataDir <dir>]
# -Config / -DataDir run an isolated instance (used by acceptance tests); the default is the real HQ.
param([switch]$Build, [int]$Port = 4610, [string]$Config = "", [string]$DataDir = "")
$ErrorActionPreference = "Stop"
$app = Split-Path -Parent $PSScriptRoot
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  Write-Output "stopping pid $($listener.OwningProcess) on port $Port"
  taskkill /PID $listener.OwningProcess /T /F | Out-Null
  Start-Sleep -Milliseconds 800
}
Set-Location $app
if ($Build) {
  Write-Output "building..."
  # Through cmd so Turbopack's stderr warnings are text, not PowerShell 5.1 error records.
  $out = cmd.exe /c "npm.cmd run build 2>&1"
  $code = $LASTEXITCODE
  $out | Select-String -Pattern "Compiled|error TS|Failed to compile|Build error" | ForEach-Object { $_.Line }
  if ($code -ne 0) { $out | Select-Object -Last 30; throw "build failed" }
}
New-Item -ItemType Directory -Force (Join-Path $app "data") | Out-Null
$log = Join-Path $app "data\server-$Port.log"
$envs = "set JOS_HQ_PORT=$Port&&"
if ($Config) { $envs += " set JOS_HQ_CONFIG=$Config&&" }
if ($DataDir) { $envs += " set JOS_HQ_DATA_DIR=$DataDir&&" }
$cmd = "$envs node_modules\.bin\next.cmd start --port $Port --hostname 127.0.0.1 > `"$log`" 2>&1"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmd -WorkingDirectory $app -WindowStyle Hidden
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/chats" -TimeoutSec 3
    if ($r.StatusCode -eq 200) { Write-Output "jos-hq ready at http://127.0.0.1:$Port (log $log)"; exit 0 }
  } catch { }
}
throw "jos-hq did not become ready; see $log"
