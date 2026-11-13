param(
  [int]$Port = 18080
)
$ErrorActionPreference = 'Stop'

$packageName = 'agentrouter-responses-shim'
$npmRoot = (& npm root -g 2>$null | Select-Object -First 1)
if (-not $npmRoot) { throw 'npm root -g failed. Is Node.js/npm installed?' }
$srcDir = Join-Path (Join-Path $npmRoot $packageName) 'src'

$restored = 0
foreach ($file in @('sanitize.mjs', 'server.mjs', 'retry-cli.mjs', 'retry-routing.mjs')) {
  $target = Join-Path $srcDir $file
  $backup = Join-Path $srcDir "$file.orig-2.0.1"
  if (Test-Path $backup) {
    Copy-Item $backup $target -Force
    Write-Host "[patch] restored: $file"
    $restored++
  } elseif (Test-Path $target) {
    Remove-Item $target -Force
    Write-Host "[patch] removed file added by patch: $file"
    $restored++
  } else {
    Write-Host "[patch] nothing to restore for $file"
  }
}

$binTarget = Join-Path (Join-Path (Split-Path -Parent $srcDir) 'bin') 'agentrouter-shim.mjs'
if (Test-Path "$binTarget.orig-2.0.1") {
  Copy-Item "$binTarget.orig-2.0.1" $binTarget -Force
  Write-Host '[patch] restored: bin/agentrouter-shim.mjs'
  $restored++
} else {
  Write-Host '[patch] nothing to restore for bin/agentrouter-shim.mjs'
}

if ($restored -gt 0) {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') {
      Write-Host "[patch] restarting shim (pid $($proc.Id))..."
      Stop-Process -Id $proc.Id -Force
    }
  }
  Write-Host '[patch] done. Original files restored.'
}

