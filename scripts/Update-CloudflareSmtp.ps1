$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$workerName = 'idms-imis-worker'
$secretNames = @(
    'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_PASS', 'SMTP_FROM_EMAIL'
)

Set-Location -LiteralPath $projectRoot
Write-Host 'Wrangler will prompt for each secret value. Paste the matching value from apps\backend\.env when prompted.'
Write-Host 'Run this in your normal PowerShell window where Wrangler login is already active.'
Write-Host 'SMTP_HOST and SMTP_PORT were already uploaded. SMTP_SECURE already exists as a Worker binding, so it is intentionally skipped.'

foreach ($name in $secretNames) {
    Write-Host "`nUpdating $name (the value is entered privately by Wrangler)..."
    & npx wrangler secret put $name --name $workerName
    if ($LASTEXITCODE -ne 0) {
        throw "Wrangler could not update $name. No remaining SMTP settings were attempted."
    }
}

Write-Host "`nAll listed SMTP secrets were uploaded to Worker '$workerName'. Wrangler deploys each secret update immediately."
