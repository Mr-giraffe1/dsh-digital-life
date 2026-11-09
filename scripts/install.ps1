<#
Install dsh-digital-life into a DSH profile.

Two changes, both reversible:
  1. a directory junction  <profile>/node_modules/dsh-digital-life -> this repo's package
     (a junction is enough because the package imports ONLY node: builtins, so
      Node's realpath resolution never needs to find anything in the profile)
  2. one `insert` row appended to <profile>/cordis.patch.yml, backed up first

Nothing else is touched. Undo with uninstall.ps1.

The profile is discovered, not assumed: pass -Profile, or let the script pick
DSH_PROFILE_DIR / $DSH_HOME/profiles/desktop / $DSH_HOME/profiles/web.
A profile whose cordis.patch.yml is missing gets one created (with a header
comment) instead of the old hard failure — a profile built from a shipped
template legitimately has no user overlay yet.
#>
[CmdletBinding()]
param(
  [string]$Profile,
  # Data home override; defaults to $env:DSH_HOME, then ~/.dsh
  [string]$DshHome,
  # node.exe used only for the final resolution check; discovered when omitted
  [string]$Node
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$packageDir = Join-Path $repo 'packages\digital-life'
$packageName = 'dsh-digital-life'
$Marker = '# dsh-digital-life: added by scripts/install.ps1 (remove with scripts/uninstall.ps1)'

function Normalize-LinkPath([string]$path) {
  # A junction's Target comes back in the NT namespace form, e.g.
  #   Global\F:\repo\packages\digital-life
  # so strip the namespace prefixes before comparing it to a plain path.
  $p = ([string]$path).Trim()
  foreach ($prefix in @('\\?\Global\', '\??\Global\', 'Global\', '\\?\', '\??\')) {
    if ($p.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $p = $p.Substring($prefix.Length); break }
  }
  return $p.TrimEnd('\', '/')
}

function Write-Step($message) { Write-Host "==> $message" }
function Write-Warn($message) { Write-Host "!!  $message" -ForegroundColor Yellow }

function Resolve-DshHome {
  if ($DshHome) { return (Resolve-Path -LiteralPath $DshHome).Path }
  if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') { return $env:DSH_HOME.Trim() }
  return (Join-Path $env:USERPROFILE '.dsh')
}

function Resolve-Profile([string]$dshHome) {
  if ($Profile) {
    if (-not (Test-Path -LiteralPath $Profile)) { throw "找不到 profile：$Profile" }
    return (Resolve-Path -LiteralPath $Profile).Path
  }

  $candidates = @()
  # An explicit home is the strongest signal; the ambient DSH_PROFILE_DIR only
  # counts when the caller did not pin a home of their own.
  $candidates += (Join-Path $dshHome 'profiles\desktop')
  $candidates += (Join-Path $dshHome 'profiles\web')
  if (-not $DshHome -and $env:DSH_PROFILE_DIR -and $env:DSH_PROFILE_DIR.Trim() -ne '') {
    $candidates = @($env:DSH_PROFILE_DIR.Trim()) + $candidates
  }

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
  }

  $profilesRoot = Join-Path $dshHome 'profiles'
  $existing = @()
  if (Test-Path -LiteralPath $profilesRoot) {
    $existing = @(Get-ChildItem -LiteralPath $profilesRoot -Directory -Force | Select-Object -ExpandProperty Name)
    # Exactly one profile and it is not called desktop/web: that is unambiguous.
    if ($existing.Count -eq 1) {
      $only = Join-Path $profilesRoot $existing[0]
      if (Test-Path -LiteralPath (Join-Path $only 'cordis.yml') -or Test-Path -LiteralPath (Join-Path $only 'package.json')) { return $only }
    }
  }
  $hint = if ($existing.Count -gt 0) { "现有 profile：$($existing -join ', ')。用 -Profile 指定，例如 -Profile (Join-Path '$profilesRoot' '<名字>')" } else { "在 $profilesRoot 下没有找到任何 profile；先启动一次 DSH，让宿主初始化它。" }
  throw "没能确定要装进哪个 profile。$hint"
}

function Find-Node {
  $candidates = @()
  if ($Node) { $candidates += $Node }
  if ($env:DSH_DESKTOP_NODE_EXECUTABLE) { $candidates += $env:DSH_DESKTOP_NODE_EXECUTABLE }
  $candidates += (Join-Path $dshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')

  # Desktop install layout, wherever the app happens to live:
  #   <root>\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
  $installRoots = @()
  foreach ($known in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($known) { $installRoots += $known }
  }
  $userTail = 'Users\{0}\AppData\Local' -f $env:USERNAME
  foreach ($drive in Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -match '^[A-Za-z]:\\$' }) {
    $installRoots += ($drive.Root + $userTail)
  }
  foreach ($root in $installRoots) {
    if ($root) {
      $candidates += (Join-Path $root 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe')
      $candidates += (Join-Path $root 'Programs\nodejs\node.exe')
    }
  }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  return $null
}

$dshHome = Resolve-DshHome
if (-not (Test-Path -LiteralPath $dshHome)) {
  throw "找不到 DSH_HOME：$dshHome（用 -DshHome 指定，或先启动一次 DSH）"
}
$profileDir = Resolve-Profile $dshHome

if (-not (Test-Path -LiteralPath (Join-Path $packageDir 'package.json'))) {
  throw "找不到包：$packageDir"
}

Write-Step "DSH_HOME = $dshHome"
Write-Step "profile  = $profileDir"

# --- 1. junction ------------------------------------------------------------
$linkPath = Join-Path $profileDir "node_modules\$packageName"
$nodeModules = Join-Path $profileDir 'node_modules'
if (-not (Test-Path -LiteralPath $nodeModules)) { New-Item -ItemType Directory -Path $nodeModules | Out-Null }

if (Test-Path -LiteralPath $linkPath) {
  $existing = Get-Item -LiteralPath $linkPath -Force
  $target = $null
  if ($existing.LinkType -eq 'Junction' -or $existing.LinkType -eq 'SymbolicLink') {
    $target = ($existing.Target | Select-Object -First 1)
  }
  if ($target -and ((Normalize-LinkPath $target) -ieq (Normalize-LinkPath $packageDir))) {
    Write-Step 'junction 已存在且指向本仓库，跳过'
  } else {
    throw "$linkPath 已存在（目标：$target），且不是指向 $packageDir 的链接。为安全起见不覆盖，请先手动处理。"
  }
} else {
  Write-Step "建立 junction：$linkPath -> $packageDir"
  New-Item -ItemType Junction -Path $linkPath -Target $packageDir | Out-Null
}

# --- 2. loader row ----------------------------------------------------------
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
# cordis.patch.yml is itself a patch list (same shape as the probe overlay), so
# the row is a bare `- insert:` item, not a fragment of a bigger document.
$block = @"
$Marker
- insert:
    - id: digital-life
      name: '$packageName'

"@

if (-not (Test-Path -LiteralPath $patchPath)) {
  $cordis = Join-Path $profileDir 'cordis.yml'
  if (-not (Test-Path -LiteralPath $cordis)) {
    throw "$profileDir 既没有 cordis.patch.yml 也没有 cordis.yml，看起来不是 DSH profile 目录。"
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($patchPath, $block, $utf8NoBom)
  Write-Step 'profile 原本没有 cordis.patch.yml，已新建并写入 loader 行'
} else {
  $backup = "$patchPath.before-digital-life"
  if (-not (Test-Path -LiteralPath $backup)) {
    Copy-Item -LiteralPath $patchPath -Destination $backup
    Write-Step "已备份 patch：$backup"
  }

  $content = Get-Content -LiteralPath $patchPath -Raw -Encoding UTF8
  if ($content -match '(?m)^\s*-?\s*id:\s*digital-life\s*$' -and $content -match $packageName) {
    Write-Step 'patch 里已经有 digital-life 行，跳过'
  } else {
    # A freshly scaffolded profile ships `[]` as its patch list. Appending a
    # `- insert:` item after `[]` produces invalid YAML ("end of the stream or a
    # document separator is expected"), and the host refuses to boot. Replace the
    # empty-array placeholder instead of appending to it.
    $meaningful = @($content -split "\r?\n" | Where-Object { $_.Trim() -ne '' -and -not $_.TrimStart().StartsWith('#') })
    $isEmptyList = ($meaningful.Count -eq 0) -or (($meaningful.Count -eq 1) -and ($meaningful[0].Trim() -eq '[]'))

    if ($isEmptyList) {
      Write-Step 'cordis.patch.yml 是空列表，用 loader 行替换占位符'
      if ($content -match '(?m)^\s*\[\]\s*$') {
        $next = [regex]::Replace($content, '(?m)^[ \t]*\[\][ \t]*$', $block.TrimEnd() + "`n")
      } else {
        $next = $content.TrimEnd() + "`n`n" + $block
      }
    } else {
      Write-Step '向 cordis.patch.yml 追加 loader 行'
      if (-not $content.EndsWith("`n")) { $content += "`n" }
      $next = $content + $block
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($patchPath, $next, $utf8NoBom)
  }
}

# --- 3. verify resolution ---------------------------------------------------
$node = Find-Node
if ($node) {
  $probe = $profileDir -replace '\\', '/'
  $probeScript = "import { createRequire } from 'node:module'; console.log(createRequire('$probe/noop.js').resolve('$packageName/package.json'))"
  $resolved = & $node --input-type=module -e $probeScript 2>&1
  if ($LASTEXITCODE -ne 0) { throw "从 $profileDir 解析不到 $packageName：$resolved" }
  Write-Step "解析成功：$resolved"
} else {
  Write-Warn '没找到 node，跳过解析校验'
}

Write-Host ''
Write-Host '装好了。Host 半没有热重载：'
Write-Host '  - 新增 loader 行一般会被自动扫到，但改过的 Host 代码不会重新 import'
Write-Host '  - 要让最新代码生效：重启 DeepSeek Harness（或在 设置 → 插件 里关掉再打开该行）'
Write-Host '  - 不想动正在用的实例？用 scripts/probe.ps1 起一个隔离实例验证'
Write-Host '加载成功后，左侧栏会出现一个「书房」图标。'
