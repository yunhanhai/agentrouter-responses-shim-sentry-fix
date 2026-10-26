param(
  [int]$Port = 18080,
  [switch]$NoRestart
)
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageName = 'agentrouter-responses-shim'

Write-Host '[sentry-fix-v1] locating global npm package...'
$npmRoot = (& npm root -g 2>$null | Select-Object -First 1)
if (-not $npmRoot) { throw 'npm root -g failed. Is Node.js/npm installed?' }
$pkgDir = Join-Path $npmRoot $packageName
$srcDir = Join-Path $pkgDir 'src'
if (-not (Test-Path (Join-Path $srcDir 'sanitize.mjs'))) {
  throw "Package not found at $pkgDir. Install it first: npm install -g $packageName"
}

foreach ($file in @('sanitize.mjs', 'server.mjs')) {
  $target = Join-Path $srcDir $file
  $backup = "$target.orig-2.0.1"
  if (-not (Test-Path $backup)) {
    Copy-Item $target $backup
    Write-Host "[sentry-fix-v1] backed up: $file -> $(Split-Path -Leaf $backup)"
  }
  Copy-Item (Join-Path $repoRoot "src-patched\$file") $target -Force
  Write-Host "[sentry-fix-v1] patched: $file"
}

if ($NoRestart) {
  Write-Host '[sentry-fix-v1] done. Restart the shim manually to apply.'
  exit 0
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) {
  Write-Host "[sentry-fix-v1] nothing listening on port $Port. Start the shim, then verify:"
  Write-Host "  Invoke-RestMethod http://127.0.0.1:$Port/healthz"
  exit 0
}

$proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
if ($proc -and $proc.ProcessName -eq 'node') {
  Write-Host "[sentry-fix-v1] stopping running shim (pid $($proc.Id)) to apply the patch..."
  Stop-Process -Id $proc.Id -Force
  Start-Sleep -Seconds 6
  try {
    $health = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 5
    Write-Host "[sentry-fix-v1] shim restarted: $($health | ConvertTo-Json -Compress)"
  } catch {
    Write-Host '[sentry-fix-v1] shim did not come back automatically.'
    Write-Host "  If you run it under a supervisor/wrapper it will restart shortly, otherwise start it manually."
  }
} else {
  Write-Host "[sentry-fix-v1] port $Port is used by a non-node process; restart the shim manually."
}
