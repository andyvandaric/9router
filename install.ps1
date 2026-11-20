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
  [string]$Url = "",
  [string]$Root = ""
)

# `irm <url> | iex` cannot pass arguments, so every setting is also readable
# from an environment variable. Precedence: explicit parameter, then env var,
# then the param default. This keeps `powershell -File install.ps1 -Version X
# -Port N` working unchanged while making the piped form configurable.
function Get-EnvSetting([string]$name) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) { return $null }
  return $value
}

if (-not $PSBoundParameters.ContainsKey("Version")) {
  $envVersion = Get-EnvSetting "NINEROUTER_VERSION"
  if ($envVersion) { $Version = $envVersion }
}
if (-not $PSBoundParameters.ContainsKey("Port")) {
  $envPort = Get-EnvSetting "NINEROUTER_PORT"
  if ($envPort) { $Port = [int]$envPort }
}
if (-not $PSBoundParameters.ContainsKey("Url")) {
  $envUrl = Get-EnvSetting "NINEROUTER_URL"
  if ($envUrl) { $Url = $envUrl }
}
if (-not $NoStart) {
  $envNoStart = Get-EnvSetting "NINEROUTER_NO_START"
  if ($envNoStart -and $envNoStart -notin @("0", "false", "no")) { $NoStart = $true }
}
if (-not $PSBoundParameters.ContainsKey("Root")) {
  $envRoot = Get-EnvSetting "NINEROUTER_ROOT"
  if ($envRoot) { $Root = $envRoot }
}
if ($Root) { $Root = [IO.Path]::GetFullPath($Root) }

$script:isolated = [bool]$Root
$script:supervisorPaused = $false
$script:spawnedPids = @()
# Set only after an isolated run verifies the port was free; without it a failed
# early run must not sweep a port that belongs to the host.
$script:portOwnedByRun = $false

# Isolation switch: redirect every user-scoped path under -Root and skip all
# host-wide mutations. Lets the full script run on a live Windows box without
# touching global shims, the user PATH registry value, or the acs service.
if ($script:isolated) {
  $env:USERPROFILE = Join-Path $Root "home"
  $env:HOME = $env:USERPROFILE
  $env:TEMP = Join-Path $Root "temp"
  $env:TMP = $env:TEMP
  $env:npm_config_prefix = Join-Path $Root "npm-prefix"
  $env:npm_config_cache = Join-Path $Root "npm-cache"
  foreach ($dir in @($env:USERPROFILE, $env:TEMP, $env:npm_config_prefix, $env:npm_config_cache)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
}

$InstallDir = Join-Path $env:USERPROFILE ".9router\cli"
$ServerUrl = "http://127.0.0.1:$Port"
$RepoOwner = "andyvandaric"
$RepoName = "9router"
$WatchdogTaskPattern = "ACS Watchdog"
$AcsSupervisorTaskPattern = "ACS Daemon Supervisor"

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
# Note: `throw` propagates through `irm | iex` without killing the caller's
# shell, unlike `exit`, which terminates it (empirically proven).
$script:didStop = $false

function Stop-SpawnedServers {
  # Only PIDs this run started - never whatever happens to own the port, which
  # on a non-isolated run could be the live host server. The CLI (`--tray`) can
  # hand the listening socket to a child, so callers that know the port was free
  # before starting should also free it.
  foreach ($spawnedPid in $script:spawnedPids) {
    if ($spawnedPid) { Stop-Process -Id $spawnedPid -Force -ErrorAction SilentlyContinue }
  }
  $script:spawnedPids = @()
}

function Stop-IsolatedServer {
  Stop-SpawnedServers
  if (-not $script:portOwnedByRun) { return }
  # The port was free when this run checked it, so anything listening now came
  # from this run's process tree.
  try {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener -and $listener.OwningProcess -and $listener.OwningProcess -ne 0) {
      Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  } catch { Write-Warn2 "Could not free port $Port after the isolated run" }
  $script:portOwnedByRun = $false
}

function Restore-PreviousState {
  if ($script:isolated) {
    Stop-IsolatedServer
    Write-Okay "Isolated run: stopped the server this install started"
    return
  }
  $wd = Get-ScheduledTask -TaskName $WatchdogTaskPattern -ErrorAction SilentlyContinue
  if ($wd -and $wd.State -eq "Disabled") {
    Enable-ScheduledTask -TaskName $WatchdogTaskPattern -ErrorAction SilentlyContinue | Out-Null
    Write-Okay "Watchdog re-enabled"
  }
  if ($script:supervisorPaused) {
    Enable-ScheduledTask -TaskName $AcsSupervisorTaskPattern -ErrorAction SilentlyContinue | Out-Null
    $script:supervisorPaused = $false
    Write-Okay "ACS Daemon Supervisor re-enabled"
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
  try { Restore-PreviousState } catch { Write-Warn2 "State restore failed: $($_.Exception.Message)" }
  Write-Host ""
  Write-Host "Install FAILED (previous state restored)." -ForegroundColor Red
  # Never `exit` here: under `irm | iex` that closes the caller's shell.
  throw "9Router install failed: $($_.Exception.Message)"
}

# 1. Preflight ------------------------------------------------------------
Write-Step "Preflight checks"
foreach ($cmd in @("node", "npm")) {
  $nodeCmd = Get-Command $cmd -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { throw "$cmd not found on PATH. Install Node.js (>=18) first." }
}
Write-Okay "node $( (node --version) ) found"
$acs = Get-Command acs -ErrorAction SilentlyContinue
# Isolated runs must not touch the host service manager at all.
if ($script:isolated) { $acs = $null }

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
$downloadUri = [Uri]$downloadUrl
if ($downloadUri.Scheme -eq "file") {
  # Local tarball (offline install / pinned-ci testing): plain copy.
  Copy-Item -LiteralPath $downloadUri.LocalPath -Destination $tgz -Force
  if (-not (Test-Path $tgz)) { throw "Local tarball not found: $($downloadUri.LocalPath)" }
} else {
  Invoke-WebRequest -Uri $downloadUrl -OutFile $tgz -UseBasicParsing
}
if (-not (Test-Path $tgz) -or (Get-Item $tgz).Length -lt 1MB) { throw "Downloaded tarball looks invalid" }
Write-Okay "Saved $([Math]::Round((Get-Item $tgz).Length / 1MB, 1)) MB"

# 4. Stop the service (acs-aware, with resurrection protection) ----------
# The install window is now very short (tarball already local), but the
# watchdog task must not relaunch 9router while npm rewrites files.
$watchdogDisabled = $false
if ($script:isolated) {
  Write-Step "Isolated run (-Root): leaving the host service and watchdog untouched"
} else {
  $watchdogTask = Get-ScheduledTask -TaskName $WatchdogTaskPattern -ErrorAction SilentlyContinue
  if ($watchdogTask -and $watchdogTask.State -ne "Disabled") {
    Write-Step "Pausing '$WatchdogTaskPattern' during the upgrade"
    Disable-ScheduledTask -TaskName $WatchdogTaskPattern | Out-Null
    $watchdogDisabled = $true
    Write-Okay "Watchdog paused (re-enabled after the install)"
  }
}

function Stop-All9Router {
  if ($script:isolated) { return $true }
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

if (-not $script:isolated) {
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
}

# 4b. Pause the daemon supervisor that holds the prefix lock --------------
# The ACS Daemon Supervisor scheduled task owns the supervised prefix copy
# (C:\nvm4w\nodejs\node_modules\9router). While it runs, `npm install -g`
# fails EBUSY on rename; the stop sweep above only kills node children, not
# the task. Pause it for the upgrade window and restore it in the trap.
if ($acs -and -not $script:isolated) {
  $supervisorTask = Get-ScheduledTask -TaskName $AcsSupervisorTaskPattern -ErrorAction SilentlyContinue
  if ($supervisorTask) {
    Write-Step "Pausing '$AcsSupervisorTaskPattern' during the upgrade"
    # Disabling only prevents the NEXT run; the instance already running keeps
    # its file handles on the prefix, so stop it too before touching npm.
    Stop-ScheduledTask -TaskName $AcsSupervisorTaskPattern -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName $AcsSupervisorTaskPattern -ErrorAction SilentlyContinue | Out-Null
    $script:supervisorPaused = $true
    Start-Sleep -Seconds 2
    Write-Okay "Supervisor stopped and paused (re-enabled after the install)"
  }
}

# Expected package version, read from the tarball itself, so "did the prefix
# upgrade actually land" is checkable without trusting npm's exit code.
# A `-Version` pin and the tarball's own version are tracked separately: folding
# them into one variable let the tarball silently overwrite the pin, so the
# "Tarball carries vX" line echoed the pin back and proved nothing.
$requestedVersion = $null
if ($Version -ne "latest") { $requestedVersion = $Version.TrimStart("v") }
$tarballVersion = $null
try {
  # Two tar dialects can be on PATH here. GNU tar (Git for Windows) reads
  # "C:/..." as a remote host unless `--force-local` is passed. Windows' own
  # bsdtar rejects `--force-local` outright ("Option not supported"). So try
  # both forms in order and take whichever yields the entry.
  #
  # Read the entry to stdout (`-O`) rather than extracting it with `-x -C`:
  # GNU tar mangles a Windows path after `-C` into escape sequences and fails
  # with "Cannot open", which the stderr redirect then hid, so the version came
  # back null and a version pin was only ever caught by the late check.
  $tarEntry = $null
  foreach ($forceLocal in @($true, $false)) {
    $tarArgs = if ($forceLocal) { @('--force-local', '-tzf', $tgz) } else { @('-tzf', $tgz) }
    $listing = & tar @tarArgs 2>$null
    if ($LASTEXITCODE -ne 0) { continue }
    $tarEntry = $listing | Where-Object { $_ -match '^package/package\.json$' } | Select-Object -First 1
    if (-not $tarEntry) { continue }
    $readArgs = if ($forceLocal) { @('--force-local', '-xzOf', $tgz, $tarEntry) } else { @('-xzOf', $tgz, $tarEntry) }
    $metaJson = & tar @readArgs 2>$null | Out-String
    if ($metaJson) { $tarballVersion = ($metaJson | ConvertFrom-Json).version }
    break
  }
} catch { Write-Warn2 "Could not read the tarball version: $($_.Exception.Message)" }
if ($tarballVersion) {
  Write-Okay "Tarball carries v$tarballVersion"
} else {
  # Never let this fall through silently: without the tarball version the
  # post-install pin check is the only thing standing between a wrong pin and
  # a successful install of the wrong version.
  Write-Warn2 "Could not read the tarball version - the post-install pin check will compare against the requested version only"
}
# The tarball is authoritative for what will actually land; the pin only
# constrains it, and the post-install check below fails loudly on a mismatch.
$targetVersion = if ($tarballVersion) { $tarballVersion } else { $requestedVersion }

# 5. npm-prefix copy (acs-managed) OR stale-global purge (standalone) ------
# The acs daemon supervises <npm-prefix>\node_modules\9router and SELF-HEALS it
# when missing (an opaque `npm i -g 9router` that pulls the official upstream
# 0.5.104 from npmjs). Purging the global on an acs-managed box therefore
# downgrades the service right back. Upgrade that supervised copy to the fork
# instead; only standalone installs get the traditional purge.
Write-Step "Preparing the npm-prefix copy the daemon supervises"
$prefixVersion = $null
$prefixOk = $false
$npmPrefixLog = Join-Path $tmp.FullName "npm-prefix-install.log"
if ($script:isolated) {
  Write-Step "Isolated run (-Root): skipping the host npm-prefix upgrade"
} elseif ($acs) {
  $npmPrefix = (& npm config get prefix | Select-Object -First 1)
  if ($npmPrefix) { $npmPrefix = $npmPrefix.Trim() }
  $prefixOk = Invoke-Tolerant { & npm install -g $tgz *> $npmPrefixLog }
  if (-not $prefixOk) {
    Write-Warn2 "Prefix install blocked -- sweeping processes and retrying once"
    Stop-All9Router | Out-Null
    Start-Sleep -Seconds 2
    $prefixOk = Invoke-Tolerant { & npm install -g $tgz *> $npmPrefixLog }
  }
  if ($prefixOk) {
    $prefixPkg = Join-Path $npmPrefix "node_modules\9router\package.json"
    if (-not (Test-Path $prefixPkg)) { throw "Prefix install reported success but $prefixPkg is missing (log: $npmPrefixLog)" }
    $prefixVersion = (Get-Content $prefixPkg -Raw | ConvertFrom-Json).version
    if ($targetVersion -and $prefixVersion -ne $targetVersion) {
      throw "Prefix still at v$prefixVersion, expected v$targetVersion - the upgrade did not land (log: $npmPrefixLog)"
    }
    Write-Okay "npm-prefix now at v$prefixVersion (daemon-managed path)"
  } else {
    Get-Content $npmPrefixLog -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Write-Warn2 $_ }
    $hint = ""
    if (Test-Path $npmPrefixLog) {
      $logText = Get-Content $npmPrefixLog -Raw -ErrorAction SilentlyContinue
      if ($logText -match "EBUSY|EPERM|resource busy or locked") { $hint = " (EBUSY - something still holds a lock in $npmPrefix)" }
    }
    throw "Prefix upgrade failed$hint (log: $npmPrefixLog)"
  }
} else {
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
}
if (-not $script:isolated) {
  Get-ChildItem (Join-Path $env:USERPROFILE "AppData\Local\nvm") -Recurse -Directory -Filter ".9router-*" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}

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
if ($script:isolated) {
  Write-Step "Isolated run (-Root): skipping the user PATH registry write"
  $env:Path = "$InstallDir;$env:Path"
} else {
  Write-Step "Ensuring $InstallDir is on your PATH"
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($userPath -split ";") -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
    Write-Okay "Added to user PATH (new terminals will pick it up)"
  } else { Write-Okay "Already on user PATH" }
  $env:Path = "$InstallDir;$env:Path"
}

# 8. Verify ---------------------------------------------------------------
$pkgPath = Join-Path $InstallDir "node_modules\9router\package.json"
if (-not (Test-Path $pkgPath)) { throw "Installed package.json missing" }
$installed = (Get-Content $pkgPath -Raw | ConvertFrom-Json).version
Write-Okay "9Router v$installed installed"
if ($Version -ne "latest" -and $installed -ne $Version.TrimStart("v")) {
  throw "Installed version $installed does not match requested $Version"
}

# Payload assertion: a package that installs without the prebuilt CLI server
# cannot start, so fail here with the path instead of timing out on health.
$payloadPath = Join-Path $InstallDir "node_modules\9router\app\.next-cli-build\server"
if (-not (Test-Path $payloadPath)) {
  throw "Installed package is missing the prebuilt server payload at $payloadPath"
}
Write-Okay "Prebuilt server payload present"

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

# Fully windowless spawn: CreateNoWindow + UseShellExecute=false means no
# console is allocated at all - Start-Process -WindowStyle Hidden would
# still flash one briefly on some shells.
function Start-InstalledCliWindowless {
  param([string]$CliPath, [int]$ServerPort)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = (Get-Command node).Source
  $psi.Arguments = "`"$CliPath`" --tray --skip-update -p $ServerPort"
  $psi.CreateNoWindow = $true
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($psi)
  if ($process) { $script:spawnedPids += $process.Id }
}

# Live-version gate: the acs daemon may resurrect ITS stale managed copy even
# though health returns 200 (/api/version would then disagree with the install).
# This is now a hard gate - a stale server is a failed install, not a warning.
$cli = Join-Path $InstallDir "node_modules\9router\cli.js"

function Get-LiveVersion {
  try {
    return (Invoke-RestMethod -Uri "$ServerUrl/api/version" -UseBasicParsing -TimeoutSec 5).currentVersion
  } catch { return $null }
}

if (-not $NoStart) {
  Write-Step "Starting 9Router on port $Port"
  if ($script:isolated) {
    # Never adopt (or fight) a server we did not start - require a free port.
    $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($busy) { throw "Port $Port is already in use (PID $($busy.OwningProcess)); pass a free NINEROUTER_PORT for an isolated run" }
    $script:portOwnedByRun = $true
  }
  $spawnedManually = $true
  if ($acs) {
    if (Invoke-Tolerant { & acs service start 9router --force 2>&1 | Out-Null }) { Write-Okay "started via acs (--force)"; $spawnedManually = $false }
    elseif (Invoke-Tolerant { & acs service start 9router 2>&1 | Out-Null }) { Write-Okay "started via acs"; $spawnedManually = $false }
  }
  if (Wait-Healthy) {
    $spawnedManually = $false
  } elseif ($spawnedManually) {
    Write-Warn2 "Service not healthy yet - spawning manually (fully silent, no terminal window)"
    Start-InstalledCliWindowless -CliPath $cli -ServerPort $Port
  }
  if (-not (Wait-Healthy)) {
    throw "Server did not report healthy at $ServerUrl/api/health - try: node `"$cli`" --tray --skip-update -p $Port"
  }

  $liveVersion = $null
  for ($attempt = 1; $attempt -le 20; $attempt++) {
    $liveVersion = Get-LiveVersion
    if ($liveVersion -eq $installed) { break }
    Start-Sleep -Milliseconds 500
  }
  if ($liveVersion -ne $installed) {
    # The supervisor resurrected its stale copy: sweep it and start ours once.
    Write-Warn2 "Live server reports v$liveVersion, not the installed v$installed (supervisor resurrected a stale copy)"
    Write-Warn2 "Killing stale instances and spawning the installed CLI windowlessly"
    if ($script:isolated) { Stop-IsolatedServer } else { Stop-All9Router | Out-Null }
    Start-Sleep -Seconds 2
    Start-InstalledCliWindowless -CliPath $cli -ServerPort $Port
    if (-not (Wait-Healthy)) { throw "Killed the stale server but the installed v$installed did not come up healthy" }
    $liveVersion = $null
    for ($attempt = 1; $attempt -le 20; $attempt++) {
      $liveVersion = Get-LiveVersion
      if ($liveVersion -eq $installed) { break }
      Start-Sleep -Milliseconds 500
    }
    if ($liveVersion -ne $installed) {
      throw "Installed v$installed, but $ServerUrl/api/version still reports v$liveVersion"
    }
  }
  Write-Okay "Live server reports v$liveVersion"

  # Shim cleanup runs only now that the install is confirmed: version match,
  # health 200, payload present. On an acs-managed box the prefix shims are
  # VALID (they point at the fork) and are kept; everywhere else stale shims
  # that shadow the user-dir shim in PATH order are removed.
  if (-not $script:isolated) {
    Write-Step "Cleaning stale global bin shims (if any)"
    if ($acs -and $prefixOk) {
      Write-Okay "Prefix shims kept (npm-prefix now carries the fork)"
    } else {
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
    }
  }

  Write-Host ""
  Write-Host "  Dashboard: $ServerUrl/dashboard" -ForegroundColor White
  Write-Host "  Gateway:   $ServerUrl/v1" -ForegroundColor White
  Write-Host "  Data dir:  $env:USERPROFILE\.9router (untouched by this install)" -ForegroundColor Gray
} else {
  # Backtick-escaped quotes, not \" - PowerShell does not treat \" as an escape
  # inside a double-quoted string: it closes the string, so Write-Step received
  # three arguments, dropped the extras, and printed a truncated command.
  Write-Step "-NoStart given; start later with: node `"$InstallDir\node_modules\9router\cli.js`" --tray --skip-update -p $Port"
}

# Isolated runs must leave the host idle: stop the server this run started.
if ($script:isolated -and -not $NoStart) {
  Write-Step "Isolated run (-Root): stopping the server started by this install"
  Stop-IsolatedServer
  Write-Okay "Host left idle"
}

if ($script:supervisorPaused) {
  Enable-ScheduledTask -TaskName $AcsSupervisorTaskPattern -ErrorAction SilentlyContinue | Out-Null
  $script:supervisorPaused = $false
  Write-Okay "ACS Daemon Supervisor re-enabled"
}

# Leave the watchdog running no matter what, so a previous crashed upgrade
# attempt that disabled it (and made this run skip the pause step) is also
# covered by the restore.
if (-not $script:isolated) {
  $wdNow = Get-ScheduledTask -TaskName $WatchdogTaskPattern -ErrorAction SilentlyContinue
  if ($wdNow -and $wdNow.State -eq "Disabled") {
    Enable-ScheduledTask -TaskName $WatchdogTaskPattern | Out-Null
    Write-Okay "Watchdog re-enabled"
  }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green