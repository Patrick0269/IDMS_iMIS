[CmdletBinding()]
param(
    [string]$ProjectPath = $PSScriptRoot,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path
$BackendPath = Join-Path $ProjectPath "apps\backend"
$FrontendPath = Join-Path $ProjectPath "apps\frontend"
$EnvironmentFile = Join-Path $BackendPath ".env"
$LogPath = Join-Path $ProjectPath "runtime-logs"

function Stop-IdmcPort {
    param([int]$Port)
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
        if ($connection.OwningProcess -and $connection.OwningProcess -ne $PID) {
            Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
}

function Test-EnvironmentKey {
    param([string]$Name)
    $pattern = "^\s*" + [regex]::Escape($Name) + "\s*=\s*(.+?)\s*$"
    $line = Get-Content -LiteralPath $EnvironmentFile | Where-Object { $_ -match $pattern } | Select-Object -Last 1
    if (-not $line) { return $false }
    $value = ($line -replace ("^\s*" + [regex]::Escape($Name) + "\s*=\s*"), "").Trim().Trim('"').Trim("'")
    return -not [string]::IsNullOrWhiteSpace($value)
}

function Test-UnauthenticatedApiRoute {
    param([Parameter(Mandatory)][ValidateSet("GET", "PUT", "POST")][string]$Method, [Parameter(Mandatory)][string]$Uri)
    $body = $null
    if ($Method -in @("PUT", "POST")) { $body = "{}" }
    try {
        $response = Invoke-WebRequest -Method $Method -Uri $Uri -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 5
        return [int]$response.StatusCode
    }
    catch {
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            return [int]$_.Exception.Response.StatusCode
        }
        return 0
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $BackendPath "package.json"))) { throw "Backend package.json was not found under $BackendPath" }
if (-not (Test-Path -LiteralPath (Join-Path $FrontendPath "server.mjs"))) { throw "Frontend server.mjs was not found under $FrontendPath" }
if (-not (Test-Path -LiteralPath $EnvironmentFile)) { throw "Backend .env was not found. Restore the existing apps\backend\.env file before startup." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is not installed or is not available in PATH." }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw "npm is not installed or is not available in PATH." }

$requiredKeys = @("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "JWT_SECRET", "SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM_EMAIL")
$missingKeys = @($requiredKeys | Where-Object { -not (Test-EnvironmentKey -Name $_) })
if ($missingKeys.Count -gt 0) { throw "Backend .env is missing required values: $($missingKeys -join ', ')" }

New-Item -ItemType Directory -Path $LogPath -Force | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackendLog = Join-Path $LogPath "backend-$stamp.log"
$FrontendLog = Join-Path $LogPath "frontend-$stamp.log"

Write-Host "Stopping old IDMC listeners on ports 4000 and 5500..." -ForegroundColor Yellow
Stop-IdmcPort -Port 4000
Stop-IdmcPort -Port 5500
Start-Sleep -Seconds 1

Push-Location $BackendPath
try {
    if (-not (Test-Path -LiteralPath (Join-Path $BackendPath "node_modules"))) {
        Write-Host "Installing backend dependencies..." -ForegroundColor Yellow
        & npm.cmd install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
    }
    Write-Host "Checking backend build before startup..." -ForegroundColor Cyan
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Backend build failed. Startup was stopped." }
}
finally { Pop-Location }

$backendEscaped = $BackendPath.Replace("'", "''")
$backendLogEscaped = $BackendLog.Replace("'", "''")
$backendCommand = "Set-Location -LiteralPath '$backendEscaped'; npm.cmd start 2>&1 | Tee-Object -FilePath '$backendLogEscaped'"
Write-Host "Starting backend and waiting for health check..." -ForegroundColor Cyan
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $backendCommand) | Out-Null

$backendReady = $false
for ($attempt = 1; $attempt -le 45; $attempt++) {
    Start-Sleep -Seconds 1
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:4000/api/v1/health" -TimeoutSec 2
        if ($health.success -eq $true) { $backendReady = $true; break }
    }
    catch { }
}
if (-not $backendReady) {
    Write-Host "Backend startup log: $BackendLog" -ForegroundColor Red
    if (Test-Path -LiteralPath $BackendLog) { Get-Content -LiteralPath $BackendLog -Tail 30 }
    throw "Backend did not become healthy on port 4000. Frontend startup was stopped. Fix the error shown above, then run this script again."
}

# This API requires authentication, so 401 proves the route is mounted.
# A 404 means an old/wrong backend build is answering despite passing /health.
$paymentSettingsUrl = "http://127.0.0.1:4000/api/v1/finance/workflow/payment-settings"
$getRouteStatus = Test-UnauthenticatedApiRoute -Method GET -Uri $paymentSettingsUrl
$putRouteStatus = Test-UnauthenticatedApiRoute -Method PUT -Uri $paymentSettingsUrl
if ($getRouteStatus -ne 401 -or $putRouteStatus -ne 401) {
    throw "Finance Payment Instructions route check failed (GET=$getRouteStatus, PUT=$putRouteStatus). The backend build or port 4000 target is wrong; frontend was not started. Confirm apps\backend\src\modules\finance\routes\finance-workflow.routes.ts contains both routes, then rebuild."
}
Write-Host "Finance Payment Instructions API routes verified (GET and PUT require authentication)." -ForegroundColor Green

# Empty input is expected to return 400 from the current public applicant-register handler.
# A 404 means a stale/wrong API process is still serving port 4000.
$applicantRegisterUrl = "http://127.0.0.1:4000/api/v1/auth/applicant-register"
$authHealthUrl = "http://127.0.0.1:4000/api/v1/auth/health"
$authHealthStatus = Test-UnauthenticatedApiRoute -Method GET -Uri $authHealthUrl
if ($authHealthStatus -ne 200) {
    Write-Host "Authentication module health check failed (GET=$authHealthStatus). Backend log: $BackendLog" -ForegroundColor Red
    if (Test-Path -LiteralPath $BackendLog) { Get-Content -LiteralPath $BackendLog -Tail 30 }
    throw "The running API does not expose the current authentication router on port 4000. Stop the stale API process and restart IDMC."
}
$applicantRegisterStatus = Test-UnauthenticatedApiRoute -Method POST -Uri $applicantRegisterUrl
if ($applicantRegisterStatus -ne 400) {
    Write-Host "Applicant registration API route check failed (POST=$applicantRegisterStatus). Backend log: $BackendLog" -ForegroundColor Red
    if (Test-Path -LiteralPath $BackendLog) { Get-Content -LiteralPath $BackendLog -Tail 30 }
    throw "The applicant portal needs the current backend build on port 4000. Review the backend log, then restart the current IDMC API."
}
Write-Host "Applicant registration API route verified (empty request returns validation status 400)." -ForegroundColor Green

$frontendEscaped = $FrontendPath.Replace("'", "''")
$frontendLogEscaped = $FrontendLog.Replace("'", "''")
$frontendCommand = "Set-Location -LiteralPath '$frontendEscaped'; node server.mjs --root . --host 127.0.0.1 --port 5500 2>&1 | Tee-Object -FilePath '$frontendLogEscaped'"
Write-Host "Backend is healthy. Starting frontend..." -ForegroundColor Green
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $frontendCommand) | Out-Null

$frontendReady = $false
for ($attempt = 1; $attempt -le 30; $attempt++) {
    Start-Sleep -Seconds 1
    try {
        $page = Invoke-WebRequest -Uri "http://127.0.0.1:5500/" -UseBasicParsing -TimeoutSec 2
        if ($page.StatusCode -eq 200 -and $page.Content -match 'siteHeroTitle') { $frontendReady = $true; break }
    }
    catch { }
}
if (-not $frontendReady) {
    Write-Host "Frontend startup log: $FrontendLog" -ForegroundColor Red
    if (Test-Path -LiteralPath $FrontendLog) { Get-Content -LiteralPath $FrontendLog -Tail 30 }
    throw "Frontend did not become healthy on port 5500."
}

Write-Host ""; Write-Host "IDMC iMIS is ready." -ForegroundColor Green
Write-Host "Backend : http://127.0.0.1:4000/api/v1/health"
Write-Host "Homepage: http://127.0.0.1:5500/"
Write-Host "Login   : http://127.0.0.1:5500/login/"
Write-Host "Applicant: http://127.0.0.1:5500/applicant-access.html"
Write-Host "Admissions: http://127.0.0.1:5500/admissions.html"
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:5500/" }
