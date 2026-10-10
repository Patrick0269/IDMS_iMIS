<#
  IDMC iMIS - Login diagnosis & logging fix
  ------------------------------------------
  1. Patches apps\backend\src\modules\auth\controllers\auth.controller.ts so the
     REAL reason a login fails is written to the backend logs (message to the
     browser stays exactly the same - no security info is leaked to the client).
  2. Adds apps\backend\scripts\diagnose-login.mjs - a standalone tool that talks
     to Supabase directly, bypassing the generic error message, and prints the
     exact reason a given identifier/password combination is rejected.
  3. Rebuilds the backend and runs the diagnostic immediately against the two
     credentials you reported, so you get the real answer in this same run.

  Hakuna sehemu nyingine ya kodi inayoguswa.

  Matumizi:
    .\Fix-IDMC-Login-System.ps1
    .\Fix-IDMC-Login-System.ps1 -StudentNumber "IDMC/2026/00001" -StudentPassword "IDMC/2026/00001"
    .\Fix-IDMC-Login-System.ps1 -StaffEmail "libenangapatrick@gmail.com" -StaffPassword "...."
#>
param(
    [string]$ProjectRoot = "C:\Users\liben\Documents\IDMC_iMIS",
    [string]$StudentNumber = "IDMC/2026/00001",
    [string]$StudentPassword = "IDMC/2026/00001",
    [string]$StaffEmail = "libenangapatrick@gmail.com",
    [string]$StaffPassword = "",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$Backend = Join-Path $ProjectRoot "apps\backend"
$ControllerPath = Join-Path $Backend "src\modules\auth\controllers\auth.controller.ts"
$ScriptsDir = Join-Path $Backend "scripts"
$DiagnosePath = Join-Path $ScriptsDir "diagnose-login.mjs"

if (-not (Test-Path -LiteralPath $ControllerPath)) {
    throw "Sikuipata: $ControllerPath . Hakikisha -ProjectRoot ni sahihi."
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $enc)
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $ProjectRoot "repair-backups\login-fix-$stamp"
New-Item -ItemType Directory -Force -Path $backupDir, $ScriptsDir | Out-Null

# ------------------------------------------------------------- 1. Patch controller
Write-Host "===== 1. NAWEKA UANDISHI WA LOGS ZA KWELI (auth.controller.ts) =====" -ForegroundColor Cyan

$existing = Get-Content -LiteralPath $ControllerPath -Raw
if ($existing -match "logError\(") {
    Write-Host "  Tayari imewekwa hapo awali - naruka." -ForegroundColor Yellow
} else {
    Copy-Item $ControllerPath (Join-Path $backupDir "auth.controller.ts") -Force
    Write-Host "  backup: $ControllerPath" -ForegroundColor DarkGray

    $patchedController = @'
import type { Request, Response } from "express";
import * as authService from "../services/auth.service.js";
import { logError } from "../../../utils/logger.js";

export async function login(req: Request, res: Response): Promise<void> {
  const identifier = String(req.body?.identifier ?? "").trim();
  const password = String(req.body?.password ?? "");

  if (!identifier || !password) {
    res.status(400).json({
      success: false,
      message: "Email, username or student number and password are required",
    });
    return;
  }

  try {
    const session = await authService.login(identifier, password);
    res.json({ success: true, data: session });
  } catch (error) {
    // The client always sees a generic message (security). The REAL reason
    // (wrong password vs account missing vs Supabase key/config problem) is
    // written to the server logs only, so it can be diagnosed after the fact.
    logError(`Login failed for identifier "${identifier}"`, error);
    res.status(401).json({
      success: false,
      message: "Invalid login credentials",
    });
  }
}

export async function studentLogin(req: Request, res: Response): Promise<void> {
  const studentNumber = String(req.body?.studentNumber ?? "").trim();
  const password = String(req.body?.password ?? "");

  if (!studentNumber || !password) {
    res.status(400).json({
      success: false,
      message: "Student Number and password are required",
    });
    return;
  }

  try {
    const session = await authService.studentLogin(studentNumber, password);
    res.json({ success: true, data: session });
  } catch (error) {
    logError(`Student login failed for "${studentNumber}"`, error);
    res.status(401).json({
      success: false,
      message: "Invalid Student Number or password",
    });
  }
}

export async function me(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Authentication required",
    });
    return;
  }

  const data = await authService.getCurrentUser(req.user.id);
  res.json({ success: true, data });
}

export async function authHealth(
  _req: Request,
  res: Response
): Promise<void> {
  res.json({
    success: true,
    module: "authentication",
    status: "online",
  });
}
'@

    Write-Utf8NoBom $ControllerPath $patchedController
    Write-Host "  [OK] auth.controller.ts imeboreshwa (ujumbe kwa mtumiaji haujabadilika)." -ForegroundColor Green
}

# ------------------------------------------------------------- 2. Diagnostic script
Write-Host ""
Write-Host "===== 2. NAWEKA CHOMBO CHA UCHUNGUZI (scripts/diagnose-login.mjs) =====" -ForegroundColor Cyan

$diagnoseScript = @'
import process from "node:process";

const identifier = process.argv[2];
const password = process.argv[3];

if (!identifier || !password) {
  console.error("Matumizi: node scripts/diagnose-login.mjs <identifier> <password>");
  process.exit(1);
}

const { getSupabase, createSupabaseAuthClient } = await import("../dist/config/database.js");
const {
  isValidStudentNumber,
  normaliseStudentNumber,
  resolveStudentLoginEmail,
} = await import("../dist/modules/auth/services/student-login.service.js");

console.log(`\n================ IDMC LOGIN DIAGNOSTIC: "${identifier}" ================\n`);

console.log("== 1. Env / muunganiko wa Supabase ==");
let supabase;
try {
  supabase = getSupabase();
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (error) {
    console.error("[FAIL] Supabase Admin API imekataa ombi.");
    console.error("        Hii mara nyingi ina maana SUPABASE_URL au SUPABASE_SERVICE_ROLE_KEY");
    console.error("        ndani ya apps\\backend\\.env si sahihi (labda ufunguo umebadilishwa/");
    console.error("        umefutwa kwenye Supabase Dashboard, au .env inaelekeza project tofauti).");
    console.error("        Ujumbe halisi:", error.message);
    process.exit(1);
  }
  console.log("[OK] Muunganiko na Supabase Admin API unafanya kazi.");
} catch (error) {
  console.error("[FAIL] Haikuweza kupakia usanidi wa Supabase (.env).");
  console.error(error?.message || error);
  process.exit(1);
}

const isStudentFormat = isValidStudentNumber(identifier);

if (isStudentFormat) {
  const number = normaliseStudentNumber(identifier);
  console.log(`\n== 2. Kutafuta mwanafunzi mwenye namba: ${number} ==`);

  const { data: rows, error } = await supabase
    .from("students")
    .select("id, student_number, registration_number, user_id, student_status, first_name, last_name")
    .or(`registration_number.ilike.${number},student_number.ilike.${number}`);

  if (error) {
    console.error("[FAIL] Hitilafu ya database wakati wa kutafuta mwanafunzi:");
    console.error(error);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    console.error(`[FAIL] HAKUNA mwanafunzi mwenye namba "${number}" kwenye jedwali la "students".`);
    console.error("        Sababu inayowezekana: rekodi haijaundwa kwenye database hii, au");
    console.error("        SUPABASE_URL inaelekeza project tofauti na ile ambayo mwanafunzi huyu aliundwa.");
    process.exit(1);
  }

  if (rows.length > 1) {
    console.error(`[FAIL] Namba "${number}" inalingana na rekodi ${rows.length} - mfumo unakataa kwa usalama.`);
    rows.forEach((r) => console.error("  -", r));
    process.exit(1);
  }

  const student = rows[0];
  console.log("[OK] Mwanafunzi amepatikana:");
  console.log(`     student_number       : ${student.student_number}`);
  console.log(`     registration_number  : ${student.registration_number}`);
  console.log(`     student_status       : ${student.student_status}`);
  console.log(`     user_id (akaunti)    : ${student.user_id ?? "(bado hajaunganishwa - hii itakuwa LOGIN YA KWANZA)"}`);

  console.log("\n== 3. Kujaribu login halisi (kama vile mfumo unavyofanya) ==");
  try {
    const email = await resolveStudentLoginEmail(number, password);
    if (!email) {
      console.error("[FAIL] resolveStudentLoginEmail imerudisha null bila kutegemewa.");
      process.exit(1);
    }
    console.log(`[OK] Email ya ndani ya uthibitisho imepatikana: ${email}`);

    const authClient = createSupabaseAuthClient();
    const { error: signInError } = await authClient.auth.signInWithPassword({ email, password });

    if (signInError) {
      console.error("\n[FAIL] Supabase Auth IMEKATAA password. Ujumbe halisi:");
      console.error(`        status : ${signInError.status}`);
      console.error(`        message: ${signInError.message}`);
      if (!student.user_id) {
        console.error("\n        Kumbuka: kwa LOGIN YA KWANZA, password LAZIMA iwe sawasawa na");
        console.error("        registration_number/student_number, herufi kubwa/ndogo zinajali.");
      } else {
        console.error("\n        Akaunti tayari ipo (user_id imewekwa) - hii ina maana password ya awali");
        console.error("        (registration_number) haitumiki tena; mwanafunzi labda aliibadilisha,");
        console.error("        au password uliyojaribu si sahihi.");
      }
      process.exit(1);
    }

    console.log("\n[PASS] LOGIN HII INGEFANIKIWA. Tatizo la awali huenda halikuwa kwenye taarifa hizi.");
  } catch (error) {
    console.error("[FAIL] resolveStudentLoginEmail imetupa hitilafu:");
    console.error(error?.message || error);
    process.exit(1);
  }
} else {
  const email = identifier.toLowerCase();
  console.log(`\n== 2. Kutafuta mtumiaji (staff/email): ${email} ==`);

  const { data: userRow, error } = await supabase
    .from("users")
    .select("id, email, username, status, auth_user_id")
    .eq("email", email)
    .maybeSingle();

  if (error) {
    console.error("[FAIL] Hitilafu ya database:", error);
    process.exit(1);
  }

  if (!userRow) {
    console.error(`[FAIL] HAKUNA mtumiaji mwenye email "${email}" kwenye jedwali la "public.users".`);
    console.error("        Sababu inayowezekana: akaunti haijaundwa kwenye database hii, email ina");
    console.error("        tofauti ndogo (nafasi/herufi), au SUPABASE_URL inaelekeza project tofauti.");
  } else {
    console.log("[OK] Mtumiaji amepatikana kwenye public.users:");
    console.log(`     id       : ${userRow.id}`);
    console.log(`     username : ${userRow.username}`);
    console.log(`     status   : ${userRow.status}`);
    if (userRow.status !== "ACTIVE") {
      console.error(`[FAIL] Status ya akaunti ni "${userRow.status}", SI ACTIVE - hii peke yake inatosha kukataa login.`);
    }
  }

  console.log("\n== 3. Kujaribu Supabase Auth signInWithPassword moja kwa moja ==");
  const authClient = createSupabaseAuthClient();
  const { error: signInError } = await authClient.auth.signInWithPassword({ email, password });

  if (signInError) {
    console.error("\n[FAIL] Ujumbe halisi kutoka Supabase Auth:");
    console.error(`        status : ${signInError.status}`);
    console.error(`        message: ${signInError.message}`);
    console.error("\n        Sababu za kawaida: (a) password si sahihi, (b) akaunti ya Auth haipo kwa");
    console.error("        email hii kwenye project hii, (c) email haijathibitishwa.");
    process.exit(1);
  }

  console.log("\n[PASS] LOGIN HII INGEFANIKIWA kwenye Supabase Auth.");
}

console.log("\n=================================================================\n");
'@

Write-Utf8NoBom $DiagnosePath $diagnoseScript
Write-Host "  [OK] imeandikwa: $DiagnosePath" -ForegroundColor Green

# ------------------------------------------------------------- 3. Build + run
if (-not $SkipBuild) {
    Write-Host ""
    Write-Host "===== 3. NAJENGA BACKEND UPYA (npm run build) =====" -ForegroundColor Cyan
    Push-Location $Backend
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "Backend build imeshindwa." }
    } finally {
        Pop-Location
    }
    Write-Host "  [OK] build imekamilika." -ForegroundColor Green
}

Write-Host ""
Write-Host "===== 4. UCHUNGUZI: NAMBA YA MWANAFUNZI =====" -ForegroundColor Cyan
Push-Location $Backend
try {
    node scripts/diagnose-login.mjs "$StudentNumber" "$StudentPassword"
} catch {
    Write-Host "Uchunguzi wa mwanafunzi umeishia na hitilafu iliyoonyeshwa hapo juu." -ForegroundColor Yellow
} finally {
    Pop-Location
}

if ($StaffPassword -ne "") {
    Write-Host ""
    Write-Host "===== 5. UCHUNGUZI: STAFF EMAIL =====" -ForegroundColor Cyan
    Push-Location $Backend
    try {
        node scripts/diagnose-login.mjs "$StaffEmail" "$StaffPassword"
    } catch {
        Write-Host "Uchunguzi wa staff umeishia na hitilafu iliyoonyeshwa hapo juu." -ForegroundColor Yellow
    } finally {
        Pop-Location
    }
} else {
    Write-Host ""
    Write-Host "(Uchunguzi wa '$StaffEmail' umerukwa - hukuweka -StaffPassword. Endesha tena:" -ForegroundColor DarkYellow
    Write-Host "  .\Fix-IDMC-Login-System.ps1 -SkipBuild -StaffPassword 'password-yako-halisi')" -ForegroundColor DarkYellow
}

Write-Host ""
Write-Host "Backup ya faili la awali: $backupDir" -ForegroundColor DarkGray
Write-Host "Tangu sasa, kila jaribio la login halisi (kwenye tovuti) litaandika sababu halisi" -ForegroundColor DarkGray
Write-Host "kwenye: runtime-logs\backend-*.log au dirisha la backend, hata kama mtumiaji" -ForegroundColor DarkGray
Write-Host "ataona ujumbe ule ule wa jumla." -ForegroundColor DarkGray
