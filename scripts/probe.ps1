<#
Boot an isolated DSH, verify the plugin against a REAL host, then tear it down.

Why this exists: the Host half cannot hot-reload (see ARCHITECTURE.md §15 #8).
The only honest way to check "does the current code still load and serve" is a
fresh host process. Doing that against the DSH you are working in means
restarting your own session, so this script builds a throwaway one instead:

  %TEMP%\dsh-life-probe-XXXX\      <- its own DSH_HOME, nothing shared
    profiles\probe\                <- scaffolded from the shipped `web` template
    digital-life\                  <- her data root (a newborn 悠悠)

Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/probe.ps1
  powershell ... -File scripts/probe.ps1 -Port 19399 -Keep   # leave it running
  powershell ... -File scripts/probe.ps1 -Stop               # stop leftovers

Exit code is the test suite's: 0 = the live checks passed.
#>
[CmdletBinding()]
param(
  [int]$Port = 19399,
  [string]$HomeDir,
  [string]$Node,
  [switch]$Keep,
  [switch]$SkipTests,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$packageName = 'dsh-digital-life'

function Write-Step($message) { Write-Host "==> $message" }
function Write-Warn($message) { Write-Host "!!  $message" -ForegroundColor Yellow }

function Find-InstallRoot {
  $roots = @()
  foreach ($known in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($known) { $roots += $known }
  }
  $userTail = 'Users\{0}\AppData\Local' -f $env:USERNAME
  foreach ($drive in Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -match '^[A-Za-z]:\\$' }) {
    $roots += ($drive.Root + $userTail)
  }
  foreach ($root in $roots) {
    $candidate = Join-Path $root 'Programs\DeepSeek Harness'
    if (Test-Path -LiteralPath (Join-Path $candidate 'resources\runtime\cli\bin\dsh.cmd')) { return $candidate }
  }
  return $null
}

function Find-NodeExe([string]$installRoot) {
  if ($Node) { return $Node }
  if ($installRoot) {
    $candidate = Join-Path $installRoot 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  return $null
}

function Stop-Probe([string]$homeDir) {
  $pidFile = Join-Path $homeDir 'probe.pid'
  if (-not (Test-Path -LiteralPath $pidFile)) { Write-Warn "没有找到 $pidFile"; return }
  $probePid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  if ($probePid -match '^\d+$') {
    Write-Step "停止探针进程 pid=$probePid"
    # Stop-Process, not `cmd /c taskkill`: spawning another console host here is
    # what leaves the script apparently hung after the tests are already green.
    Stop-Process -Id ([int]$probePid) -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

# --- stop mode --------------------------------------------------------------
if ($Stop) {
  $targets = @()
  if ($HomeDir) { $targets += $HomeDir } else {
    $targets += Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'dsh-life-probe-*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
  }
  foreach ($target in $targets) {
    Stop-Probe $target
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue }
  }

  # A host whose parent tool call was killed keeps listening with no pid file
  # left behind, and then every later probe fails to bind. Sweep the port too.
  $listeners = netstat -ano | Select-String ":$Port\b" | Select-String 'LISTENING'
  foreach ($listener in $listeners) {
    $owner = ($listener.ToString() -split '\s+')[-1]
    if ($owner -match '^\d+$') {
      Write-Step "端口 $Port 上还有残留进程 pid=$owner，顺手停掉"
      Stop-Process -Id ([int]$owner) -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Host '探针已清理。'
  exit 0
}

# --- locate the desktop install --------------------------------------------
$installRoot = Find-InstallRoot
if (-not $installRoot) { throw '没找到 DeepSeek Harness 安装目录（可用 -Node / 手动指定 PATH）' }
$dshCmd = Join-Path $installRoot 'resources\runtime\cli\bin\dsh.cmd'
$nodeExe = Find-NodeExe $installRoot
if (-not $nodeExe) { throw '没找到 node.exe（用 -Node 指定）' }
Write-Step "DSH     = $installRoot"
Write-Step "node    = $nodeExe"

# --- throwaway home ---------------------------------------------------------
$homeDir = $HomeDir
if (-not $homeDir) {
  $homeDir = Join-Path $env:TEMP ('dsh-life-probe-' + ([guid]::NewGuid().ToString('N').Substring(0, 8)))
}
$homeDir = [System.IO.Path]::GetFullPath($homeDir)
if (Test-Path -LiteralPath $homeDir) {
  Write-Warn "$homeDir 已存在，先清理"
  Remove-Item -LiteralPath $homeDir -Recurse -Force
}
New-Item -ItemType Directory -Path $homeDir -Force | Out-Null
Write-Step "DSH_HOME = $homeDir"

$env:DSH_HOME = $homeDir
$profileName = 'probe'

try {
  # --- 1. scaffold a profile from the shipped `web` template ---------------
  Write-Step '从内置 web 模板生成 profile'
  $dump = & $dshCmd $profileName --from-default-profile web --dump-config 2>&1
  if ($LASTEXITCODE -ne 0) { throw "生成 profile 失败：`n$($dump -join "`n")" }
  $profileDir = Join-Path $homeDir "profiles\$profileName"
  if (-not (Test-Path -LiteralPath (Join-Path $profileDir 'package.json'))) { throw "profile 没有生成：$profileDir" }

  # --- 2. link the plugin in + add the loader row --------------------------
  Write-Step '安装插件到探针 profile'
  $installOut = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install.ps1') -DshHome $homeDir -Profile $profileDir -Node $nodeExe 2>&1
  if ($LASTEXITCODE -ne 0) { throw "安装失败：`n$($installOut -join "`n")" }
  $installOut | Where-Object { $_ -match '^==>' } | ForEach-Object { Write-Host $_ }

  # --- 3. boot -------------------------------------------------------------
  $busy = netstat -ano | Select-String ":$Port\b" | Select-String 'LISTENING'
  if ($busy) {
    throw "端口 $Port 已经被占用（多半是上一次探针的残留）。换个端口：-Port 19400，或者先跑 scripts/probe.ps1 -Stop。`n$($busy -join "`n")"
  }
  $logPath = Join-Path $homeDir 'host.log'
  $errPath = Join-Path $homeDir 'host.err.log'
  Write-Step "启动宿主（端口 $Port）"
  $arguments = @('/c', "`"$dshCmd`" --profile $profileName --port $Port --no-open")
  $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList $arguments -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $logPath -RedirectStandardError $errPath
  Set-Content -LiteralPath (Join-Path $homeDir 'probe.pid') -Value $proc.Id -Encoding ascii

  $base = "http://127.0.0.1:$Port"
  $deadline = (Get-Date).AddSeconds(120)
  $state = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    if ($proc.HasExited) { break }
    try {
      $response = Invoke-WebRequest -Uri "$base/digital-life/state.json" -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200) { $state = $response.Content | ConvertFrom-Json; break }
    } catch { }
  }

  if (-not $state) {
    $tail = @()
    foreach ($file in @($logPath, $errPath)) {
      if (Test-Path -LiteralPath $file) { $tail += (Get-Content -LiteralPath $file -Tail 25) }
    }
    throw "宿主没有起来（端口 $Port）。日志尾部：`n$($tail -join "`n")"
  }
  Write-Step "宿主已就绪：phase=$($state.phase) name=$($state.name)"

  # --- 4. make sure she exists (a fresh home is unborn) --------------------
  if ($state.phase -eq 'unborn') {
    Write-Step '新家是 unborn，先创建她'
    $create = Invoke-WebRequest -Uri "$base/digital-life/action" -Method POST -UseBasicParsing -TimeoutSec 20 `
      -ContentType 'application/json' -Body '{"action":"create"}'
    $created = $create.Content | ConvertFrom-Json
    if (-not $created.ok) { throw "创建失败：$($create.Content)" }
    Write-Step "创建成功：$($created.snapshot.phase)"
  }

  # --- 5. run the live suite ----------------------------------------------
  $status = 0
  if (-not $SkipTests) {
    Write-Step '跑 test/run.mjs --live'
    $env:DSH_LIFE_URL = $base
    # Run the suites as their own process with their own log. Handing the
    # console down to a grandchild that spawns grandchildren is what made this
    # step stall under a captured console; a detached process cannot.
    $testLog = Join-Path $homeDir 'probe-test.log'
    $testErr = Join-Path $homeDir 'probe-test.err.log'
    $runner = Start-Process -FilePath $nodeExe -ArgumentList @((Join-Path $repo 'test\run.mjs'), '--live') `
      -WorkingDirectory $repo -Wait -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput $testLog -RedirectStandardError $testErr
    $status = $runner.ExitCode
    if (Test-Path -LiteralPath $testLog) {
      Get-Content -LiteralPath $testLog | Where-Object { $_ -match 'FAIL|ALL SUITES|SUITE\(S\) FAILED|^=== ' } | ForEach-Object { Write-Host $_ }
      Write-Step "完整日志：$testLog"
    }
  } else {
    Write-Host ''
    Write-Host "探针在跑：$base"
    Write-Host "  验证：`$env:DSH_LIFE_URL='$base'; & '$nodeExe' test/run.mjs --live"
    Write-Host "  停止：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/probe.ps1 -Stop -HomeDir `"$homeDir`""
  }

  if (-not $Keep) {
    Stop-Probe $homeDir
    if (-not $SkipTests -and $status -eq 0) {
      Remove-Item -LiteralPath $homeDir -Recurse -Force -ErrorAction SilentlyContinue
      Write-Step '探针已清理'
    } else {
      Write-Warn "保留现场：$homeDir"
    }
  }

  exit $status
} catch {
  Write-Host ''
  Write-Host "!! 失败：$($_.Exception.Message)" -ForegroundColor Red
  $pidFile = Join-Path $homeDir 'probe.pid'
  if (Test-Path -LiteralPath $pidFile) {
    $probePid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ($probePid) { & cmd /c "taskkill /T /F /PID $probePid >nul 2>&1" }
  }
  Write-Warn "现场保留在：$homeDir（日志：host.log / host.err.log）"
  exit 1
}
