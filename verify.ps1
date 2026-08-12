#requires -Version 7.0

param(
    [int]$Pr = 0,
    [switch]$Isolated
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-External {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$CommandArgs
    )

    # Native tools may write ordinary progress to stderr even when they succeed.
    # Capture both streams without promoting stderr text itself to a verifier
    # failure; the native process exit code is authoritative.
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & $Command @CommandArgs 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    $text = ($output | ForEach-Object { "$_" }) -join "`n"
    if ($exitCode -ne 0) {
        throw "$Command $($CommandArgs -join ' ') failed with exit code $exitCode`n$text"
    }
    return $text.Trim()
}

function Invoke-Git {
    param([Parameter(Mandatory = $true)][string[]]$CommandArgs)
    return Invoke-External -Command 'git' -CommandArgs $CommandArgs
}

function Invoke-Gh {
    param([Parameter(Mandatory = $true)][string[]]$CommandArgs)
    return Invoke-External -Command 'gh' -CommandArgs $CommandArgs
}

function Assert-CleanTrackedState {
    param([Parameter(Mandatory = $true)][string]$Path)
    Push-Location $Path
    try {
        $status = Invoke-Git -CommandArgs @('status', '--porcelain', '--untracked-files=no')
        if ($status) {
            throw "Tracked or staged changes are present. Verification requires a clean tracked worktree:`n$status"
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-RepositoryChecks {
    param([Parameter(Mandatory = $true)][string]$Path)

    $checks = New-Object System.Collections.Generic.List[string]
    Push-Location $Path
    try {
        $required = @(
            'AGENTS.md',
            'VERIFICATION.md',
            'verify.ps1',
            'docs/ai/IMPLEMENTER.md',
            'docs/ai/VERIFIER.md',
            'docs/ai/REVIEWER.md',
            'docs/ai/BASELINE'
        )

        foreach ($file in $required) {
            if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
                throw "Required workflow file is missing: $file"
            }
        }
        $checks.Add('Required Agent-Workflow files are present.')

        $baseline = Get-Content -LiteralPath 'docs/ai/BASELINE'
        $source = $baseline | Where-Object { $_ -like 'source=*' } | Select-Object -First 1
        $commit = $baseline | Where-Object { $_ -like 'commit=*' } | Select-Object -First 1
        if ($source -ne 'source=https://github.com/Defirion/Agent-Workflow') {
            throw 'docs/ai/BASELINE has an unexpected or missing source marker.'
        }
        if (-not $commit -or ($commit.Substring(7) -notmatch '^[0-9a-fA-F]{40}$')) {
            throw 'docs/ai/BASELINE must contain commit=<full 40-character SHA>.'
        }
        $checks.Add('Agent-Workflow baseline provenance marker is well formed.')

        # Product checks belong here once application tooling exists. Preserve the
        # verifier interface and evidence contract when extending this gate.
    }
    finally {
        Pop-Location
    }

    return $checks
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'git is required.'
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'GitHub CLI (gh) is required.'
}

$powerShellVersion = $PSVersionTable.PSVersion.ToString()
$repoRoot = Invoke-Git -CommandArgs @('rev-parse', '--show-toplevel')
Set-Location $repoRoot
Assert-CleanTrackedState -Path $repoRoot

$repoInfo = (Invoke-Gh -CommandArgs @('repo', 'view', '--json', 'nameWithOwner,defaultBranchRef')) | ConvertFrom-Json
$defaultBranch = $repoInfo.defaultBranchRef.name
if (-not $defaultBranch) {
    throw 'Could not resolve the repository default branch from GitHub.'
}

$targetKind = $null
$targetLabel = $null
$targetSha = $null
$humanVerification = 'Not applicable for default-branch verification.'
$humanState = 'N/A'
$selectedPr = $null
$prBody = $null

if ($Pr -gt 0) {
    $selectedPr = $Pr
}
else {
    $openPrs = @((Invoke-Gh -CommandArgs @('pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,headRefOid')) | ConvertFrom-Json)
    if ($openPrs.Count -eq 1) {
        $selectedPr = [int]$openPrs[0].number
    }
    elseif ($openPrs.Count -gt 1) {
        Write-Host 'Several open PRs exist:'
        foreach ($item in $openPrs) {
            Write-Host ("  #{0} {1}" -f $item.number, $item.title)
        }
        $choice = Read-Host 'PR number to verify'
        $parsed = 0
        if (-not [int]::TryParse($choice, [ref]$parsed) -or $parsed -le 0) {
            throw 'A valid PR number is required.'
        }
        $selectedPr = $parsed
    }
}

if ($selectedPr) {
    $prInfo = (Invoke-Gh -CommandArgs @('pr', 'view', "$selectedPr", '--json', 'number,state,headRefOid,body')) | ConvertFrom-Json
    if ($prInfo.state -ne 'OPEN') {
        throw "PR #$selectedPr is not open."
    }

    $targetKind = 'pr'
    $targetLabel = "PR #$selectedPr"
    $targetSha = $prInfo.headRefOid
    $prBody = [string]$prInfo.body

    Invoke-Git -CommandArgs @('fetch', 'origin', "pull/$selectedPr/head") | Out-Null
    $fetchedSha = Invoke-Git -CommandArgs @('rev-parse', 'FETCH_HEAD')
    if ($fetchedSha -ne $targetSha) {
        throw "Fetched PR head $fetchedSha does not match GitHub head $targetSha."
    }

    $match = [regex]::Match($prBody, '(?ms)^## Human verification required\s*\r?\n(?<content>.*?)(?=^## |\z)')
    if (-not $match.Success) {
        $humanState = 'MISSING'
        $humanVerification = 'Missing required `## Human verification required` section.'
    }
    else {
        $humanVerification = $match.Groups['content'].Value.Trim()
        if ($humanVerification -eq 'None') {
            $humanState = 'None'
        }
        else {
            $humanState = 'Declared'
        }
    }
}
else {
    $targetKind = 'main'
    $targetLabel = $defaultBranch
    Invoke-Git -CommandArgs @('fetch', 'origin', $defaultBranch) | Out-Null
    $targetSha = Invoke-Git -CommandArgs @('rev-parse', "origin/$defaultBranch")
}

$mode = if ($Isolated) { 'isolated' } else { 'normal' }
$verificationRoot = $repoRoot
$tempWorktree = $null
$checks = New-Object System.Collections.Generic.List[string]
$failure = $null
$freshness = 'NOT CHECKED'
$finalTrackedState = 'NOT CHECKED'

try {
    if ($Isolated) {
        $tempWorktree = Join-Path ([System.IO.Path]::GetTempPath()) ("tabletop-nexus-verify-" + [guid]::NewGuid().ToString('N'))
        Invoke-Git -CommandArgs @('worktree', 'add', '--detach', $tempWorktree, $targetSha) | Out-Null
        $verificationRoot = $tempWorktree
    }
    elseif ($targetKind -eq 'main') {
        Invoke-Git -CommandArgs @('checkout', $defaultBranch) | Out-Null
        Invoke-Git -CommandArgs @('merge', '--ff-only', "origin/$defaultBranch") | Out-Null
        $checkedOutSha = Invoke-Git -CommandArgs @('rev-parse', 'HEAD')
        if ($checkedOutSha -ne $targetSha) {
            throw "Default-branch checkout is $checkedOutSha, expected $targetSha."
        }
    }
    else {
        Invoke-Git -CommandArgs @('checkout', '--detach', $targetSha) | Out-Null
    }

    Assert-CleanTrackedState -Path $verificationRoot
    foreach ($check in (Invoke-RepositoryChecks -Path $verificationRoot)) {
        $checks.Add($check)
    }

    Push-Location $verificationRoot
    try {
        $tracked = Invoke-Git -CommandArgs @('status', '--porcelain', '--untracked-files=no')
        if ($tracked) {
            $finalTrackedState = $tracked
            throw "Verification left tracked/staged changes:`n$tracked"
        }
        $finalTrackedState = 'clean'
    }
    finally {
        Pop-Location
    }
}
catch {
    $failure = $_.Exception.Message
}

try {
    if ($targetKind -eq 'pr') {
        $current = (Invoke-Gh -CommandArgs @('pr', 'view', "$selectedPr", '--json', 'headRefOid,state')) | ConvertFrom-Json
        if ($current.state -eq 'OPEN' -and $current.headRefOid -eq $targetSha) {
            $freshness = 'FRESH'
        }
        else {
            $freshness = 'STALE'
        }
    }
    else {
        Invoke-Git -CommandArgs @('fetch', 'origin', $defaultBranch) | Out-Null
        $currentSha = Invoke-Git -CommandArgs @('rev-parse', "origin/$defaultBranch")
        if ($currentSha -eq $targetSha) {
            $freshness = 'FRESH'
        }
        else {
            $freshness = 'STALE'
        }
    }
}
catch {
    if (-not $failure) {
        $failure = "Could not recheck GitHub target freshness: $($_.Exception.Message)"
    }
}

$outcome = 'PASS'
if ($failure) {
    $outcome = 'FAIL'
}
elseif ($freshness -ne 'FRESH') {
    $outcome = 'STALE'
}

$timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssZ')
$shortSha = if ($targetSha) { $targetSha.Substring(0, 12) } else { 'unknown' }
$reportDir = Join-Path $repoRoot '.local/pr-verification'
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
$reportPath = Join-Path $reportDir ("$stamp-$shortSha.md")
$latestPath = Join-Path $reportDir 'latest.md'

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# Local verification report')
$lines.Add('')
$lines.Add("- Target: $targetLabel")
$lines.Add(('- SHA: `{0}`' -f $targetSha))
$lines.Add("- Mode: $mode")
$lines.Add("- PowerShell: $powerShellVersion")
$lines.Add("- Timestamp: $timestamp")
$lines.Add("- Automated outcome: **$outcome**")
$lines.Add("- Target freshness: $freshness")
$lines.Add("- Final tracked/staged state: $finalTrackedState")
$lines.Add('')
$lines.Add('## Automated checks')
$lines.Add('')
if ($checks.Count -eq 0) {
    $lines.Add('- None completed.')
}
else {
    foreach ($check in $checks) {
        $lines.Add("- PASS - $check")
    }
}
if ($failure) {
    $lines.Add('')
    $lines.Add('## Failure / limitation')
    $lines.Add('')
    $lines.Add('```text')
    $lines.Add($failure)
    $lines.Add('```')
}
$lines.Add('')
$lines.Add('## Human verification required')
$lines.Add('')
$lines.Add($humanVerification)
$lines.Add('')
$lines.Add('## Handoff')
$lines.Add('')
if ($outcome -eq 'PASS' -and $targetKind -eq 'pr' -and $humanState -eq 'None') {
    $lines.Add('Automated gate complete for the exact fresh PR SHA. Human verification is `None`; the PR is ready for independent Review.')
}
elseif ($outcome -eq 'PASS' -and $targetKind -eq 'pr' -and $humanState -eq 'MISSING') {
    $lines.Add('Automated gate complete, but the PR handoff is incomplete because the required human-verification section is missing.')
}
elseif ($outcome -eq 'PASS' -and $targetKind -eq 'pr') {
    $lines.Add('Automated gate complete. Declared human verification remains a separate gate before merge readiness.')
}
elseif ($outcome -eq 'PASS') {
    $lines.Add('Default-branch automated gate complete for the exact fresh SHA.')
}
elseif ($outcome -eq 'STALE') {
    $lines.Add('Target moved during verification. This evidence is stale and must not be used.')
}
else {
    $lines.Add('Automated gate failed. Fix the reported issue and verify the resulting new SHA.')
}

$lines | Set-Content -LiteralPath $reportPath -Encoding UTF8
Copy-Item -LiteralPath $reportPath -Destination $latestPath -Force

if ($tempWorktree) {
    Set-Location $repoRoot
    try {
        Invoke-Git -CommandArgs @('worktree', 'remove', '--force', $tempWorktree) | Out-Null
    }
    catch {
        Write-Warning "Could not remove temporary verification worktree: $($_.Exception.Message)"
    }
}

Write-Host "Verification: $outcome"
Write-Host "Target: $targetLabel @ $targetSha"
Write-Host "PowerShell: $powerShellVersion"
Write-Host "Report: $latestPath"

if ($outcome -eq 'FAIL') { exit 1 }
if ($outcome -eq 'STALE') { exit 2 }
if ($targetKind -eq 'pr' -and $humanState -eq 'MISSING') { exit 3 }
exit 0
