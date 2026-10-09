import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const root = new URL("../../../", import.meta.url);
const migrations = [
  "supabase/migrations/20261007110000_cohort_management.sql",
  "supabase/migrations/20261007130000_cohort_assignment_rowcount_guard.sql",
  "supabase/migrations/20261007140000_cohort_assignment_eligibility_guard.sql",
  "supabase/migrations/20261007150000_cohort_edit_roster_guard.sql",
  "supabase/migrations/20261007160000_cohort_programme_integrity_guard.sql",
];

const schema = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE public.institutions(id uuid PRIMARY KEY, institution_code text UNIQUE);
CREATE TABLE public.programmes(id uuid PRIMARY KEY);
CREATE TABLE public.programme_versions(id uuid PRIMARY KEY);
CREATE TABLE public.campuses(id uuid PRIMARY KEY);
CREATE TABLE public.academic_years(id uuid PRIMARY KEY);
CREATE TABLE public.users(id uuid PRIMARY KEY);
CREATE TABLE public.student_cohorts(
 id uuid PRIMARY KEY, institution_id uuid NOT NULL REFERENCES public.institutions(id),
 cohort_code varchar(30) NOT NULL, cohort_name varchar(120) NOT NULL, entry_year integer NOT NULL,
 default_academic_year_id uuid REFERENCES public.academic_years(id), status varchar(20) NOT NULL DEFAULT 'ACTIVE',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT student_cohorts_institution_id_entry_year_key UNIQUE(institution_id,entry_year),
 CONSTRAINT student_cohorts_status_check CHECK(status IN ('ACTIVE','CLOSED','ARCHIVED')),
 CONSTRAINT cohort_code_key UNIQUE(institution_id,cohort_code)
);
CREATE TABLE public.students(
 id uuid PRIMARY KEY, institution_id uuid NOT NULL REFERENCES public.institutions(id), cohort_id uuid REFERENCES public.student_cohorts(id),
 student_status text NOT NULL DEFAULT 'ACTIVE', archived_at timestamptz, admission_year integer,
 programme_id uuid REFERENCES public.programmes(id), programme_version_id uuid REFERENCES public.programme_versions(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.permissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),permission_code text UNIQUE,permission_name text,module_code text,action_code text,description text,status text,updated_at timestamptz);
CREATE TABLE public.roles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),role_code text UNIQUE);
CREATE TABLE public.role_permissions(role_id uuid REFERENCES public.roles(id),permission_id uuid REFERENCES public.permissions(id),UNIQUE(role_id,permission_id));
INSERT INTO public.roles(role_code) VALUES ('SUPER_ADMIN'),('ADMIN'),('REGISTRAR'),('ACADEMIC_OFFICER'),('LECTURER'),('HOD');
`;

const ids = {
  institution: "11111111-1111-4111-8111-111111111111",
  otherInstitution: "22222222-2222-4222-8222-222222222222",
  programme: "33333333-3333-4333-8333-333333333333",
  nextProgramme: "44444444-4444-4444-8444-444444444444",
  cohort: "55555555-5555-4555-8555-555555555555",
  otherCohort: "66666666-6666-4666-8666-666666666666",
  eligible: "77777777-7777-4777-8777-777777777777",
  inactive: "88888888-8888-4888-8888-888888888888",
  archived: "99999999-9999-4999-8999-999999999999",
  eligible2: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  crossInstitutionStudent: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  otherProgrammeStudent: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

async function dbWithMigrations() {
  const db = new PGlite();
  await db.exec(schema);
  for (const migration of migrations) await db.exec(await readFile(new URL(`../../../${migration}`, import.meta.url), "utf8"));
  await db.query("INSERT INTO institutions(id,institution_code) VALUES ($1,'IDMS'),($2,'OTHER')", [ids.institution, ids.otherInstitution]);
  await db.query("INSERT INTO programmes(id) VALUES ($1),($2)", [ids.programme, ids.nextProgramme]);
  await db.query(`INSERT INTO student_cohorts(id,institution_id,cohort_code,cohort_name,entry_year,programme_id,max_capacity)
    VALUES ($1,$2,'C1','Cohort One',2026,$3,1),($4,$5,'C2','Other Institution',2026,$3,2)`,
    [ids.cohort, ids.institution, ids.programme, ids.otherCohort, ids.otherInstitution]);
  await db.query(`INSERT INTO students(id,institution_id,student_status,archived_at,programme_id)
    VALUES ($1,$2,'ACTIVE',NULL,$3),($4,$2,'INACTIVE',NULL,$3),($5,$2,'ACTIVE',now(),$3),($6,$2,'ACTIVE',NULL,$3),($7,$8,'ACTIVE',NULL,$3),($9,$2,'ACTIVE',NULL,$10)`,
    [ids.eligible, ids.institution, ids.programme, ids.inactive, ids.archived, ids.eligible2, ids.crossInstitutionStudent, ids.otherInstitution, ids.otherProgrammeStudent, ids.nextProgramme]);
  return db;
}

async function assertPgError(run, code) {
  await assert.rejects(run, error => error.code === code);
}

test("cohort migrations execute in PostgreSQL and enforce assignment/edit invariants", async () => {
  const db = await dbWithMigrations();
  try {
    const assigned = await db.query("SELECT public.assign_students_to_cohort($1,ARRAY[$2]::uuid[],NULL) AS changed", [ids.cohort, ids.eligible]);
    assert.equal(Number(assigned.rows[0].changed), 1);

    await assertPgError(() => db.query("SELECT public.assign_students_to_cohort($1,ARRAY[$2]::uuid[],NULL)", [ids.cohort, ids.eligible2]), "23514");
    await assertPgError(() => db.query("SELECT public.assign_students_to_cohort($1,ARRAY[$2]::uuid[],NULL)", [ids.cohort, ids.inactive]), "P0002");
    await assertPgError(() => db.query("SELECT public.assign_students_to_cohort($1,ARRAY[$2]::uuid[],NULL)", [ids.cohort, ids.archived]), "P0002");
    await assertPgError(() => db.query("SELECT public.assign_students_to_cohort($1,ARRAY[$2]::uuid[],NULL)", [ids.cohort, ids.crossInstitutionStudent]), "P0002");
    await assertPgError(() => db.query("SELECT public.assign_students_to_cohort($1,ARRAY[$2]::uuid[],NULL)", [ids.cohort, ids.otherProgrammeStudent]), "P0002");
    await assertPgError(() => db.query("SELECT public.assign_students_to_cohort($1,ARRAY[$2,$2]::uuid[],NULL)", [ids.cohort, ids.eligible2]), "22023");

    const payload = {
      cohort_code: "C1", cohort_name: "Cohort One", institution_id: ids.institution,
      programme_id: ids.programme, programme_version_id: null, default_academic_year_id: null,
      intake_code: null, intake_name: null, entry_year: 2026, start_date: null,
      expected_completion_date: null, study_mode: "FULL_TIME", campus_id: null,
      max_capacity: 0, status: "ACTIVE", notes: null, updated_by: null,
    };
    await assertPgError(() => db.query("SELECT public.update_cohort_with_roster_guard($1,$2,$3::jsonb,NULL)", [ids.cohort, ids.institution, JSON.stringify(payload)]), "23514");
    await assertPgError(() => db.query("SELECT public.update_cohort_with_roster_guard($1,$2,$3::jsonb,NULL)", [ids.cohort, ids.institution, JSON.stringify({ ...payload, programme_id: ids.nextProgramme, max_capacity: 2 })]), "23514");
    const stateAfterRejectedEdits = await db.query("SELECT programme_id,max_capacity FROM student_cohorts WHERE id=$1", [ids.cohort]);
    assert.equal(stateAfterRejectedEdits.rows[0].programme_id, ids.programme);
    assert.equal(stateAfterRejectedEdits.rows[0].max_capacity, 1);

    const edit = await db.query("SELECT public.update_cohort_with_roster_guard($1,$2,$3::jsonb,NULL) AS result", [ids.cohort, ids.institution, JSON.stringify({ ...payload, cohort_name: "Edited Cohort", max_capacity: 2 })]);
    assert.equal(edit.rows[0].result.old_values.cohort_name, "Cohort One");
    assert.equal(edit.rows[0].result.new_values.cohort_name, "Edited Cohort");

    const grants = await db.query(`SELECT
      has_function_privilege('anon','public.assign_students_to_cohort(uuid,uuid[],uuid)','EXECUTE') AS anon_assign,
      has_function_privilege('service_role','public.assign_students_to_cohort(uuid,uuid[],uuid)','EXECUTE') AS service_assign,
      has_function_privilege('anon','public.update_cohort_with_roster_guard(uuid,uuid,jsonb,uuid)','EXECUTE') AS anon_edit,
      has_function_privilege('service_role','public.update_cohort_with_roster_guard(uuid,uuid,jsonb,uuid)','EXECUTE') AS service_edit`);
    assert.equal(grants.rows[0].anon_assign, false);
    assert.equal(grants.rows[0].anon_edit, false);
    assert.equal(grants.rows[0].service_assign, true);
    assert.equal(grants.rows[0].service_edit, true);
  } finally {
    await db.close();
  }
});
