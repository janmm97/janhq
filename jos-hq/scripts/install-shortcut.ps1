# Puts "J-OS HQ" on the Desktop: a shortcut that runs open.ps1 from wherever this checkout lives. It
# overwrites an existing "J-OS HQ" shortcut, whatever that one pointed at. -Desktop overrides the target
# folder (tests, against a temp dir; never the real Desktop from a test).
#   powershell -File jos-hq\scripts\install-shortcut.ps1 [-Desktop <dir>]
param([string]$Desktop = "")
$ErrorActionPreference = "Stop"
$open = Join-Path $PSScriptRoot "open.ps1"
$desktopDir = if ($Desktop) { $Desktop } else { [Environment]::GetFolderPath("Desktop") }
New-Item -ItemType Directory -Force $desktopDir | Out-Null
$lnk = Join-Path $desktopDir "J-OS HQ.lnk"
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$shortcut.TargetPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$open`""
$shortcut.WorkingDirectory = Split-Path -Parent $PSScriptRoot
$shortcut.Description = "Open J/OS HQ"
$shortcut.Save()
Write-Output "shortcut: $lnk -> $open"
