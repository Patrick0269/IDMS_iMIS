[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$expectedProjectRef = 'ocvfpoxukbquzmapfqjx'
$expectedMigration = '20261005150000_leadership_dashboard_month_bounds.sql'
$projectRefPath = Join-Path $PSScriptRoot 'supabase/.temp/project-ref'
if (-not (Test-Path -LiteralPath $projectRefPath)) { throw 'Supabase project is not linked in this checkout.' }
$linkedProjectRef = (Get-Content -LiteralPath $projectRefPath -Raw).Trim()
if ($linkedProjectRef -ne $expectedProjectRef) { throw "Safety stop: expected staging project $expectedProjectRef, found $linkedProjectRef." }

$command = Get-Command supabase -ErrorAction SilentlyContinue
$cli = if ($command) { $command.Source } else { $null }
if (-not $cli) {
    $cli = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '.codex-npm-cache/_npx') -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'node_modules/.bin/supabase.cmd' } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
}
if (-not $cli) { throw 'Supabase CLI was not found.' }

$env:SUPABASE_TELEMETRY_DISABLED = '1'
Push-Location $PSScriptRoot
try {
    Write-Host "Linked staging project: $linkedProjectRef"
    $planLines = & $cli db push --dry-run --linked 2>&1
    $planExit = $LASTEXITCODE
    $plan = $planLines -join "`n"
    $planLines | ForEach-Object { Write-Host $_ }
    if ($planExit -ne 0) { throw "Migration dry-run failed (exit $planExit); nothing was pushed." }
    if ([regex]::Matches($plan, [regex]::Escape($expectedMigration)).Count -ne 1) {
        throw "Dry-run did not show exactly '$expectedMigration'; nothing was pushed. Review the output above."
    }

    Write-Host "Dry-run confirmed exactly one migration: $expectedMigration"
    & $cli db push --linked
    $pushExit = $LASTEXITCODE
    if ($pushExit -ne 0) { throw "Migration push failed (exit $pushExit)." }
    Write-Host "Applied $expectedMigration to staging project $linkedProjectRef."
}
finally {
    Pop-Location
}
