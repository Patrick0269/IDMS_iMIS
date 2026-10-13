import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL("../../../supabase/migrations/202610130002_applicant_qualification_eligibility.sql", import.meta.url);
const schema = `
CREATE TABLE public.users(id uuid PRIMARY KEY);
CREATE TABLE public.programmes(id uuid PRIMARY KEY);
CREATE TABLE public.idmc_intakes(id uuid PRIMARY KEY);
CREATE TABLE public.academic_qualifications(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qualification_type text NOT NULL,
  field_of_study text,
  applicant_id uuid NOT NULL,
  verification_status text NOT NULL DEFAULT 'PENDING',
  CONSTRAINT academic_qualifications_type_check CHECK (qualification_type IN ('SECONDARY','CERTIFICATE','DIPLOMA','OTHER'))
);
`;
const user = "11111111-1111-4111-8111-111111111111";
const programme = "22222222-2222-4222-8222-222222222222";
const intake = "33333333-3333-4333-8333-333333333333";

test("eligibility migration preserves qualifications and maps only the two explicit legacy labels", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    await db.exec(schema);
    await db.query(
      "INSERT INTO academic_qualifications(id,qualification_type,field_of_study,applicant_id) VALUES ($1,'OTHER','Technician Certificate',$4),($2,'OTHER','Advanced Level (Form Six)',$4),($3,'OTHER','Unclassified award',$4)",
      ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666", user],
    );
    await db.exec(await readFile(migrationUrl, "utf8"));
    const rows = await db.query("SELECT id,qualification_type,qualification_level,field_of_study FROM academic_qualifications ORDER BY id");
    assert.equal(rows.rows.length, 3);
    assert.deepEqual(rows.rows.map(row => [row.qualification_type, row.qualification_level]), [
      ["TECHNICIAN_CERTIFICATE", 5], ["ADVANCED_LEVEL", null], ["OTHER", null],
    ]);
    assert.equal(rows.rows[0].field_of_study, "Technician Certificate");
    assert.equal(rows.rows[2].field_of_study, "Unclassified award");
    await assert.rejects(
      db.query("INSERT INTO academic_qualifications(applicant_id,qualification_type) VALUES ($1,'UNAPPROVED')", [user]),
      error => error.code === "23514",
    );
    await assert.rejects(
      db.query("INSERT INTO academic_qualifications(applicant_id,qualification_type,qualification_level) VALUES ($1,'CERTIFICATE',11)", [user]),
      error => error.code === "23514",
    );
  } finally { await db.close(); }
});

test("eligibility rules enforce programme/intake uniqueness and retain approved references", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    await db.exec(schema);
    await db.query("INSERT INTO users(id) VALUES ($1)", [user]);
    await db.query("INSERT INTO programmes(id) VALUES ($1)", [programme]);
    await db.query("INSERT INTO idmc_intakes(id) VALUES ($1)", [intake]);
    await db.exec(await readFile(migrationUrl, "utf8"));
    const global = { programme_id: programme, accepted_qualification_types: ["CERTIFICATE"], minimum_qualification_level: 4, approved_by: user, reason: "Approved policy reference 2026/01" };
    await db.query("INSERT INTO idmc_programme_admission_rules(programme_id,accepted_qualification_types,minimum_qualification_level,approved_by,reason) VALUES ($1,$2,$3,$4,$5)", [global.programme_id, global.accepted_qualification_types, global.minimum_qualification_level, global.approved_by, global.reason]);
    await assert.rejects(
      db.query("INSERT INTO idmc_programme_admission_rules(programme_id,accepted_qualification_types,approved_by,reason) VALUES ($1,$2,$3,$4)", [programme, ["ADVANCED_LEVEL"], user, "Another global policy"]),
      error => error.code === "23505",
    );
    await db.query("INSERT INTO idmc_programme_admission_rules(programme_id,intake_id,accepted_qualification_types,approved_by,reason) VALUES ($1,$2,$3,$4,$5)", [programme, intake, ["ADVANCED_LEVEL"], user, "Approved intake policy"]);
    await assert.rejects(
      db.query("INSERT INTO idmc_programme_admission_rules(programme_id,intake_id,accepted_qualification_types,approved_by,reason) VALUES ($1,$2,$3,$4,$5)", [programme, intake, ["DIPLOMA"], user, "Duplicate intake policy"]),
      error => error.code === "23505",
    );
    const rows = await db.query("SELECT programme_id,intake_id,accepted_qualification_types,reason FROM idmc_programme_admission_rules ORDER BY intake_id NULLS FIRST");
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows[0].reason, global.reason);
    assert.deepEqual(rows.rows[1].accepted_qualification_types, ["ADVANCED_LEVEL"]);
  } finally { await db.close(); }
});
