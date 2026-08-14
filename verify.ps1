#requires -Version 7.0

param(
    [int]$Pr = 0,
    [switch]$Isolated,
    [Parameter(DontShow = $true)][string]$BoundTargetSha = '',
    [Parameter(DontShow = $true)][ValidateSet('', 'pr', 'main')][string]$BoundTargetKind = '',
    [Parameter(DontShow = $true)][string]$ReportRoot = '',
    [Parameter(DontShow = $true)][ValidateSet('', 'normal', 'isolated')][string]$BoundMode = ''
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

function Get-ScriptRepositoryRoot {
    $scriptDir = Split-Path -Parent $PSCommandPath
    return Invoke-Git -CommandArgs @('-C', $scriptDir, 'rev-parse', '--show-toplevel')
}

function Assert-CanonicalVerifierPath {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)

    $expected = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot 'verify.ps1'))
    $actual = [System.IO.Path]::GetFullPath($PSCommandPath)
    if ($actual -ne $expected) {
        throw "Verifier must execute from the selected repository's canonical verify.ps1: $expected"
    }
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

function Get-HumanVerificationHandoff {
    param([Parameter(Mandatory = $true)][string]$Body)

    $headingPattern = '(?m)^## Human verification required[ \t]*\r?$'
    $headings = [regex]::Matches($Body, $headingPattern)

    if ($headings.Count -eq 0) {
        return [pscustomobject]@{
            State = 'INVALID'
            Content = 'Missing required `## Human verification required` section.'
        }
    }

    if ($headings.Count -gt 1) {
        return [pscustomobject]@{
            State = 'INVALID'
            Content = 'Ambiguous handoff: `## Human verification required` appears more than once.'
        }
    }

    $heading = $headings[0]
    $tail = $Body.Substring($heading.Index + $heading.Length)
    $nextHeading = [regex]::Match($tail, '(?m)^## [^\r\n]+[ \t]*\r?$')
    $section = if ($nextHeading.Success) { $tail.Substring(0, $nextHeading.Index) } else { $tail }
    $content = $section.Trim()

    if (-not $content) {
        return [pscustomobject]@{
            State = 'INVALID'
            Content = 'Invalid handoff: `## Human verification required` is empty.'
        }
    }

    if ($content -ceq 'None') {
        return [pscustomobject]@{
            State = 'None'
            Content = 'None'
        }
    }

    if ([regex]::IsMatch($content, '(?im)^[ \t]*none[ \t]*\r?$')) {
        return [pscustomobject]@{
            State = 'INVALID'
            Content = 'Ambiguous handoff: `None` must be the entire section and use the canonical spelling `None`.'
        }
    }

    return [pscustomobject]@{
        State = 'Declared'
        Content = $content
    }
}

function Get-GitHubTarget {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [int]$RequestedPr = 0,
        [ValidateSet('', 'pr', 'main')][string]$ExpectedKind = '',
        [string]$ExpectedSha = ''
    )

    Push-Location $RepoRoot
    try {
        $repoInfo = (Invoke-Gh -CommandArgs @('repo', 'view', '--json', 'nameWithOwner,defaultBranchRef')) | ConvertFrom-Json
        $defaultBranch = $repoInfo.defaultBranchRef.name
        if (-not $defaultBranch) {
            throw 'Could not resolve the repository default branch from GitHub.'
        }

        $selectedPr = $null
        if ($ExpectedKind -eq 'pr') {
            if ($RequestedPr -le 0) {
                throw 'Target-bound PR verification requires the selected PR number.'
            }
            $selectedPr = $RequestedPr
        }
        elseif ($ExpectedKind -eq 'main') {
            if ($RequestedPr -gt 0) {
                throw 'Target-bound default-branch verification cannot include a PR number.'
            }
        }
        elseif ($RequestedPr -gt 0) {
            $selectedPr = $RequestedPr
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
        }
        else {
            $targetKind = 'main'
            $targetLabel = $defaultBranch
            $prBody = $null
            Invoke-Git -CommandArgs @('fetch', 'origin', $defaultBranch) | Out-Null
            $targetSha = Invoke-Git -CommandArgs @('rev-parse', "origin/$defaultBranch")
        }

        if ($ExpectedKind -and $targetKind -ne $ExpectedKind) {
            throw "Selected target kind changed from $ExpectedKind to $targetKind."
        }
        if ($ExpectedSha -and $targetSha -ne $ExpectedSha) {
            throw "Selected GitHub target moved from $ExpectedSha to $targetSha before checks began."
        }

        return [pscustomobject]@{
            Kind = $targetKind
            Label = $targetLabel
            Sha = $targetSha
            SelectedPr = $selectedPr
            DefaultBranch = $defaultBranch
            PrBody = $prBody
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-RepositoryChecks {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$TargetSha,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[string]]$Checks
    )

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
        $Checks.Add('Required Agent-Workflow files are present.')

        $baseline = Get-Content -LiteralPath 'docs/ai/BASELINE'
        $source = $baseline | Where-Object { $_ -like 'source=*' } | Select-Object -First 1
        $commit = $baseline | Where-Object { $_ -like 'commit=*' } | Select-Object -First 1
        if ($source -ne 'source=https://github.com/Defirion/Agent-Workflow') {
            throw 'docs/ai/BASELINE has an unexpected or missing source marker.'
        }
        if (-not $commit -or ($commit.Substring(7) -notmatch '^[0-9a-fA-F]{40}$')) {
            throw 'docs/ai/BASELINE must contain commit=<full 40-character SHA>.'
        }
        $Checks.Add('Agent-Workflow baseline provenance marker is well formed.')

        $productRequired = @(
            'package.json',
            'GAME-CONTRACT.md',
            'docs/ARCHITECTURE.md',
            'docs/PLAN.md',
            'src/registry.js',
            'src/runtime/private-ports.js',
            'src/server.js',
            'public/index.html',
            'public/app.js',
            'public/styles.css',
            'scripts/verify-product.mjs',
            'test/private-ports.test.js',
            'test/registry.test.js',
            'test/server.test.js',
            'test/verification-contract.test.js'
        )
        foreach ($file in $productRequired) {
            if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
                throw "Required product file is missing: $file"
            }
        }
        $Checks.Add('Required product files are present.')

        if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
            throw 'Node.js 22 or newer is required for product verification.'
        }

        $nodeText = Invoke-External -Command 'node' -CommandArgs @('--version')
        $nodeVersionText = $nodeText -replace '^v', ''
        $nodeVersion = $null
        if (-not [version]::TryParse($nodeVersionText, [ref]$nodeVersion) -or $nodeVersion.Major -lt 22) {
            throw "Node.js 22 or newer is required; found $nodeText."
        }
        $Checks.Add("Node.js runtime satisfies the product requirement ($nodeText).")

        Invoke-External -Command 'node' -CommandArgs @('scripts/verify-product.mjs', '--canonical-target', $TargetSha) | Out-Null
        $Checks.Add('Product syntax checks and tests passed (`node scripts/verify-product.mjs --canonical-target <SHA>`).')
    }
    finally {
        Pop-Location
    }
}

function Write-VerificationReport {
    param(
        [Parameter(Mandatory = $true)][string]$ReportRoot,
        [Parameter(Mandatory = $true)][string]$TargetLabel,
        [Parameter(Mandatory = $true)][string]$TargetSha,
        [Parameter(Mandatory = $true)][string]$Mode,
        [Parameter(Mandatory = $true)][string]$PowerShellVersion,
        [Parameter(Mandatory = $true)][string]$Outcome,
        [Parameter(Mandatory = $true)][string]$Freshness,
        [Parameter(Mandatory = $true)][string]$FinalTrackedState,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[string]]$Checks,
        [string]$Failure = '',
        [Parameter(Mandatory = $true)][string]$HumanVerification,
        [Parameter(Mandatory = $true)][string]$HumanState,
        [Parameter(Mandatory = $true)][string]$TargetKind
    )

    $timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssZ')
    $shortSha = $TargetSha.Substring(0, 12)
    $reportDir = Join-Path $ReportRoot '.local/pr-verification'
    New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
    $reportPath = Join-Path $reportDir ("$stamp-$shortSha.md")
    $latestPath = Join-Path $reportDir 'latest.md'

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('# Local verification report')
    $lines.Add('')
    $lines.Add("- Target: $TargetLabel")
    $lines.Add("- Tested SHA: $TargetSha")
    $lines.Add("- Verifier source SHA: $TargetSha")
    $lines.Add("- Mode: $Mode")
    $lines.Add("- PowerShell: $PowerShellVersion")
    $lines.Add("- Timestamp: $timestamp")
    $lines.Add("- Automated outcome: $Outcome")
    $lines.Add("- Target freshness: $Freshness")
    $lines.Add("- Final tracked/staged state: $FinalTrackedState")
    $lines.Add('')
    $lines.Add('## Automated checks')
    $lines.Add('')
    if ($Checks.Count -eq 0) {
        $lines.Add('- None completed.')
    }
    else {
        foreach ($check in $Checks) {
            $lines.Add("- PASS - $check")
        }
    }
    if ($Failure) {
        $lines.Add('')
        $lines.Add('## Failure / limitation')
        $lines.Add('')
        $lines.Add('```text')
        $lines.Add($Failure)
        $lines.Add('```')
    }
    $lines.Add('')
    $lines.Add('## Human verification required')
    $lines.Add('')
    $lines.Add($HumanVerification)
    $lines.Add('')
    $lines.Add('## Handoff')
    $lines.Add('')
    if ($Outcome -eq 'PASS' -and $TargetKind -eq 'pr' -and $HumanState -eq 'None') {
        $lines.Add('Automated gate complete for the exact fresh PR SHA. Human verification is `None`; the PR is ready for independent Review.')
    }
    elseif ($Outcome -eq 'PASS' -and $TargetKind -eq 'pr' -and $HumanState -eq 'INVALID') {
        $lines.Add('Automated gate complete, but the PR handoff is invalid. Correct `## Human verification required` before Review.')
    }
    elseif ($Outcome -eq 'PASS' -and $TargetKind -eq 'pr') {
        $lines.Add('Automated gate complete. Declared human verification remains a separate gate before merge readiness.')
    }
    elseif ($Outcome -eq 'PASS') {
        $lines.Add('Default-branch automated gate complete for the exact fresh SHA.')
    }
    elseif ($Outcome -eq 'STALE') {
        $lines.Add('Target moved during verification. This evidence is stale and must not be used.')
    }
    else {
        $lines.Add('Automated gate failed. Fix the reported issue and verify the resulting new SHA.')
    }

    $lines | Set-Content -LiteralPath $reportPath -Encoding UTF8
    Copy-Item -LiteralPath $reportPath -Destination $latestPath -Force
    return $latestPath
}

function Invoke-BoundVerification {
    if (-not $BoundTargetSha -or $BoundTargetSha -notmatch '^[0-9a-fA-F]{40}$') {
        throw 'Target-bound verification requires -BoundTargetSha with a full 40-character SHA.'
    }
    if (-not $BoundTargetKind) {
        throw 'Target-bound verification requires -BoundTargetKind.'
    }
    if (-not $BoundMode) {
        throw 'Target-bound verification requires -BoundMode.'
    }
    if (-not $ReportRoot) {
        throw 'Target-bound verification requires -ReportRoot.'
    }

    $repoRoot = Get-ScriptRepositoryRoot
    Set-Location $repoRoot
    Assert-CanonicalVerifierPath -RepoRoot $repoRoot

    $checkedOutSha = Invoke-Git -CommandArgs @('rev-parse', 'HEAD')
    if ($checkedOutSha -ne $BoundTargetSha) {
        throw "Target-bound verifier checkout is $checkedOutSha, expected $BoundTargetSha."
    }
    Assert-CleanTrackedState -Path $repoRoot

    $target = Get-GitHubTarget -RepoRoot $repoRoot -RequestedPr $Pr -ExpectedKind $BoundTargetKind -ExpectedSha $BoundTargetSha
    $humanVerification = 'Not applicable for default-branch verification.'
    $humanState = 'N/A'
    if ($target.Kind -eq 'pr') {
        $humanHandoff = Get-HumanVerificationHandoff -Body $target.PrBody
        $humanState = $humanHandoff.State
        $humanVerification = $humanHandoff.Content
    }

    $checks = New-Object System.Collections.Generic.List[string]
    $checks.Add("Verifier logic loaded from tested target SHA ($BoundTargetSha).")
    $failure = $null
    $freshness = 'NOT CHECKED'
    $finalTrackedState = 'NOT CHECKED'

    try {
        Invoke-RepositoryChecks -Path $repoRoot -TargetSha $BoundTargetSha -Checks $checks

        Push-Location $repoRoot
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
        if ($target.Kind -eq 'pr') {
            $current = (Invoke-Gh -CommandArgs @('pr', 'view', "$($target.SelectedPr)", '--json', 'headRefOid,state')) | ConvertFrom-Json
            if ($current.state -eq 'OPEN' -and $current.headRefOid -eq $BoundTargetSha) {
                $freshness = 'FRESH'
            }
            else {
                $freshness = 'STALE'
            }
        }
        else {
            Invoke-Git -CommandArgs @('fetch', 'origin', $target.DefaultBranch) | Out-Null
            $currentSha = Invoke-Git -CommandArgs @('rev-parse', "origin/$($target.DefaultBranch)")
            if ($currentSha -eq $BoundTargetSha) {
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

    $powerShellVersion = $PSVersionTable.PSVersion.ToString()
    $latestPath = Write-VerificationReport -ReportRoot ([System.IO.Path]::GetFullPath($ReportRoot)) -TargetLabel $target.Label -TargetSha $BoundTargetSha -Mode $BoundMode -PowerShellVersion $powerShellVersion -Outcome $outcome -Freshness $freshness -FinalTrackedState $finalTrackedState -Checks $checks -Failure $failure -HumanVerification $humanVerification -HumanState $humanState -TargetKind $target.Kind

    Write-Host "Verification: $outcome"
    Write-Host "Target: $($target.Label) @ $BoundTargetSha"
    Write-Host "Verifier source: $BoundTargetSha"
    Write-Host "PowerShell: $powerShellVersion"
    Write-Host "Report: $latestPath"

    if ($outcome -eq 'FAIL') { return 1 }
    if ($outcome -eq 'STALE') { return 2 }
    if ($target.Kind -eq 'pr' -and $humanState -eq 'INVALID') { return 3 }
    return 0
}

function Invoke-Bootstrap {
    $repoRoot = Get-ScriptRepositoryRoot
    Set-Location $repoRoot
    Assert-CanonicalVerifierPath -RepoRoot $repoRoot
    Assert-CleanTrackedState -Path $repoRoot

    $target = Get-GitHubTarget -RepoRoot $repoRoot -RequestedPr $Pr
    $mode = if ($Isolated) { 'isolated' } else { 'normal' }
    $verificationRoot = $repoRoot
    $tempWorktree = $null

    try {
        if ($Isolated) {
            $tempWorktree = Join-Path ([System.IO.Path]::GetTempPath()) ("tabletop-nexus-verify-" + [guid]::NewGuid().ToString('N'))
            Invoke-Git -CommandArgs @('worktree', 'add', '--detach', $tempWorktree, $target.Sha) | Out-Null
            $verificationRoot = $tempWorktree
        }
        elseif ($target.Kind -eq 'main') {
            Invoke-Git -CommandArgs @('checkout', '--no-overwrite-ignore', $target.DefaultBranch) | Out-Null
            Invoke-Git -CommandArgs @('merge', '--ff-only', '--no-overwrite-ignore', "origin/$($target.DefaultBranch)") | Out-Null
        }
        else {
            Invoke-Git -CommandArgs @('checkout', '--no-overwrite-ignore', '--detach', $target.Sha) | Out-Null
        }

        Push-Location $verificationRoot
        try {
            $checkedOutSha = Invoke-Git -CommandArgs @('rev-parse', 'HEAD')
        }
        finally {
            Pop-Location
        }
        if ($checkedOutSha -ne $target.Sha) {
            throw "Verification checkout is $checkedOutSha, expected $($target.Sha)."
        }
        Assert-CleanTrackedState -Path $verificationRoot

        $targetVerifier = Join-Path $verificationRoot 'verify.ps1'
        if (-not (Test-Path -LiteralPath $targetVerifier -PathType Leaf)) {
            throw "Selected target is missing canonical verifier: $targetVerifier"
        }

        $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
        $boundPr = if ($target.SelectedPr) { [int]$target.SelectedPr } else { 0 }
        & $pwsh -NoProfile -File $targetVerifier -Pr $boundPr -BoundTargetSha $target.Sha -BoundTargetKind $target.Kind -ReportRoot $repoRoot -BoundMode $mode
        return $LASTEXITCODE
    }
    finally {
        if ($tempWorktree) {
            Set-Location $repoRoot
            try {
                Invoke-Git -CommandArgs @('worktree', 'remove', '--force', $tempWorktree) | Out-Null
            }
            catch {
                Write-Warning "Could not remove temporary verification worktree: $($_.Exception.Message)"
            }
        }
    }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'git is required.'
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'GitHub CLI (gh) is required.'
}

if ($BoundTargetSha) {
    exit (Invoke-BoundVerification)
}
exit (Invoke-Bootstrap)
