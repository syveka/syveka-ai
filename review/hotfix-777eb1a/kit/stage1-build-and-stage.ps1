# STAGE 1 (owner-run): fresh Linux build of the hotfix 777eb1a (PR #363) and a STAGED production deployment (--skip-domain).
# Does not promote, does not move the production alias, runs no migration, deploys nothing from main.
. (Join-Path $PSScriptRoot 'common.ps1')
$Container = 'syveka-hotfix-build'
$Log = Join-Path $Dir 'stage1-build.log'
$Auth = Join-Path $env:APPDATA 'xdg.data\com.vercel.cli'

# Integrity of the reviewed inputs (hashes recorded by Claude after review).
$expect = @{ 'src.tar' = '12E6F3B575FF02C6028DD6DDC78A4D86A3914AAF049A7A616B00DDC86E91DA2D'; 'linux-build.sh' = 'BC05E5D16C737576909BF228625C1F64AA327BCFB453F6367695F0ECA03CB107' }
foreach ($f in $expect.Keys) {
    $h = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Dir $f)).Hash
    if ($h -ne $expect[$f]) { Stop-Recovery "$f does not match the reviewed hash" }
}
Write-Host 'inputs: src.tar and linux-build.sh match the reviewed hashes'

if (-not (Test-Path -LiteralPath (Join-Path $Auth 'auth.json'))) { Stop-Recovery "Vercel CLI is not logged in on this PC. In your own PowerShell run: npx -y $Cli login" }
$os = & cmd.exe /d /c "docker version --format {{.Server.Os}} 2>nul"
if ("$os".Trim() -ne 'linux') { Stop-Recovery 'Docker Desktop is not running Linux containers' }
& cmd.exe /d /c "docker image inspect node:22-bookworm >nul 2>&1"
if ($LASTEXITCODE -ne 0) { & cmd.exe /d /c "docker pull -q node:22-bookworm" }
Remove-Item -LiteralPath $StagedFile, $VerifiedFile -ErrorAction SilentlyContinue

$rc = 'n/a'
try {
    & cmd.exe /d /c "docker rm -f $Container >nul 2>&1"
    & cmd.exe /d /c "docker create --name $Container --memory 3500m -w /work node:22-bookworm bash /work/linux-build.sh >nul"
    if ($LASTEXITCODE -ne 0) { Stop-Recovery 'docker create failed' }
    & cmd.exe /d /c "docker cp `"$Dir\src.tar`" $($Container):/work/src.tar"
    & cmd.exe /d /c "docker cp `"$Dir\linux-build.sh`" $($Container):/work/linux-build.sh"
    & cmd.exe /d /c "docker cp `"$Auth`" $($Container):/work/vc"
    if ($LASTEXITCODE -ne 0) { Stop-Recovery 'could not copy the Vercel login into the container' }
    Write-Host 'building (about 5-10 minutes)...'
    & cmd.exe /d /c "docker start -a $Container 2>&1" | Tee-Object -FilePath $Log
    $rc = (& cmd.exe /d /c "docker inspect -f {{.State.ExitCode}} $Container").Trim()
}
finally {
    # Removes the container together with its copy of the Vercel login and the pulled production config.
    & cmd.exe /d /c "docker rm -f $Container >nul 2>&1"
    $left = & cmd.exe /d /c "docker ps -a -q --filter name=$Container"
    if ($left) { Write-Host "WARNING: container $Container still exists; run: docker rm -f $Container" -ForegroundColor Yellow } else { Write-Host 'cleanup: build container removed (login copy and pulled config deleted with it)' }
}
if ($rc -ne '0') { Stop-Recovery "build/stage failed (container exit code $rc); see the STOP line above" }
$m = Select-String -LiteralPath $Log -Pattern '^STAGED_URL=(https://\S+)$' | Select-Object -Last 1
if (-not $m) { Stop-Recovery 'no STAGED_URL in the build output' }
$url = $m.Matches[0].Groups[1].Value
if ($url -notmatch $UrlPattern) { Stop-Recovery "unexpected deployment URL $url" }
Set-Content -LiteralPath $StagedFile -Encoding ASCII -Value $url
Write-Host "STAGE 1 PASS: staged deployment $url (production alias NOT moved). Next: stage 2 (verify)." -ForegroundColor Green
