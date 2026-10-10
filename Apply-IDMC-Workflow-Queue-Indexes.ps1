[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$expectedProjectRef = 'ocvfpoxukbquzmapfqjx'
$expectedMigration = '20261005140000_workflow_queue_indexes.sql'
$projectRefPath = Join-Path $PSScriptRoot 'supabase/.temp/project-ref'

if (-not (Test-Path -LiteralPath $projectRefPath)) {
    throw 'Supabase project is not linked in this checkout. Link the staging project first.'
}

$linkedProjectRef = (Get-Content -LiteralPath $projectRefPath -Raw).Trim()
if ($linkedProjectRef -ne $expectedProjectRef) {
    throw "Safety stop: expected staging project $expectedProjectRef, found $linkedProjectRef."
}

$command = Get-Command supabase -ErrorAction SilentlyContinue
$cli = if ($command) { $command.Source } else { $null }
if (-not $cli) {
    $cli = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '.codex-npm-cache/_npx') -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'node_modules/.bin/supabase.cmd' } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
}
if (-not $cli) { throw 'Supabase CLI was not found. Install or expose the Supabase CLI, then retry.' }

$env:SUPABASE_TELEMETRY_DISABLED = '1'
Push-Location $PSScriptRoot
try {
    Write-Host "Linked staging project: $linkedProjectRef"
    $planLines = & $cli db push --dry-run --linked 2>&1
    $planExit = $LASTEXITCODE
    $plan = $planLines -join "`n"
    $planLines | ForEach-Object { Write-Host $_ }
    if ($planExit -ne 0) { throw "Migration dry-run failed (exit $planExit); no migration was pushed." }

    $matches = [regex]::Matches($plan, [regex]::Escape($expectedMigration))
    if ($matches.Count -ne 1) {
        throw "Dry-run did not show exactly the expected migration '$expectedMigration'; no migration was pushed. Review the output above."
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
