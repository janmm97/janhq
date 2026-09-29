# Stop J/OS HQ: whatever listens on the HQ port, with its whole process tree. Executors still running
# are stopped with it; HQ marks their tasks Interrupted (never Complete) the next time it starts.
#   powershell -File jos-hq\scripts\stop.ps1 [-Port 4610]
param([int]$Port = 4610)
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) {
  Write-Output "nothing is listening on port $Port"
  exit 0
}
taskkill /PID $listener.OwningProcess /T /F | Out-Null
Write-Output "stopped jos-hq (pid $($listener.OwningProcess)) on port $Port"
