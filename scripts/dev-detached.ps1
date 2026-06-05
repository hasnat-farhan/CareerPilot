param([string]$Port = "3000")
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Kill anything holding the port.
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Get-Process -Name node,next-server,next -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# Wipe stale log.
$log = Join-Path $root ".next-dev.log"
if (Test-Path $log) { Remove-Item $log -Force }

# Spawn detached: a cmd wrapper that redirects to a file, then we
# disconnect via WMI so the child outlives this PowerShell process.
$cmd = Join-Path $root "scripts\dev-inner.cmd"
@"
@echo off
cd /d `"$root`"
call npm run dev 1> `"$log`" 2>&1
"@ | Set-Content -Path $cmd -Encoding ASCII

$proc = Start-Process -FilePath $cmd -PassThru -WindowStyle Hidden
# Detach: take ownership away from this parent.
$proc.WaitForExit(50) | Out-Null
Write-Host "DEV_PID=$($proc.Id)"
Write-Host "LOG=$log"
