# Shared constants and checks for the owner-run production HOTFIX 777eb1a (PR #363; stage1/2/3, rollback).
# Copied from the 2026-10-23 recovery kit (linux-recovery), which stays unchanged. Prints no secrets.
$ErrorActionPreference = 'Continue'
$env:VERCEL_TELEMETRY_DISABLED = '1'
$Sha = '777eb1a4c5f7c2d1eb59ce24f5ae4516944112d5'
# Rollback target: the deployment live before the hotfix (fc645727, built 2026-10-23 with the rotated DB credential).
# Never roll back to 9fjraopmr, qsc3ojpkl or anything older: those hold the revoked password.
$RollbackUrl = 'https://syveka-ai-production-lfhr9ra1w-syveka-ai.vercel.app'
$RollbackSha = 'fc645727cc8f0932f90c793667d8cfe3de0b35d3'
$PublicHealth = 'https://syveka.com/api/health', 'https://syveka-ai-production.vercel.app/api/health'
$Scope = 'syveka-ai'
$Cli = 'vercel@65.1.0'
$Dir = $PSScriptRoot
$StagedFile = Join-Path $Dir 'staged-url.txt'
$VerifiedFile = Join-Path $Dir 'verified.txt'
$UrlPattern = '^https://syveka-ai-production-[a-z0-9]+-syveka-ai\.vercel\.app$'

function Stop-Recovery([string]$Message) {
    Write-Host "STOP: $Message" -ForegroundColor Red
    Write-Host 'Nothing was promoted. Production alias unchanged. Send this output to Claude.'
    exit 1
}

function Get-StagedUrl {
    if (-not (Test-Path -LiteralPath $StagedFile)) { Stop-Recovery 'staged-url.txt not found; run stage 1 first' }
    $u = (Get-Content -LiteralPath $StagedFile -TotalCount 1).Trim()
    if ($u -notmatch $UrlPattern) { Stop-Recovery "staged-url.txt does not hold a syveka-ai-production deployment URL" }
    return $u
}

# Runs a Vercel CLI command with stderr merged, without PowerShell turning stderr into errors.
function Invoke-Vercel([string]$Arguments) {
    $out = & cmd.exe /d /c "npx -y $Cli $Arguments 2>&1"
    $script:VercelExit = $LASTEXITCODE
    return ($out | Where-Object { $_ -notmatch 'claude-code-hint' })
}

# Staged deployment record: must be Ready and target production (alias not assigned by us).
function Test-StagedRecord([string]$Url) {
    $ins = Invoke-Vercel "inspect $Url --scope $Scope"
    $status = ($ins | Select-String -Pattern '^\s*status\s+(.+)$' | Select-Object -First 1)
    $target = ($ins | Select-String -Pattern '^\s*target\s+(\S+)' | Select-Object -First 1)
    $s = if ($status) { $status.Matches[0].Groups[1].Value.Trim() } else { '?' }
    $t = if ($target) { $target.Matches[0].Groups[1].Value.Trim() } else { '?' }
    Write-Host "deployment record: status=$s target=$t"
    return ($s -match 'Ready' -and $t -eq 'production')
}

# Staged health through `vercel curl` (automatic Deployment Protection bypass; the bypass secret is never printed).
function Test-StagedHealth([string]$Url, [string]$ExpectSha = $Sha) {
    $linkDir = Join-Path $Dir 'link'
    New-Item -ItemType Directory -Force (Join-Path $linkDir '.vercel') | Out-Null
    Set-Content -LiteralPath (Join-Path $linkDir '.vercel\project.json') -Encoding ASCII -Value '{"projectId":"<REDACTED_VERCEL_PROJECT_ID>","orgId":"<REDACTED_VERCEL_ORG_ID>"}'
    Push-Location $linkDir
    try { $out = Invoke-Vercel "curl /api/health --deployment $Url --scope $Scope --yes" } finally { Pop-Location }
    $m = [regex]::Match(($out -join "`n"), '\{"status":.*?"build":"[^"]*"\}')
    if (-not $m.Success) { Write-Host 'health: no health JSON in response'; return $false }
    $j = $m.Value | ConvertFrom-Json
    Write-Host ("health: status={0} database={1} build={2}" -f $j.status, $j.checks.database, $j.build)
    return ($j.status -eq 'healthy' -and $j.checks.database -eq 'ok' -and $j.build -eq $ExpectSha)
}

# Which deployment syveka.com serves right now (read-only `vercel inspect` of the domain).
function Get-LiveDeploymentUrl {
    $ins = Invoke-Vercel "inspect syveka.com --scope $Scope"
    $m = ($ins | Select-String -Pattern '^\s*url\s+(https://\S+)' | Select-Object -First 1)
    if ($m) { return $m.Matches[0].Groups[1].Value.Trim() }
    return $null
}

function Test-PublicHealth([string]$Url, [string]$ExpectSha = $Sha) {
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 20 -Headers @{ 'Cache-Control' = 'no-cache' }
        $code = [int]$r.StatusCode; $body = $r.Content
    } catch {
        $code = 0; $body = ''
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode; $body = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() }
    }
    $j = $null; try { $j = $body | ConvertFrom-Json } catch {}
    $db = if ($j) { $j.checks.database } else { '?' }; $b = if ($j) { $j.build } else { '?' }; $st = if ($j) { $j.status } else { '?' }
    Write-Host ("{0} -> HTTP {1} status={2} database={3} build={4}" -f $Url, $code, $st, $db, $b)
    return ($code -eq 200 -and $st -eq 'healthy' -and $db -eq 'ok' -and $b -eq $ExpectSha)
}
