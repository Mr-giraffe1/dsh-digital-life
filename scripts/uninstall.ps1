<#
Remove the two changes install.ps1 made. Leaves her data root untouched.

Profile discovery matches install.ps1: -Profile, else $env:DSH_PROFILE_DIR, else
$DSH_HOME/profiles/desktop, else $DSH_HOME/profiles/web.
#>
[CmdletBinding()]
param(
  [string]$Profile,
  [string]$DshHome
)

$ErrorActionPreference = 'Stop'
$packageName = 'dsh-digital-life'

function Resolve-DshHome {
  if ($DshHome) { return (Resolve-Path -LiteralPath $DshHome).Path }
  if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') { return $env:DSH_HOME.Trim() }
  return (Join-Path $env:USERPROFILE '.dsh')
}

$dshHome = Resolve-DshHome
$profileDir = $Profile
if (-not $profileDir) {
  # Same precedence as install.ps1: an explicit -DshHome beats the ambient
  # DSH_PROFILE_DIR, otherwise you uninstall from a profile you never touched.
  $candidates = @((Join-Path $dshHome 'profiles\desktop'), (Join-Path $dshHome 'profiles\web'))
  if (-not $DshHome -and $env:DSH_PROFILE_DIR) { $candidates = @($env:DSH_PROFILE_DIR.Trim()) + $candidates }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { $profileDir = (Resolve-Path -LiteralPath $candidate).Path; break }
  }
}
if (-not $profileDir -or -not (Test-Path -LiteralPath $profileDir)) {
  throw "没能确定要卸载哪个 profile。用 -Profile <目录> 指定。"
}
Write-Host "==> profile = $profileDir"

$linkPath = Join-Path $profileDir "node_modules\$packageName"
if (Test-Path -LiteralPath $linkPath) {
  $item = Get-Item -LiteralPath $linkPath -Force
  if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
    # Remove the link only; never the target directory.
    [System.IO.Directory]::Delete($linkPath, $false)
    Write-Host "==> 已删除 junction $linkPath"
  } else {
    Write-Warning "$linkPath 不是链接，跳过删除"
  }
}

$patchPath = Join-Path $profileDir 'cordis.patch.yml'
if (Test-Path -LiteralPath $patchPath) {
  $content = Get-Content -LiteralPath $patchPath -Raw -Encoding UTF8
  $pattern = "(?m)^\#[^\n]*dsh-digital-life[^\n]*\r?\n(?:- insert:\s*\r?\n)?\s*- id:\s*digital-life\s*\r?\n\s*name:\s*'?" + [regex]::Escape($packageName) + "'?\s*\r?\n"
  $stripped = [regex]::Replace($content, $pattern, '')
  if ($stripped -ne $content) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($patchPath, $stripped, $utf8NoBom)
    Write-Host '==> 已从 cordis.patch.yml 移除 loader 行'
  } else {
    $backup = "$patchPath.before-digital-life"
    if (Test-Path -LiteralPath $backup) {
      Copy-Item -LiteralPath $backup -Destination $patchPath -Force
      Write-Host "==> 已从备份恢复 $backup"
    } else {
      Write-Warning 'patch 里没找到 digital-life 行，也没有备份可恢复'
    }
  }
}

Write-Host ''
Write-Host '卸载完成。她的数据根（manifest.json / portrait / memory）没有动。'
