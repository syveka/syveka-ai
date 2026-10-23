# STAGE 2 (owner-run): verify the staged deployment. Read-only; changes nothing.
# PASS requires: record Ready + target production, and /api/health = healthy, database ok, build fc645727cc8f0932f90c793667d8cfe3de0b35d3.
. (Join-Path $PSScriptRoot 'common.ps1')
Remove-Item -LiteralPath $VerifiedFile -ErrorAction SilentlyContinue
$url = Get-StagedUrl
Write-Host "verifying staged deployment $url"
if (-not (Test-StagedRecord $url)) { Stop-Recovery 'staged deployment is not Ready with target production' }
$ok = $false
for ($i = 1; $i -le 12 -and -not $ok; $i++) {
    Write-Host "attempt $i/12"
    $ok = Test-StagedHealth $url
    if (-not $ok) { Start-Sleep -Seconds 10 }
}
if (-not $ok) { Stop-Recovery 'staged deployment did not report healthy + database ok + the exact SHA. DO NOT PROMOTE.' }
Set-Content -LiteralPath $VerifiedFile -Encoding ASCII -Value ("{0} {1}" -f $url, (Get-Date).ToUniversalTime().ToString('o'))
Write-Host "STAGE 2 PASS: $url is healthy, database ok, build $Sha. Next: stage 3 (promote)." -ForegroundColor Green
