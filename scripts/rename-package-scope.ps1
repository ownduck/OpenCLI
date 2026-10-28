# Temporary publish helper: rename package import scope in-place.
# Usage:
#   powershell -NoProfile -File scripts/rename-package-scope.ps1 -Direction to-woosau
#   powershell -NoProfile -File scripts/rename-package-scope.ps1 -Direction to-jackwener
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('to-woosau', 'to-jackwener')]
  [string]$Direction
)

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $Root

$From = if ($Direction -eq 'to-woosau') { '@jackwener/opencli' } else { '@woosau/opencli' }
$To   = if ($Direction -eq 'to-woosau') { '@woosau/opencli' } else { '@jackwener/opencli' }

$ExcludeDirNames = [System.Collections.Generic.HashSet[string]]::new(
  [string[]]@(
    '.git', 'node_modules', 'dist', 'coverage', '.vitepress', '.cache', '.turbo',
    'results', '.workbuddy', '.claude', '.cursor', 'AgentStores'
  )
)
$ExcludeFileNames = [System.Collections.Generic.HashSet[string]]::new(
  [string[]]@(
    'rename-to-woosau.bat',
    'restore-to-jackwener.bat',
    'deploy-rename.sh',
    'deploy.cmd',
    'publish.bat',
    'rename-package-scope.ps1'
  )
)
$IncludeExt = [System.Collections.Generic.HashSet[string]]::new(
  [string[]]@('.js', '.ts', '.mjs', '.cjs', '.mts', '.cts', '.json', '.md', '.yml', '.yaml', '.txt', '.sh', '.bat', '.ps1')
)

function Test-ExcludedPath([string]$FullPath) {
  $rel = $FullPath.Substring($Root.Path.Length).TrimStart('\', '/')
  foreach ($part in ($rel -split '[\\/]+')) {
    if ($ExcludeDirNames.Contains($part)) { return $true }
  }
  if ($rel -match '(?i)(^|[/\\])autoresearch[/\\]results([/\\]|$)') { return $true }
  return $false
}

$files = Get-ChildItem -Path $Root -Recurse -File -Force | Where-Object {
  if (-not $IncludeExt.Contains($_.Extension.ToLowerInvariant())) { return $false }
  if ($ExcludeFileNames.Contains($_.Name)) { return $false }
  if (Test-ExcludedPath $_.FullName) { return $false }
  # Reverse must not rewrite package.json "name" / whole file; handled separately.
  if ($Direction -eq 'to-jackwener' -and ($_.Name -eq 'package.json' -or $_.Name -eq 'package-lock.json' -or $_.Name -eq 'pnpm-lock.yaml')) {
    return $false
  }
  return $true
}

$changed = 0
$changedPaths = New-Object System.Collections.Generic.List[string]

$failed = New-Object System.Collections.Generic.List[string]
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Write-TextRetry([string]$Path, [string]$Content) {
  $attempt = 0
  while ($true) {
    try {
      [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
      return
    } catch {
      $attempt += 1
      if ($attempt -ge 5) { throw }
      Start-Sleep -Milliseconds (100 * $attempt)
    }
  }
}

foreach ($file in $files) {
  try {
    $raw = [System.IO.File]::ReadAllText($file.FullName)
    if ($raw.IndexOf($From, [System.StringComparison]::Ordinal) -lt 0) { continue }
    $next = $raw.Replace($From, $To)
    if ($next -eq $raw) { continue }
    Write-TextRetry $file.FullName $next
    $changed += 1
    $changedPaths.Add($file.FullName.Substring($Root.Path.Length).TrimStart('\', '/')) | Out-Null
  } catch {
    $failed.Add(("{0}: {1}" -f ($file.FullName.Substring($Root.Path.Length).TrimStart('\', '/')), $_.Exception.Message)) | Out-Null
  }
}

# Reverse excludes package.json entirely so "name": "@woosau/opencli" stays put.

Write-Host "==> $From -> $To"
Write-Host "files changed: $changed"
if ($changed -gt 0 -and $changed -le 40) {
  $changedPaths | ForEach-Object { Write-Host "  $_" }
} elseif ($changed -gt 40) {
  $changedPaths | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" }
  Write-Host ("  ... and {0} more" -f ($changed - 20))
}
if ($failed.Count -gt 0) {
  Write-Host "FAILED writes: $($failed.Count)"
  $failed | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" }
  exit 1
}
Write-Host "NOTE: temporary local rename for publish — do not commit."
if ($Direction -eq 'to-woosau') {
  Write-Host "Next: npm run build && publish.bat   then restore-to-jackwener.bat"
}
