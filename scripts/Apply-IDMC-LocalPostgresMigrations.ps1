[CmdletBinding()]
param(
    [string]$HostName = 'localhost',
    [int]$Port = 5433,
    [string]$User = 'postgres',
    [string]$Database = 'idmc_imis_recovered_20261004',
    [string]$BaselineVersion = '20261004130004'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$pgBin = 'C:\Program Files\PostgreSQL\18\bin'
$psql = Join-Path $pgBin 'psql.exe'
$pgIsReady = Join-Path $pgBin 'pg_isready.exe'
$migrationPaths = @(
    (Join-Path $repo 'supabase\migrations'),
    (Join-Path $repo 'database\migrations')
)
$providedPassword = $false

function Invoke-LocalPsql {
    param([string[]]$Arguments)
    & $psql @Arguments
    if ($LASTEXITCODE -ne 0) { throw "psql imeshindwa (exit $LASTEXITCODE). Database haikubadilishwa na migration iliyo-feli." }
}

try {
    if ($Database -notmatch '^[a-zA-Z_][a-zA-Z0-9_]{0,62}$') { throw 'Jina la database si salama.' }
    foreach ($file in @($psql, $pgIsReady)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "PostgreSQL command haipo: $file" }
    }
    foreach ($path in $migrationPaths) {
        if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw "Folda ya migrations haipo: $path" }
    }

    & $pgIsReady -h $HostName -p $Port
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL haipokei muunganisho kwenye ${HostName}:$Port." }

    $passwordFile = $env:PGPASSFILE
    if (-not $passwordFile) { $passwordFile = Join-Path $env:APPDATA 'postgresql\pgpass.conf' }
    if (-not $env:PGPASSWORD -and -not (Test-Path -LiteralPath $passwordFile)) {
        $securePassword = Read-Host "Weka password ya local PostgreSQL user '$User' (itaonekana imefichwa)" -AsSecureString
        $passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
        try {
            $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
            $providedPassword = $true
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
            $securePassword.Dispose()
        }
    }

    $versionSql = "SELECT current_setting('server_version_num');"
    $serverVersion = (& $psql -X -h $HostName -p $Port -U $User -d $Database -w -At -c $versionSql).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Imeshindikana kuingia database '$Database'. Hakuna mabadiliko yaliyofanywa." }
    if ([int]$serverVersion -lt 150000) { throw 'PostgreSQL 15 au mpya zaidi inahitajika.' }

    $auditReady = (& $psql -X -h $HostName -p $Port -U $User -d $Database -w -At -c "SELECT to_regclass('local_migration_audit.applied') IS NOT NULL;").Trim()
    if ($LASTEXITCODE -ne 0 -or $auditReady -ne 't') { throw 'Migration audit haipo. Usitumie script hii kwa database nyingine au restore isiyokamilika.' }
    $baselineReady = (& $psql -X -h $HostName -p $Port -U $User -d $Database -w -At -c "SELECT EXISTS (SELECT 1 FROM local_migration_audit.applied WHERE version = '$BaselineVersion');").Trim()
    if ($LASTEXITCODE -ne 0 -or $baselineReady -ne 't') { throw "Snapshot baseline $BaselineVersion haijathibitishwa kwenye local migration audit." }

    $migrationCandidates = foreach ($path in $migrationPaths) {
        Get-ChildItem -LiteralPath $path -File -Filter '*.sql' |
            Where-Object { $_.BaseName -match '^([0-9]{14})_' -and $Matches[1] -gt $BaselineVersion }
    }
    $migrationGroups = $migrationCandidates | Group-Object { $_.BaseName.Substring(0, 14) }
    $migrations = foreach ($group in ($migrationGroups | Sort-Object Name)) {
        $hashes = @($group.Group | ForEach-Object { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } | Select-Object -Unique)
        if ($hashes.Count -gt 1) { throw "Migration version $($group.Name) ina mafaili yanayotofautiana: $($group.Group.FullName -join ', ')" }
        $group.Group | Select-Object -First 1
    }
    if (-not $migrations) { Write-Host 'Hakuna migration za kutumia.'; return }

    $total = $migrations.Count
    $completed = 0
    foreach ($migration in $migrations) {
        $version = $migration.BaseName.Substring(0, 14)
        $applied = (& $psql -X -h $HostName -p $Port -U $User -d $Database -w -At -c "SELECT EXISTS (SELECT 1 FROM local_migration_audit.applied WHERE version = '$version');").Trim()
        if ($LASTEXITCODE -ne 0) { throw "Imeshindikana kusoma migration audit kabla ya $version." }
        if ($applied -eq 't') { $completed++; continue }

        Write-Host ("Migration {0}/{1}: {2}" -f ($completed + 1), $total, $migration.Name)
        Invoke-LocalPsql @('-X','-h',$HostName,'-p',"$Port",'-U',$User,'-d',$Database,'-w','-v','ON_ERROR_STOP=1','-f',$migration.FullName)

        $safeName = $migration.Name.Replace("'", "''")
        $recordSql = "INSERT INTO local_migration_audit.applied(version,name) VALUES ('$version','$safeName') ON CONFLICT (version) DO NOTHING;"
        Invoke-LocalPsql @('-X','-h',$HostName,'-p',"$Port",'-U',$User,'-d',$Database,'-w','-v','ON_ERROR_STOP=1','-c',$recordSql)
        $completed++
    }

    $summary = (& $psql -X -h $HostName -p $Port -U $User -d $Database -w -At -c "SELECT 'tables=' || count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'; SELECT 'applied_migrations=' || count(*) FROM local_migration_audit.applied;")
    if ($LASTEXITCODE -ne 0) { throw 'Migration zimetumika lakini summary haikupatikana.' }
    Write-Host 'Migrations za local PostgreSQL zimekaguliwa na zilizokosekana zimetumika.'
    $summary | ForEach-Object { Write-Host $_ }
} finally {
    if ($providedPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
}
