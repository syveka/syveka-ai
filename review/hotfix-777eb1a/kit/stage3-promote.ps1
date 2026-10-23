# STAGE 3 (owner-run): promote ONLY the hotfix deployment that passed stage 2, after re-checking it and
# confirming production still serves the recorded rollback target; then verify both public hosts.
. (Join-Path $PSScriptRoot 'common.ps1')
$url = Get-StagedUrl
if (-not (Test-Path -LiteralPath $VerifiedFile)) { Stop-Recovery 'stage 2 has not passed (verified.txt missing)' }
$v = (Get-Content -LiteralPath $VerifiedFile -TotalCount 1).Trim().Split(' ')
if ($v[0] -ne $url) { Stop-Recovery 'verified.txt is for a different deployment' }
if (((Get-Date).ToUniversalTime() - [datetime]::Parse($v[1]).ToUniversalTime()).TotalMinutes -gt 30) { Stop-Recovery 'stage 2 result is older than 30 minutes; rerun stage 2' }

# Rollback-target gate: production must still be the deployment this plan rolls back to, and healthy.
$live = Get-LiveDeploymentUrl
Write-Host "syveka.com currently serves: $live"
if ($live -ne $RollbackUrl) { Stop-Recovery "production no longer serves the recorded rollback target $RollbackUrl; re-plan before promoting" }
foreach ($h in $PublicHealth) { if (-not (Test-PublicHealth $h $RollbackSha)) { Stop-Recovery 'production is not healthy on the rollback target right now; investigate before promoting' } }
Write-Host "rollback target confirmed live and healthy: $RollbackUrl (build $RollbackSha)"

Write-Host "re-checking $url immediately before promotion"
if (-not (Test-StagedRecord $url)) { Stop-Recovery 'staged deployment is no longer Ready/production' }
if (-not (Test-StagedHealth $url)) { Stop-Recovery 'staged deployment no longer healthy with database ok and the exact SHA. NOT promoting.' }

Write-Host "promoting $url"
$p = Invoke-Vercel "promote $url --scope $Scope --yes --timeout 5m"
$p | ForEach-Object { Write-Host "  $_" }
if ($script:VercelExit -ne 0) { Stop-Recovery "vercel promote exited with code $($script:VercelExit)" }

$ok = $false
for ($i = 1; $i -le 18 -and -not $ok; $i++) {
    Write-Host "public check $i/18"
    $a = Test-PublicHealth $PublicHealth[0]; $b = Test-PublicHealth $PublicHealth[1]
    $ok = $a -and $b
    if (-not $ok) { Start-Sleep -Seconds 10 }
}
if (-not $ok) {
    Write-Host "Promotion ran but public hosts are not healthy/database ok/build $Sha within 3 minutes." -ForegroundColor Yellow
    Write-Host 'Roll back with stage4-rollback.ps1 (promotes lfhr9ra1w). Never roll back to 9fjraopmr/qsc3ojpkl or older (revoked password). Send this output to Claude.' -ForegroundColor Yellow
    exit 2
}
Write-Host "STAGE 3 PASS: both public hosts HTTP 200, healthy, database ok, build $Sha. Monitor runtime logs for 10 minutes." -ForegroundColor Green
