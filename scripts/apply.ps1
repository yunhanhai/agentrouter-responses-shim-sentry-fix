param(
  [int]$Port = 18080,
  [switch]$NoRestart
)
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageName = 'agentrouter-responses-shim'

Write-Host '[patch] locating global npm package...'
$npmRoot = (& npm root -g 2>$null | Select-Object -First 1)
if (-not $npmRoot) { throw 'npm root -g failed. Is Node.js/npm installed?' }
$pkgDir = Join-Path $npmRoot $packageName
$srcDir = Join-Path $pkgDir 'src'
$binDir = Join-Path $pkgDir 'bin'
if (-not (Test-Path (Join-Path $srcDir 'sanitize.mjs'))) {
  throw "Package not found at $pkgDir. Install it first: npm install -g $packageName"
}

$copyWithBackup = {
  param($source, $target, $label)
  $backup = "$target.orig-2.0.1"
  if ((Test-Path $target) -and -not (Test-Path $backup)) {
    Copy-Item $target $backup
    Write-Host "[patch] backed up: $label -> $(Split-Path -Leaf $backup)"
  }
  Copy-Item $source $target -Force
  Write-Host "[patch] patched: $label"
}

foreach ($file in @('sanitize.mjs', 'server.mjs', 'retry-cli.mjs', 'retry-routing.mjs')) {
  & $copyWithBackup (Join-Path $repoRoot "src-patched\$file") (Join-Path $srcDir $file) $file
}
& $copyWithBackup (Join-Path $repoRoot 'bin-patched\agentrouter-shim.mjs') (Join-Path $binDir 'agentrouter-shim.mjs') 'bin/agentrouter-shim.mjs'

if ($NoRestart) {
  Write-Host '[patch] done. Restart the shim manually to apply.'
  exit 0
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) {
  Write-Host "[patch] nothing listening on port $Port. Start the shim, then verify:"
  Write-Host "  Invoke-RestMethod http://127.0.0.1:$Port/healthz"
  exit 0
}

$proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
if ($proc -and $proc.ProcessName -eq 'node') {
  Write-Host "[patch] stopping running shim (pid $($proc.Id)) to apply the patch..."
  Stop-Process -Id $proc.Id -Force
  Start-Sleep -Seconds 6
  try {
    $health = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 5
    Write-Host "[patch] shim restarted: $($health | ConvertTo-Json -Compress)"
  } catch {
    Write-Host '[patch] shim did not come back automatically.'
    Write-Host "  If you run it under a supervisor/wrapper it will restart shortly, otherwise start it manually."
  }
} else {
  Write-Host "[patch] port $Port is used by a non-node process; restart the shim manually."
}
