# STAGE 4 - ROLLBACK (owner-run, only if needed after stage 3): promote the pre-hotfix deployment
# lfhr9ra1w back (build fc645727, created 2026-10-23 with the rotated DB credential), then verify.
# It never rolls back to 9fjraopmr, qsc3ojpkl or anything older: those hold the revoked password.
. (Join-Path $PSScriptRoot 'common.ps1')
$live = Get-LiveDeploymentUrl
Write-Host "syveka.com currently serves: $live"
if ($live -eq $RollbackUrl) { Write-Host 'Production already serves the rollback target; nothing to do.'; exit 0 }

Write-Host "checking the rollback target before promoting it: $RollbackUrl"
if (-not (Test-StagedRecord $RollbackUrl)) { Stop-Recovery 'rollback target is not a Ready production deployment' }
if (-not (Test-StagedHealth $RollbackUrl -ExpectSha $RollbackSha)) { Stop-Recovery 'rollback target is not healthy with database ok and build fc645727; do NOT pick another old deployment, send this output to Claude' }

Write-Host "promoting rollback target $RollbackUrl"
$p = Invoke-Vercel "promote $RollbackUrl --scope $Scope --yes --timeout 5m"
$p | ForEach-Object { Write-Host "  $_" }
if ($script:VercelExit -ne 0) { Stop-Recovery "vercel promote exited with code $($script:VercelExit)" }

$ok = $false
for ($i = 1; $i -le 18 -and -not $ok; $i++) {
    Write-Host "public check $i/18"
    $a = Test-PublicHealth $PublicHealth[0] $RollbackSha; $b = Test-PublicHealth $PublicHealth[1] $RollbackSha
    $ok = $a -and $b
    if (-not $ok) { Start-Sleep -Seconds 10 }
}
if (-not $ok) { Write-Host 'Rollback promoted but public hosts are not healthy on fc645727 yet. Send this output to Claude.' -ForegroundColor Yellow; exit 2 }
Write-Host "ROLLBACK PASS: both public hosts HTTP 200, healthy, database ok, build $RollbackSha." -ForegroundColor Green
