#requires -Version 5.1
<#
.SYNOPSIS
  9Router installer/updater for Windows. Installs the CLI into a per-user
  directory (~\.9router\cli) so upgrades never collide with a locked nvm/npm
  global dir (the classic "npm error EBUSY: resource busy or locked, rename"
  failure), and manages stop/start of the running service around the install.

.DESCRIPTION
  Handles both acs-managed and non-acs installs:
  - acs-managed  : disables the ACS Watchdog scheduled task during the upgrade
                   window (it health-checks every 5 min and would resurrect a
                   stopped 9router mid-install, relocking the files), uses
                   `acs service stop/start 9router --force`, then restores it.
  - non-acs      : falls back to process scan + port kill, which also covers
                   installs started manually outside of any service manager.

.EXAMPLE
  .\install.ps1                          # latest fork release, then start
  .\install.ps1 -Version 0.5.105         # pin a fork-patch version
  .\install.ps1 -NoStart                 # upgrade only, do not start
  .\install.ps1 -Port 20128              # override server port
#>
param(
  [string]$Version = "latest",
  [int]$Port = 20128,
  [switch]$NoStart,
  [string]$Url = ""
)

$InstallDir = Join-Path $env:USERPROFILE ".9router\cli"
$ServerUrl = "http://127.0.0.1:$Port"
$RepoOwner = "andyvandaric"
$RepoName = "9router"
$WatchdogTaskPattern = "ACS Watchdog"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Okay($msg) { Write-Host "    OK $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    !! $msg" -ForegroundColor Yellow }

# Native npm emits progress on stderr; with ErrorActionPreference=Stop PS 5.1
# turns that into a terminating NativeCommandError.npm calls must run tolerant
# and be judged by exit code only.
function Invoke-Tolerant([scriptblock]$sb) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $sb } catch { }
  $ErrorActionPreference = $previous
  return ($LASTEXITCODE -eq 0)
}

# Restore-on-failure ------------------------------------------------------
# The upgrade window stops the service and pauses the ACS Watchdog. A
# terminating error in between (a failed npm install is the real-world case)
# used to leave both that way, i.e. the whole stack down with the watchdog
# still disabled. Every failure path now funnels through the trap below.
$script:didStop = $false

function Restore-PreviousState {
  $wd = Get-ScheduledTask -TaskName $WatchdogTaskPattern -ErrorAction SilentlyContinue
  if ($wd -and $wd.State -eq "Disabled") {
    Enable-ScheduledTask -TaskName $WatchdogTaskPattern -ErrorAction SilentlyContinue | Out-Null
    Write-Okay "Watchdog re-enabled"
  }
  if (-not $script:didStop) { return }
  try {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) { Write-Okay "Server still listening on port $Port"; return }
  } catch { }
  Write-Warn2 "Install window left the service stopped - restoring it"
  if ($acs) { Invoke-Tolerant { & acs service start 9router --force 2>&1 | Out-Null } | Out-Null }
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      if ((Invoke-WebRequest -Uri "$ServerUrl/api/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) {
        Write-Okay "Server is healthy at $ServerUrl"
        return
      }
    } catch { }
  }
  # Last resort: the previously installed CLI is still on disk even when the new
  # package is half-written, so bring that one up windowlessly.
  $prevCli = Join-Path $InstallDir "node_modules\9router\cli.js"
  if (Test-Path $prevCli) {
    Write-Warn2 "acs start did not converge - spawning the previous CLI directly"
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = (Get-Command node).Source
    $psi.Arguments = "`"$prevCli`" --tray --skip-update -p $Port"
    $psi.CreateNoWindow = $true
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    [System.Diagnostics.Process]::Start($psi) | Out-Null
  } else {
    Write-Warn2 "No previous CLI at $prevCli - stack left stopped, start it manually"
  }
}

trap {
  Write-Warn2 "Install failed: $($_.Exception.Message)"
  Restore-PreviousState
  Write-Host ""
  Write-Host "Install FAILED (previous state restored)." -ForegroundColor Red
  exit 1
}

# 1. Preflight ------------------------------------------------------------
Write-Step "Preflight checks"
foreach ($cmd in @("node", "npm")) {
  $nodeCmd = Get-Command $cmd -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { throw "$cmd not found on PATH. Install Node.js (>=18) first." }
}
Write-Okay "node $( (node --version) ) found"
$acs = Get-Command acs -ErrorAction SilentlyContinue

# 2. Resolve download URL -------------------------------------------------
if ($Url) {
  $downloadUrl = $Url
} elseif ($Version -eq "latest") {
  $downloadUrl = "https://github.com/$RepoOwner/$RepoName/releases/latest/download/9router-latest.tgz"
} else {
  $Version = $Version.TrimStart("v")
  $downloadUrl = "https://github.com/$RepoOwner/$RepoName/releases/download/v$Version-andyvandaric-patch/9router-$Version.tgz"
}

# 3. Download FIRST (before stopping) to minimize service downtime --------
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "9router-install") -Force
$tgz = Join-Path $tmp.FullName "9router.tgz"
Write-Step "Downloading $downloadUrl"
Invoke-WebRequest -Uri $downloadUrl -OutFile $tgz -UseBasicParsing
if (-not (Test-Path $tgz) -or (Get-Item $tgz).Length -lt 1MB) { throw "Downloaded tarball looks invalid" }
Write-Okay "Saved $([Math]::Round((Get-Item $tgz).Length / 1MB, 1)) MB"

# 4. Stop the service (acs-aware, with resurrection protection) ----------
# The install window is now very short (tarball already local), but the
# watchdog task must not relaunch 9router while npm rewrites files.
$watchdogDisabled = $false
$watchdogTask = Get-ScheduledTask -TaskName $WatchdogTaskPattern -ErrorAction SilentlyContinue
if ($watchdogTask -and $watchdogTask.State -ne "Disabled") {
  Write-Step "Pausing '$WatchdogTaskPattern' during the upgrade"
  Disable-ScheduledTask -TaskName $WatchdogTaskPattern | Out-Null
  $watchdogDisabled = $true
  Write-Okay "Watchdog paused (re-enabled after the install)"
}

function Stop-All9Router {
  $clean = $true
  $instances = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "node" -and $_.CommandLine -match "9router" }
  foreach ($p in $instances) {
    Write-Warn2 "Stopping PID $($p.ProcessId): $($p.CommandLine.Substring(0, [Math]::Min(100, $p.CommandLine.Length)))"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    $clean = $false
  }
  try {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener -and $listener.OwningProcess -and $listener.OwningProcess -ne 0) {
      Write-Warn2 "Freeing port $Port (PID $($listener.OwningProcess))"
      Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
      $clean = $false
    }
  } catch { }
  return $clean
}

Write-Step "Stopping running 9Router processes (if any)"
if ($acs) {
  if (Invoke-Tolerant { & acs service stop 9router --force 2>&1 | Out-Null }) { Write-Okay "stopped via acs (--force)" }
  elseif (Invoke-Tolerant { & acs service stop 9router 2>&1 | Out-Null }) { Write-Okay "stopped via acs" }
  else { Write-Warn2 "acs stop failed; falling back to process scan" }
}
$stopped = $false
for ($round = 1; $round -le 5; $round++) {
  if (Stop-All9Router) { $stopped = $true; break }
  Start-Sleep -Seconds 1
}
if ($stopped) { Write-Okay "Nothing is running and port $Port is free" }
else { Write-Warn2 "Processes kept reappearing -- continuing anyway (install is user-dir, unaffected)" }
$script:didStop = $true

# 5. Purge the stale global install (prevents PATH shadowing) -------------
# Best-effort only: a locked nvm global dir must never block the user-dir
# install below. Leftover npm staging dirs get the same treatment.
Write-Step "Removing stale global npm install (if any)"
if (Invoke-Tolerant { & npm ls -g 9router 2>&1 | Out-Null }) {
  $purged = Invoke-Tolerant { & npm uninstall -g 9router 2>&1 | Out-Null }
  if ($purged) { Write-Okay "Global 9router removed" }
  else {
    Write-Warn2 "Global removal blocked (EBUSY) -- retrying once after a stop sweep"
    Stop-All9Router | Out-Null
    $purged = Invoke-Tolerant { & npm uninstall -g 9router 2>&1 | Out-Null }
    if ($purged) { Write-Okay "Global 9router removed on retry" }
    else { Write-Warn2 "Global copy remains; user-dir install proceeds and wins PATH (newest entry)" }
  }
} else { Write-Okay "No global install to purge" }
Get-ChildItem (Join-Path $env:USERPROFILE "AppData\Local\nvm") -Recurse -Directory -Filter ".9router-*" -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

# Stale shims from a partially-uninstalled global can sit in the npm prefix
# root (e.g. the nvm4w nodejs dir) and, living earlier in PATH order, shadow
# the user-dir shim in every new terminal.
Write-Step "Cleaning stale global bin shims (if any)"
$npmPrefix = (& npm config get prefix | Select-Object -First 1)
if ($npmPrefix) { $npmPrefix = $npmPrefix.Trim() }
if ($npmPrefix -and ($npmPrefix -ne $InstallDir)) {
  Get-ChildItem -LiteralPath $npmPrefix -Filter "9router*" -ErrorAction SilentlyContinue |
    ForEach-Object {
      Write-Warn2 "Removing stale shim $($_.FullName)"
      Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    }
}
Write-Okay "Shim cleanup done"

# 6. Install into the user dir -------------------------------------------
#    npm --global --prefix <dir> puts the package in <dir>\node_modules\9router
#    and bin shims in <dir>\9router.cmd - a per-user tree we always own, so
#    no file in it can be locked by an nvm-managed global dir again.
Write-Step "Installing into $InstallDir"
$npmLog = Join-Path $tmp.FullName "npm-install.log"
$installedOk = Invoke-Tolerant { & npm install --global --prefix $InstallDir $tgz *> $npmLog }
if (-not $installedOk) {
  # npm can die with an empty log and exit 1 when a supervisor window races the
  # install (observed on Windows), so retry once before giving up.
  Write-Warn2 "npm install failed - last log lines:"
  Get-Content $npmLog -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Warn2 $_ }
  Write-Warn2 "Retrying install once"
  Start-Sleep -Seconds 2
  $installedOk = Invoke-Tolerant { & npm install --global --prefix $InstallDir $tgz *> $npmLog }
}
if (-not $installedOk) {
  Write-Warn2 "npm install failed after retry (full log: $npmLog)"
  throw "npm install failed (full log: $npmLog)"
}
$shim = Join-Path $InstallDir "9router.cmd"
if (-not (Test-Path $shim)) { throw "Install finished but $shim was not created" }
Write-Okay "Installed"

# 7. PATH management (user scope, current session) ------------------------
Write-Step "Ensuring $InstallDir is on your PATH"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $InstallDir) {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
  Write-Okay "Added to user PATH (new terminals will pick it up)"
} else { Write-Okay "Already on user PATH" }
$env:Path = "$InstallDir;$env:Path"

# 8. Verify ---------------------------------------------------------------
$pkgPath = Join-Path $InstallDir "node_modules\9router\package.json"
if (-not (Test-Path $pkgPath)) { throw "Installed package.json missing" }
$installed = (Get-Content $pkgPath -Raw | ConvertFrom-Json).version
Write-Okay "9Router v$installed installed"
if ($Version -ne "latest" -and $installed -ne $Version.TrimStart("v")) {
  throw "Installed version $installed does not match requested $Version"
}

# 9. Start the service + health check ------------------------------------
function Wait-Healthy {
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-WebRequest -Uri "$ServerUrl/api/health" -UseBasicParsing -TimeoutSec 2
      if ($health.StatusCode -eq 200) { return $true }
    } catch { }
  }
  return $false
}

if (-not $NoStart) {
  Write-Step "Starting 9Router on port $Port (watchdog restored)"
  $cli = Join-Path $InstallDir "node_modules\9router\cli.js"
  $spawnedManually = $true
  if ($acs) {
    if (Invoke-Tolerant { & acs service start 9router --force 2>&1 | Out-Null }) { Write-Okay "started via acs (--force)"; $spawnedManually = $false }
    elseif (Invoke-Tolerant { & acs service start 9router 2>&1 | Out-Null }) { Write-Okay "started via acs"; $spawnedManually = $false }
  }
  if (Wait-Healthy) {
    $spawnedManually = $false
  } elseif ($spawnedManually) {
    Write-Warn2 "Service not healthy yet - spawning manually (fully silent, no terminal window)"
    # Fully windowless spawn: CreateNoWindow + UseShellExecute=false means no
    # console is allocated at all - Start-Process -WindowStyle Hidden would
    # still flash one briefly on some shells.
    $nodeExe = (Get-Command node).Source
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodeExe
    $psi.Arguments = "`"$cli`" --tray --skip-update -p $Port"
    $psi.CreateNoWindow = $true
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    [System.Diagnostics.Process]::Start($psi) | Out-Null
  }
  if (Wait-Healthy) {
    Write-Okay "Server is healthy at $ServerUrl"
    Write-Host ""
    Write-Host "  Dashboard: $ServerUrl/dashboard" -ForegroundColor White
    Write-Host "  Gateway:   $ServerUrl/v1" -ForegroundColor White
    Write-Host "  Data dir:  $env:USERPROFILE\.9router (untouched by this install)" -ForegroundColor Gray
  } else {
    Write-Warn2 "Server did not report healthy. Check: node \"$cli\" --tray --skip-update -p $Port"
  }
} else {
  Write-Step "-NoStart given; start later with: node \"$InstallDir\node_modules\9router\cli.js\" --tray --skip-update -p $Port"
}

# Leave the watchdog running no matter what, so a previous crashed upgrade
# attempt that disabled it (and made this run skip the pause step) is also
# covered by the restore.
$wdNow = Get-ScheduledTask -TaskName $WatchdogTaskPattern -ErrorAction SilentlyContinue
if ($wdNow -and $wdNow.State -eq "Disabled") {
  Enable-ScheduledTask -TaskName $WatchdogTaskPattern | Out-Null
  Write-Okay "Watchdog re-enabled"
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green