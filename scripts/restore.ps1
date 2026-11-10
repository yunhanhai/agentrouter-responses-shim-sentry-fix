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
    Write-Host "[sentry-fix-v1] restored: $file"
    $restored++
  } elseif (Test-Path $target) {
    Remove-Item $target -Force
    Write-Host "[sentry-fix-v1] removed file added by patch: $file"
    $restored++
  } else {
    Write-Host "[sentry-fix-v1] nothing to restore for $file"
  }
}

if ($restored -gt 0) {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') {
      Write-Host "[sentry-fix-v1] restarting shim (pid $($proc.Id))..."
      Stop-Process -Id $proc.Id -Force
    }
  }
  Write-Host '[sentry-fix-v1] done. Original files restored.'
}
