import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(
  new URL("../../../supabase/migrations/20261011230000_admin_reset_academic_registration_guards.sql", import.meta.url),
  "utf8",
);

const fixture = `
CREATE TABLE public.attendance_sessions(id uuid PRIMARY KEY, status text NOT NULL);
CREATE TABLE public.attendance_records(id integer PRIMARY KEY, attendance_session_id uuid NOT NULL REFERENCES attendance_sessions(id));
CREATE TABLE public.student_registrations(id uuid PRIMARY KEY, registration_status text NOT NULL, total_registered_credits numeric NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.course_registrations(id integer PRIMARY KEY, student_registration_id uuid NOT NULL REFERENCES student_registrations(id), credits numeric NOT NULL, registration_status text NOT NULL);
CREATE TABLE public.course_add_drop_requests(id integer PRIMARY KEY, student_registration_id uuid NOT NULL REFERENCES student_registrations(id));

CREATE FUNCTION public.prevent_locked_attendance_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status varchar; BEGIN
  SELECT status INTO v_status FROM public.attendance_sessions WHERE id=COALESCE(NEW.attendance_session_id,OLD.attendance_session_id);
  IF v_status='LOCKED' THEN RAISE EXCEPTION 'Attendance session is LOCKED'; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE FUNCTION public.prevent_locked_course_registration_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status varchar; BEGIN
  SELECT registration_status INTO v_status FROM public.student_registrations WHERE id=COALESCE(NEW.student_registration_id,OLD.student_registration_id);
  IF v_status='LOCKED' THEN RAISE EXCEPTION 'Course registration is LOCKED'; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE FUNCTION public.prevent_add_drop_after_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status varchar; BEGIN
  SELECT registration_status INTO v_status FROM public.student_registrations WHERE id=COALESCE(NEW.student_registration_id,OLD.student_registration_id);
  IF v_status IN ('LOCKED','CANCELLED') THEN RAISE EXCEPTION 'Add/drop is LOCKED'; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE FUNCTION public.refresh_registration_credits() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_registration_id uuid; BEGIN
  v_registration_id:=COALESCE(NEW.student_registration_id,OLD.student_registration_id);
  UPDATE public.student_registrations sr SET total_registered_credits=COALESCE((SELECT SUM(cr.credits) FROM public.course_registrations cr WHERE cr.student_registration_id=sr.id AND cr.registration_status NOT IN ('DROPPED','REJECTED','CANCELLED')),0),updated_at=now() WHERE sr.id=v_registration_id;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER trg_prevent_locked_attendance_change BEFORE INSERT OR UPDATE OR DELETE ON public.attendance_records FOR EACH ROW EXECUTE FUNCTION public.prevent_locked_attendance_change();
CREATE TRIGGER trg_prevent_locked_course_registration BEFORE INSERT OR UPDATE OR DELETE ON public.course_registrations FOR EACH ROW EXECUTE FUNCTION public.prevent_locked_course_registration_change();
CREATE TRIGGER trg_prevent_add_drop_after_lock BEFORE INSERT OR UPDATE OR DELETE ON public.course_add_drop_requests FOR EACH ROW EXECUTE FUNCTION public.prevent_add_drop_after_lock();
CREATE TRIGGER trg_refresh_registration_credits AFTER INSERT OR UPDATE OR DELETE ON public.course_registrations FOR EACH ROW EXECUTE FUNCTION public.refresh_registration_credits();

`;

async function database() {
  const db = new PGlite();
  await db.exec(fixture);
  await db.exec(migration);
  await db.exec(`
    INSERT INTO public.attendance_sessions VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','OPEN');
    INSERT INTO public.attendance_records VALUES (1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    INSERT INTO public.student_registrations VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','OPEN',0,now());
    INSERT INTO public.course_registrations VALUES (1,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',12,'REGISTERED');
    INSERT INTO public.course_add_drop_requests VALUES (1,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    UPDATE public.attendance_sessions SET status='LOCKED';
    UPDATE public.student_registrations SET registration_status='LOCKED';
  `);
  return db;
}

test("locked academic delete protections remain active outside admin reset", async () => {
  const db = await database();
  try {
    await assert.rejects(() => db.exec("DELETE FROM public.attendance_records WHERE id=1"), /LOCKED/);
    await assert.rejects(() => db.exec("DELETE FROM public.course_registrations WHERE id=1"), /locked student registration/);
    await assert.rejects(() => db.exec("DELETE FROM public.course_add_drop_requests WHERE id=1"), /locked or cancelled/);
    const counts = await db.query(`
      SELECT (SELECT count(*)::int FROM public.attendance_records) AS attendance,
             (SELECT count(*)::int FROM public.course_registrations) AS registrations,
             (SELECT count(*)::int FROM public.course_add_drop_requests) AS requests
    `);
    assert.deepEqual(counts.rows[0], { attendance: 1, registrations: 1, requests: 1 });
  } finally {
    await db.close();
  }
});

test("admin reset deletes locked academic rows and skips derived credit refresh", async () => {
  const db = await database();
  try {
    await db.exec(`
      BEGIN;
      SELECT set_config('idmc.admin_data_reset','on',true);
      DELETE FROM public.attendance_records;
      DELETE FROM public.course_add_drop_requests;
      DELETE FROM public.course_registrations;
      COMMIT;
    `);
    const state = await db.query(`
      SELECT (SELECT count(*)::int FROM public.attendance_records) AS attendance,
             (SELECT count(*)::int FROM public.course_registrations) AS registrations,
             (SELECT count(*)::int FROM public.course_add_drop_requests) AS requests,
             (SELECT total_registered_credits::int FROM public.student_registrations LIMIT 1) AS credits
    `);
    assert.deepEqual(state.rows[0], { attendance: 0, registrations: 0, requests: 0, credits: 12 });
  } finally {
    await db.close();
  }
});

test("ordinary course deletion still refreshes registered credits", async () => {
  const db = await database();
  try {
    await db.exec(`
      UPDATE public.student_registrations SET registration_status='OPEN';
      DELETE FROM public.course_registrations WHERE id=1;
    `);
    const result = await db.query("SELECT total_registered_credits::int AS credits FROM public.student_registrations LIMIT 1");
    assert.equal(result.rows[0].credits, 0);
  } finally {
    await db.close();
  }
});
