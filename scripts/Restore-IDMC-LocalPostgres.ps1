[CmdletBinding()]
param(
    [string]$HostName = 'localhost',
    [int]$Port = 5433,
    [string]$User = 'postgres',
    [string]$Database = 'idmc_imis_recovered_20261004'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$pgBin = 'C:\Program Files\PostgreSQL\18\bin'
$psql = Join-Path $pgBin 'psql.exe'
$createdb = Join-Path $pgBin 'createdb.exe'
$pgIsReady = Join-Path $pgBin 'pg_isready.exe'
$backup = Join-Path $repo 'backups\before-staging-reset-20261004-193343'
$schemaDump = Join-Path $backup 'schema-public-auth-storage.sql'
$dataDump = Join-Path $backup 'data-public-auth-storage.sql'
$migrationPaths = @(
    (Join-Path $repo 'supabase\migrations'),
    (Join-Path $repo 'database\migrations')
)
$baselineVersion = '20261004130004'
$providedPassword = $false

function Invoke-LocalPsql {
    param([string[]]$Arguments)
    & $psql @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "psql imeshindwa (exit $LASTEXITCODE): $($Arguments -join ' ')"
    }
}

try {
    if ($Database -notmatch '^[a-zA-Z_][a-zA-Z0-9_]{0,62}$') {
        throw 'Jina la database si salama. Tumia herufi, namba na underscore pekee.'
    }
    foreach ($file in @($psql, $createdb, $pgIsReady, $schemaDump, $dataDump)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Faili inayohitajika haipo: $file"
        }
    }
    foreach ($path in $migrationPaths) {
        if (-not (Test-Path -LiteralPath $path -PathType Container)) {
            throw "Folda ya migrations haipo: $path"
        }
    }

    & $pgIsReady -h $HostName -p $Port
    if ($LASTEXITCODE -ne 0) {
        throw "PostgreSQL haipokei muunganisho kwenye ${HostName}:$Port. Hakikisha service ya PostgreSQL 18 inaendelea na port ni sahihi."
    }

    $passwordFile = $env:PGPASSFILE
    if (-not $passwordFile) {
        $passwordFile = Join-Path $env:APPDATA 'postgresql\pgpass.conf'
    }
    if (-not $env:PGPASSWORD -and -not (Test-Path -LiteralPath $passwordFile)) {
        $securePassword = Read-Host "Weka password ya local PostgreSQL user '$User' (itaonekana imefichwa)" -AsSecureString
        $passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
        try {
            $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
            $providedPassword = $true
        }
        finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
            $securePassword.Dispose()
        }
    }

    $identity = (& $psql -X -h $HostName -p $Port -U $User -d postgres -w -At -c 'SELECT current_user || chr(9) || current_setting(''server_version_num'');').Trim()
    if ($LASTEXITCODE -ne 0) {
        throw 'Imeshindikana kuingia PostgreSQL. Kagua username/password na port; hakuna database iliyobadilishwa.'
    }
    $identityParts = $identity -split "`t"
    if ($identityParts.Count -ne 2 -or [int]$identityParts[1] -lt 150000) {
        throw "PostgreSQL 15 au mpya zaidi inahitajika. Taarifa iliyopatikana: $identity"
    }
    if ($identityParts[0] -ne 'postgres') {
        throw "Tumia superuser postgres kwa restore hii. User iliyounganishwa: $($identityParts[0])"
    }

    $exists = (& $psql -X -h $HostName -p $Port -U $User -d postgres -w -At -c "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$Database');").Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Imeshindikana kukagua jina la database lengwa.' }
    if ($exists -eq 't') {
        throw "Database '$Database' tayari ipo. Script haifuti wala kuandika juu ya database iliyopo. Tumia jina jipya kwa -Database."
    }

    Write-Host "Inatengeneza database mpya '$Database' (haitagusa database nyingine)..."
    & $createdb -h $HostName -p $Port -U $User --maintenance-db=postgres --template=template0 --encoding=UTF8 $Database
    if ($LASTEXITCODE -ne 0) { throw 'Kutengeneza database mpya kumeshindikana.' }

    $roleBootstrap = 'DO $bootstrap$ DECLARE role_name text; BEGIN FOREACH role_name IN ARRAY ARRAY[''anon'',''authenticated'',''dashboard_user'',''service_role'',''supabase_admin'',''supabase_auth_admin'',''supabase_storage_admin''] LOOP IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN EXECUTE format(''CREATE ROLE %I NOLOGIN'', role_name); END IF; END LOOP; END $bootstrap$;'
    Invoke-LocalPsql @('-X','-h',$HostName,'-p',"$Port",'-U',$User,'-d','postgres','-w','-v','ON_ERROR_STOP=1','-c',$roleBootstrap)

    Write-Host 'Inarejesha schema ya snapshot ya 2026-10-04...'
    Invoke-LocalPsql @('-X','-h',$HostName,'-p',"$Port",'-U',$User,'-d',$Database,'-w','-v','ON_ERROR_STOP=1','-f',$schemaDump)
    Write-Host 'Inarejesha data ya snapshot (public, auth na storage metadata)...'
    Invoke-LocalPsql @('-X','-h',$HostName,'-p',"$Port",'-U',$User,'-d',$Database,'-w','-v','ON_ERROR_STOP=1','-f',$dataDump)

    Invoke-LocalPsql @('-X','-h',$HostName,'-p',"$Port",'-U',$User,'-d',$Database,'-w','-v','ON_ERROR_STOP=1','-c','CREATE SCHEMA IF NOT EXISTS local_migration_audit; CREATE TABLE IF NOT EXISTS local_migration_audit.applied (version text PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());')
    $baselineName = 'backup snapshot through 2026-10-04 13:00 UTC'
    $baselineSql = "INSERT INTO local_migration_audit.applied(version,name) VALUES ('$baselineVersion','$baselineName') ON CONFLICT (version) DO NOTHING;"
    Invoke-LocalPsql @('-X','-h',$HostName,'-p',"$Port",'-U',$User,'-d',$Database,'-w','-v','ON_ERROR_STOP=1','-c',$baselineSql)

    $migrationCandidates = foreach ($path in $migrationPaths) {
        Get-ChildItem -LiteralPath $path -File -Filter '*.sql' |
            Where-Object { $_.BaseName -match '^([0-9]{14})_' -and $Matches[1] -gt $baselineVersion }
    }
    $migrationGroups = $migrationCandidates | Group-Object { $_.BaseName.Substring(0, 14) }
    $migrations = foreach ($group in ($migrationGroups | Sort-Object Name)) {
        $hashes = @($group.Group | ForEach-Object { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } | Select-Object -Unique)
        if ($hashes.Count -gt 1) { throw "Migration version $($group.Name) ina mafaili yanayotofautiana: $($group.Group.FullName -join ', ')" }
        $group.Group | Select-Object -First 1
    }
    if ($migrations.Count -eq 0) { throw 'Hakuna migration baada ya baseline iliyotambuliwa.' }

    $completed = 0
    foreach ($migration in $migrations) {
        Write-Host ("Migration {0}/{1}: {2}" -f ($completed + 1), $migrations.Count, $migration.Name)
        try {
            Invoke-LocalPsql @('-X','-h',$HostName,'-p',"$Port",'-U',$User,'-d',$Database,'-w','-v','ON_ERROR_STOP=1','-f',$migration.FullName)
        }
        catch {
            throw "Migration '$($migration.Name)' imeshindwa. Database ya kurejesha imeachwa kwa uchunguzi; database zilizokuwepo hazijafutwa. Sababu: $($_.Exception.Message)"
        }
        $version = $migration.BaseName.Substring(0,14)
        $migrationName = $migration.BaseName.Substring(15).Replace("'", "''")
        $recordSql = "INSERT INTO local_migration_audit.applied(version,name) VALUES ('$version','$migrationName') ON CONFLICT (version) DO NOTHING;"
        Invoke-LocalPsql @('-X','-h',$HostName,'-p',"$Port",'-U',$User,'-d',$Database,'-w','-v','ON_ERROR_STOP=1','-c',$recordSql)
        $completed++
    }

    $counts = (& $psql -X -h $HostName -p $Port -U $User -d $Database -w -At -c "SELECT 'tables=' || count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'; SELECT 'applied_migrations=' || count(*) FROM local_migration_audit.applied;")
    if ($LASTEXITCODE -ne 0) { throw 'Restore imekamilika lakini ukaguzi wa mwisho wa database umeshindwa.' }
    Write-Host "Restore na migrations zimekamilika kwenye database mpya '$Database'."
    $counts | ForEach-Object { Write-Host $_ }
    Write-Warning 'Data hii imetoka kwenye snapshot ya 2026-10-04 pekee. Data iliyoongezwa baada ya tarehe hiyo haiwezi kurejeshwa kutoka faili hizi. Faili halisi za Storage hazimo; metadata yake tu ndiyo kwenye dump.'
    Write-Warning 'Database hii imerejeshwa kwenye PostgreSQL ya ndani. Hakikisha PostgREST na Cloudflare Tunnel vimewekwa na app imekatwa rasmi kwenda PostgreSQL kabla ya kuelekeza watumiaji wa production.'
}
finally {
    if ($providedPassword) {
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    }
}
