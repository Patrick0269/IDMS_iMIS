BEGIN;
CREATE TABLE IF NOT EXISTS idmc_intake_function_backup(signature text PRIMARY KEY,definition text NOT NULL,captured_at timestamptz NOT NULL DEFAULT now());
INSERT INTO idmc_intake_function_backup(signature,definition) SELECT p.oid::regprocedure::text,pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('idmc_register_admitted','idmc_after_admission','idmc_set_result_window','idmc_cw_submit') ON CONFLICT(signature) DO NOTHING;
ALTER TABLE idmc_intake_function_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON idmc_intake_function_backup FROM PUBLIC,anon,authenticated;
GRANT ALL ON idmc_intake_function_backup TO service_role;
-- Explicit intake identity; never infer an intake or a level from elapsed time.
CREATE TABLE IF NOT EXISTS public.idmc_intakes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), academic_year_id uuid NOT NULL REFERENCES academic_years(id),
 code text NOT NULL CHECK(code IN ('MARCH','SEPTEMBER')), state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','SCHEDULED','OPEN','CLOSED')),
 opens_at timestamptz, closes_at timestamptz, changed_by uuid REFERENCES users(id), changed_at timestamptz NOT NULL DEFAULT now(), reason text,
 UNIQUE(academic_year_id,code),CHECK(state NOT IN ('SCHEDULED','OPEN') OR (opens_at IS NOT NULL AND closes_at>opens_at)));
ALTER TABLE applications ADD COLUMN IF NOT EXISTS intake_id uuid REFERENCES idmc_intakes(id);
ALTER TABLE students ADD COLUMN IF NOT EXISTS intake_id uuid REFERENCES idmc_intakes(id);
ALTER TABLE students ADD COLUMN IF NOT EXISTS current_level integer CHECK(current_level BETWEEN 4 AND 6);
ALTER TABLE students ADD COLUMN IF NOT EXISTS current_year_number integer CHECK(current_year_number>0);
ALTER TABLE students ADD COLUMN IF NOT EXISTS current_academic_year_id uuid REFERENCES academic_years(id);
ALTER TABLE students ADD COLUMN IF NOT EXISTS progression_state text;
CREATE INDEX IF NOT EXISTS idmc_app_intake ON applications(intake_id,applicant_id);
CREATE INDEX IF NOT EXISTS idmc_student_intake ON students(intake_id,programme_id);
CREATE TABLE IF NOT EXISTS idmc_academic_stages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), programme_id uuid NOT NULL REFERENCES programmes(id), programme_version_id uuid NOT NULL REFERENCES programme_versions(id),
 curriculum_id uuid NOT NULL REFERENCES curricula(id), level integer NOT NULL CHECK(level BETWEEN 4 AND 6), year_number integer NOT NULL CHECK(year_number>0),
 approved_by uuid NOT NULL REFERENCES users(id), approved_at timestamptz NOT NULL DEFAULT now(),UNIQUE(programme_version_id,level,year_number));
CREATE TABLE IF NOT EXISTS idmc_progression_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), from_stage_id uuid NOT NULL REFERENCES idmc_academic_stages(id), to_stage_id uuid REFERENCES idmc_academic_stages(id),
 target_year_id uuid NOT NULL REFERENCES academic_years(id), intake_code text NOT NULL CHECK(intake_code IN ('MARCH','SEPTEMBER')),
 min_gpa numeric CHECK(min_gpa BETWEEN 0 AND 5), automatic boolean NOT NULL DEFAULT false, completion boolean NOT NULL DEFAULT false,
 approved_by uuid NOT NULL REFERENCES users(id), approved_at timestamptz NOT NULL DEFAULT now(),reason text NOT NULL,
 UNIQUE(from_stage_id,target_year_id,intake_code),CHECK((completion AND to_stage_id IS NULL) OR (NOT completion AND to_stage_id IS NOT NULL AND to_stage_id<>from_stage_id)));
CREATE TABLE IF NOT EXISTS idmc_progression_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),student_id uuid NOT NULL REFERENCES students(id),rule_id uuid NOT NULL REFERENCES idmc_progression_rules(id),
 state text NOT NULL, blockers jsonb NOT NULL DEFAULT '[]',snapshot jsonb NOT NULL, decided_by uuid REFERENCES users(id),decided_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(student_id,rule_id));
CREATE TABLE IF NOT EXISTS idmc_intake_result_windows (
 offering_id uuid NOT NULL REFERENCES course_offerings(id),intake_code text NOT NULL CHECK(intake_code IN ('MARCH','SEPTEMBER')),
 is_open boolean NOT NULL, opens_at timestamptz NOT NULL,closes_at timestamptz NOT NULL,changed_by uuid NOT NULL REFERENCES users(id),changed_at timestamptz NOT NULL DEFAULT now(),reason text NOT NULL,
 PRIMARY KEY(offering_id,intake_code),CHECK(closes_at>opens_at));
CREATE TABLE IF NOT EXISTS idmc_progression_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid REFERENCES users(id),action text NOT NULL,entity_id uuid,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION idmc_ap_role(p_actor uuid,p_roles text[]) RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id JOIN users u ON u.id=ur.user_id WHERE ur.user_id=p_actor AND u.status='ACTIVE' AND ur.status='ACTIVE' AND r.status='ACTIVE' AND (ur.expires_at IS NULL OR ur.expires_at>now()) AND r.role_code=ANY(p_roles)) $$;
CREATE OR REPLACE FUNCTION idmc_intake_state(p_id uuid) RETURNS text LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT CASE WHEN state IN ('DRAFT','CLOSED') THEN state WHEN now()<opens_at THEN 'SCHEDULED' WHEN now()>=closes_at THEN 'CLOSED' ELSE 'OPEN' END FROM idmc_intakes WHERE id=p_id $$;
CREATE OR REPLACE FUNCTION idmc_intake_manage(p_data jsonb,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE x idmc_intakes;
BEGIN
 IF NOT idmc_ap_role(p_actor,ARRAY['ADMISSIONS_OFFICER']) THEN RAISE EXCEPTION 'Only Admissions may manage intake application windows' USING ERRCODE='42501'; END IF;
 INSERT INTO idmc_intakes(academic_year_id,code,state,opens_at,closes_at,changed_by,reason)
 VALUES((p_data->>'yearId')::uuid,p_data->>'code',p_data->>'state',(p_data->>'opensAt')::timestamptz,(p_data->>'closesAt')::timestamptz,p_actor,p_data->>'reason')
 ON CONFLICT(academic_year_id,code) DO UPDATE SET state=excluded.state,opens_at=excluded.opens_at,closes_at=excluded.closes_at,changed_by=p_actor,changed_at=now(),reason=excluded.reason RETURNING * INTO x;
 INSERT INTO idmc_progression_events(actor_id,action,entity_id,details) VALUES(p_actor,'INTAKE_WINDOW_CHANGED',x.id,to_jsonb(x)); RETURN to_jsonb(x);
END $$;
CREATE OR REPLACE FUNCTION idmc_application_intake_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE i idmc_intakes;
BEGIN
 IF TG_OP='UPDATE' AND NEW.intake_id IS DISTINCT FROM OLD.intake_id AND OLD.intake_id IS NOT NULL THEN RAISE EXCEPTION 'Application intake identity cannot be changed'; END IF;
 IF TG_OP='INSERT' OR NEW.intake_id IS DISTINCT FROM OLD.intake_id OR (NEW.status='SUBMITTED' AND OLD.status IS DISTINCT FROM NEW.status) THEN
 SELECT * INTO i FROM idmc_intakes WHERE id=NEW.intake_id FOR SHARE;
 IF i.id IS NULL OR i.academic_year_id<>NEW.academic_year_id OR (idmc_intake_state(i.id)<>'OPEN' AND NOT (TG_OP='UPDATE' AND OLD.intake_id IS NULL AND idmc_ap_role(nullif(current_setting('idmc.ap.classify_actor',true),'')::uuid,ARRAY['ADMISSIONS_OFFICER']))) THEN RAISE EXCEPTION 'Choose an open intake in the application academic year'; END IF;
 END IF;
 IF NEW.intake_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM idmc_intakes WHERE id=NEW.intake_id AND academic_year_id=NEW.academic_year_id) THEN RAISE EXCEPTION 'Academic year does not match the selected intake'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS idmc_application_intake ON applications;
CREATE TRIGGER idmc_application_intake BEFORE INSERT OR UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION idmc_application_intake_guard();
-- Serialize by applicant/intake/programme to prevent concurrent duplicate choices.
CREATE OR REPLACE FUNCTION idmc_intake_choice_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE app applications;
BEGIN
 SELECT * INTO app FROM applications WHERE id=NEW.application_id;
 IF app.intake_id IS NOT NULL THEN
 PERFORM pg_advisory_xact_lock(hashtextextended(app.applicant_id::text||app.intake_id::text||NEW.programme_id::text,0));
 IF EXISTS(SELECT 1 FROM application_choices c JOIN applications a ON a.id=c.application_id WHERE a.applicant_id=app.applicant_id AND a.intake_id=app.intake_id AND c.programme_id=NEW.programme_id AND c.id<>NEW.id AND a.status NOT IN ('CANCELLED','REJECTED')) THEN RAISE EXCEPTION 'An application already exists for this intake and programme'; END IF;
 END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS idmc_intake_choice ON application_choices;
CREATE TRIGGER idmc_intake_choice BEFORE INSERT OR UPDATE ON application_choices FOR EACH ROW EXECUTE FUNCTION idmc_intake_choice_guard();
CREATE OR REPLACE FUNCTION idmc_student_intake_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE intake uuid;st idmc_academic_stages;n int;year uuid;
BEGIN
 IF NEW.source_application_id IS NOT NULL THEN SELECT intake_id INTO intake FROM applications WHERE id=NEW.source_application_id; IF intake IS NOT NULL THEN
 IF NEW.intake_id IS NOT NULL AND NEW.intake_id<>intake THEN RAISE EXCEPTION 'Student intake must match the admission application'; END IF; NEW.intake_id:=intake; END IF; END IF;
 IF TG_OP='INSERT' AND NEW.current_level IS NULL AND NEW.intake_id IS NOT NULL THEN
 SELECT count(*) INTO n FROM idmc_academic_stages WHERE programme_id=NEW.programme_id AND programme_version_id=NEW.programme_version_id AND year_number=1 AND (NEW.curriculum_id IS NULL OR curriculum_id=NEW.curriculum_id);
 IF n=1 THEN SELECT * INTO st FROM idmc_academic_stages WHERE programme_id=NEW.programme_id AND programme_version_id=NEW.programme_version_id AND year_number=1 AND (NEW.curriculum_id IS NULL OR curriculum_id=NEW.curriculum_id);SELECT academic_year_id INTO year FROM idmc_intakes WHERE id=NEW.intake_id;NEW.current_level:=st.level;NEW.current_year_number:=st.year_number;NEW.curriculum_id:=st.curriculum_id;NEW.current_academic_year_id:=year;NEW.progression_state:='CONTINUING';END IF; END IF;
 IF TG_OP='UPDATE' AND OLD.intake_id IS NOT NULL AND NEW.intake_id IS DISTINCT FROM OLD.intake_id THEN RAISE EXCEPTION 'Student intake cannot change after admission'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS idmc_student_intake ON students;
CREATE TRIGGER idmc_student_intake BEFORE INSERT OR UPDATE ON students FOR EACH ROW EXECUTE FUNCTION idmc_student_intake_guard();
UPDATE students s SET intake_id=a.intake_id FROM applications a WHERE a.id=s.source_application_id AND s.intake_id IS NULL AND a.intake_id IS NOT NULL;
CREATE OR REPLACE FUNCTION idmc_ap_stage(p_data jsonb,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE x idmc_academic_stages;
BEGIN
 IF NOT idmc_ap_role(p_actor,ARRAY['ACADEMIC_OFFICER']) THEN RAISE EXCEPTION 'Only Academic may approve academic stages' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM curricula c JOIN programme_versions v ON v.id=c.programme_version_id WHERE c.id=(p_data->>'curriculumId')::uuid AND v.id=(p_data->>'versionId')::uuid AND v.programme_id=(p_data->>'programmeId')::uuid AND c.status='ACTIVE' AND v.status='ACTIVE') THEN RAISE EXCEPTION 'Curriculum, version and programme do not match or are not active'; END IF;
 IF EXISTS(SELECT 1 FROM programmes WHERE id=(p_data->>'programmeId')::uuid AND duration_years IS NOT NULL AND (p_data->>'yearNumber')::int>ceil(duration_years)) THEN RAISE EXCEPTION 'Stage year exceeds the approved programme duration';END IF;
 INSERT INTO idmc_academic_stages(programme_id,programme_version_id,curriculum_id,level,year_number,approved_by) VALUES((p_data->>'programmeId')::uuid,(p_data->>'versionId')::uuid,(p_data->>'curriculumId')::uuid,(p_data->>'level')::int,(p_data->>'yearNumber')::int,p_actor) RETURNING * INTO x;
 INSERT INTO idmc_progression_events(actor_id,action,entity_id,details) VALUES(p_actor,'STAGE_APPROVED',x.id,to_jsonb(x)); RETURN to_jsonb(x);
END $$;
CREATE OR REPLACE FUNCTION idmc_ap_rule(p_data jsonb,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE x idmc_progression_rules; f idmc_academic_stages;t idmc_academic_stages;
BEGIN
 IF NOT idmc_ap_role(p_actor,ARRAY['ACADEMIC_OFFICER']) THEN RAISE EXCEPTION 'Only Academic may approve progression rules' USING ERRCODE='42501'; END IF;
 SELECT * INTO f FROM idmc_academic_stages WHERE id=(p_data->>'fromStageId')::uuid; SELECT * INTO t FROM idmc_academic_stages WHERE id=(p_data->>'toStageId')::uuid;
 IF f.id IS NULL OR length(trim(coalesce(p_data->>'reason','')))<5 THEN RAISE EXCEPTION 'Choose the source stage and record the approved progression rule reason'; END IF;
 IF NOT coalesce((p_data->>'completion')::boolean,false) AND NOT EXISTS(SELECT 1 FROM semesters WHERE id=(p_data->>'targetSemesterId')::uuid AND academic_year_id=(p_data->>'targetYearId')::uuid) THEN RAISE EXCEPTION 'Select the target semester in the target academic year';END IF;
 IF NOT coalesce((p_data->>'completion')::boolean,false) AND (t.id IS NULL OR t.level<f.level OR (t.level=f.level AND t.year_number<=f.year_number)) THEN RAISE EXCEPTION 'Target stage must advance level or year; certificate transfer requires an explicit target programme stage'; END IF;
 INSERT INTO idmc_progression_rules(from_stage_id,to_stage_id,target_year_id,intake_code,min_gpa,automatic,completion,approved_by,reason,target_semester_id) VALUES(f.id,t.id,(p_data->>'targetYearId')::uuid,p_data->>'intakeCode',(p_data->>'minGpa')::numeric,coalesce((p_data->>'automatic')::boolean,false),coalesce((p_data->>'completion')::boolean,false),p_actor,p_data->>'reason',(p_data->>'targetSemesterId')::uuid) RETURNING * INTO x;
 INSERT INTO idmc_progression_events(actor_id,action,entity_id,details) VALUES(p_actor,'PROGRESSION_RULE_APPROVED',x.id,to_jsonb(x)); RETURN to_jsonb(x);
END $$;
CREATE OR REPLACE FUNCTION idmc_ap_position(p_data jsonb,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE s students; st idmc_academic_stages;i idmc_intakes;
BEGIN
 IF NOT idmc_ap_role(p_actor,ARRAY['ACADEMIC_OFFICER']) THEN RAISE EXCEPTION 'Only Academic may reconcile academic positions' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM students WHERE id=(p_data->>'studentId')::uuid FOR UPDATE;
 SELECT * INTO st FROM idmc_academic_stages WHERE id=(p_data->>'stageId')::uuid;
 SELECT * INTO i FROM idmc_intakes WHERE id=(p_data->>'intakeId')::uuid;
 IF s.id IS NULL OR st.programme_id<>s.programme_id OR st.id IS NULL OR i.id IS NULL OR NOT EXISTS(SELECT 1 FROM academic_years WHERE id=(p_data->>'yearId')::uuid) THEN RAISE EXCEPTION 'Student, programme stage, intake and academic year must be configured'; END IF;
 IF s.source_application_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM applications WHERE id=s.source_application_id AND intake_id=i.id) THEN RAISE EXCEPTION 'Admissions must classify the source application intake first';END IF;
 IF s.current_level IS NOT NULL THEN RAISE EXCEPTION 'Position already configured; use assessed progression rather than overwriting it'; END IF;
 IF s.curriculum_id IS NOT NULL AND s.curriculum_id<>st.curriculum_id THEN RAISE EXCEPTION 'Existing pinned curriculum differs; approve curriculum migration separately'; END IF;
 IF s.programme_version_id IS NOT NULL AND s.programme_version_id<>st.programme_version_id THEN RAISE EXCEPTION 'Existing pinned programme version differs'; END IF;
 PERFORM set_config('idmc.ap.actor',p_actor::text,true);
 UPDATE students SET intake_id=i.id,current_level=st.level,current_year_number=st.year_number,current_academic_year_id=(p_data->>'yearId')::uuid,programme_version_id=st.programme_version_id,curriculum_id=st.curriculum_id,progression_state='CONTINUING',updated_at=now() WHERE id=s.id RETURNING * INTO s;
 INSERT INTO idmc_progression_events(actor_id,action,entity_id,details) VALUES(p_actor,'POSITION_RECONCILED',s.id,jsonb_build_object('position',to_jsonb(s),'reason',p_data->>'reason')); RETURN to_jsonb(s);
END $$;
CREATE OR REPLACE FUNCTION idmc_ap_window(p_data jsonb,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE x idmc_intake_result_windows;dept uuid;
BEGIN
 SELECT p.department_id INTO dept FROM course_offerings o JOIN programmes p ON p.id=o.programme_id WHERE o.id=(p_data->>'offeringId')::uuid;
 IF NOT idmc_ap_role(p_actor,ARRAY['ACADEMIC_OFFICER']) AND NOT (idmc_ap_role(p_actor,ARRAY['HOD','DEPUTY_HOD']) AND idmc_hod_department(p_actor,dept)) THEN RAISE EXCEPTION 'Only Academic or the programme department HOD may manage this window' USING ERRCODE='42501'; END IF;
 IF length(trim(coalesce(p_data->>'reason','')))<5 THEN RAISE EXCEPTION 'Window change reason is required'; END IF;
 INSERT INTO idmc_intake_result_windows(offering_id,intake_code,is_open,opens_at,closes_at,changed_by,reason) VALUES((p_data->>'offeringId')::uuid,p_data->>'intakeCode',(p_data->>'open')::boolean,(p_data->>'opensAt')::timestamptz,(p_data->>'closesAt')::timestamptz,p_actor,p_data->>'reason')
 ON CONFLICT(offering_id,intake_code) DO UPDATE SET is_open=excluded.is_open,opens_at=excluded.opens_at,closes_at=excluded.closes_at,changed_by=p_actor,changed_at=now(),reason=excluded.reason RETURNING * INTO x;
 -- Keep the existing per-offering entry guard in effect as well.
 PERFORM idmc_set_result_window(x.offering_id,EXISTS(SELECT 1 FROM idmc_intake_result_windows WHERE offering_id=x.offering_id AND is_open),p_actor);
 INSERT INTO idmc_progression_events(actor_id,action,entity_id,details) VALUES(p_actor,'INTAKE_RESULT_WINDOW_CHANGED',x.offering_id,to_jsonb(x)); RETURN to_jsonb(x);
END $$;
CREATE OR REPLACE FUNCTION idmc_ap_marks_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE oid uuid;sid uuid;code text;
BEGIN
 IF TG_TABLE_NAME='course_results' THEN
 IF TG_OP='UPDATE' AND NEW.coursework_mark IS NOT DISTINCT FROM OLD.coursework_mark AND NEW.examination_mark IS NOT DISTINCT FROM OLD.examination_mark AND NEW.result_status<>'SUBMITTED' THEN RETURN NEW; END IF; oid:=NEW.course_offering_id;
 ELSIF TG_TABLE_NAME='assessment_marks' THEN SELECT course_offering_id INTO oid FROM assessments WHERE id=NEW.assessment_id;
 ELSE SELECT course_offering_id INTO oid FROM examination_papers WHERE id=NEW.examination_paper_id; END IF;
 sid:=NEW.student_id;
 SELECT i.code INTO code FROM students s JOIN idmc_intakes i ON i.id=s.intake_id WHERE s.id=sid;
 IF code IS NULL OR NOT EXISTS(SELECT 1 FROM idmc_intake_result_windows w WHERE w.offering_id=oid AND w.intake_code=code AND w.is_open AND now()>=w.opens_at AND now()<w.closes_at) THEN RAISE EXCEPTION 'The result entry window for this student intake is closed or the intake is unclassified'; END IF;
 IF NOT EXISTS(SELECT 1 FROM course_registrations WHERE student_id=sid AND course_offering_id=oid AND registration_status IN ('REGISTERED','APPROVED')) THEN RAISE EXCEPTION 'Student is not registered in this offering'; END IF;
 RETURN NEW;
END $$;
DO $$DECLARE tab text;BEGIN FOREACH tab IN ARRAY ARRAY['assessment_marks','examination_marks','course_results'] LOOP EXECUTE format('DROP TRIGGER IF EXISTS idmc_ap_intake_marks ON %I',tab);EXECUTE format('CREATE TRIGGER idmc_ap_intake_marks BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION idmc_ap_marks_guard()',tab);END LOOP;END $$;
CREATE TABLE IF NOT EXISTS idmc_academic_year_schedule(academic_year_id uuid PRIMARY KEY REFERENCES academic_years(id),approved_by uuid NOT NULL REFERENCES users(id),reason text NOT NULL,activated_at timestamptz);
CREATE TABLE IF NOT EXISTS idmc_academic_assignment_queue(student_id uuid REFERENCES students(id),semester_id uuid REFERENCES semesters(id),actor_id uuid NOT NULL REFERENCES users(id),state text NOT NULL DEFAULT 'PENDING',error text,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(student_id,semester_id));
ALTER TABLE idmc_progression_rules ADD COLUMN IF NOT EXISTS target_semester_id uuid REFERENCES semesters(id);
CREATE OR REPLACE FUNCTION idmc_ap_schedule(p_year uuid,p_actor uuid,p_reason text) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF NOT idmc_ap_role(p_actor,ARRAY['ACADEMIC_OFFICER']) THEN RAISE EXCEPTION 'Only Academic may schedule academic year activation' USING ERRCODE='42501';END IF;
 IF length(trim(coalesce(p_reason,'')))<5 OR NOT EXISTS(SELECT 1 FROM academic_years WHERE id=p_year AND status='PLANNED') THEN RAISE EXCEPTION 'Choose a planned academic year and record a reason';END IF;
 INSERT INTO idmc_academic_year_schedule VALUES(p_year,p_actor,p_reason,NULL) ON CONFLICT(academic_year_id) DO UPDATE SET approved_by=p_actor,reason=p_reason;
 INSERT INTO idmc_progression_events(actor_id,action,entity_id,details) VALUES(p_actor,'YEAR_ACTIVATION_SCHEDULED',p_year,jsonb_build_object('reason',p_reason));
END $$;
CREATE OR REPLACE FUNCTION idmc_ap_calendar_tick() RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE y record;q record;x jsonb;count int:=0;
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('IDMC_ACADEMIC_CALENDAR_TICK',0)) THEN RETURN jsonb_build_object('busy',true);END IF;
 FOR y IN SELECT ay.*,sch.approved_by FROM academic_years ay JOIN idmc_academic_year_schedule sch ON sch.academic_year_id=ay.id WHERE ay.status='PLANNED' AND sch.activated_at IS NULL AND ay.start_date<=current_date AND ay.end_date>=current_date ORDER BY ay.start_date,ay.id LOOP
 IF NOT idmc_ap_role(y.approved_by,ARRAY['ACADEMIC_OFFICER']) THEN CONTINUE;END IF;
 UPDATE academic_years SET status='CLOSED',updated_at=now() WHERE status='ACTIVE' AND end_date<y.start_date;
 UPDATE academic_years SET status='ACTIVE',updated_at=now() WHERE id=y.id;
 UPDATE idmc_academic_year_schedule SET activated_at=now() WHERE academic_year_id=y.id;
 INSERT INTO idmc_progression_events(actor_id,action,entity_id,details) VALUES(y.approved_by,'YEAR_ACTIVATED',y.id,jsonb_build_object('startDate',y.start_date));
 END LOOP;
 x:=idmc_ap_tick(50);
 FOR q IN SELECT * FROM idmc_academic_assignment_queue WHERE state='PENDING' ORDER BY updated_at LIMIT 50 FOR UPDATE SKIP LOCKED LOOP
 BEGIN
 PERFORM idmc_ap_assign(q.student_id,q.semester_id,q.actor_id);
 UPDATE idmc_academic_assignment_queue SET state='ASSIGNED',error=NULL,updated_at=now() WHERE student_id=q.student_id AND semester_id=q.semester_id;count:=count+1;
 EXCEPTION WHEN OTHERS THEN UPDATE idmc_academic_assignment_queue SET error=SQLERRM,updated_at=now() WHERE student_id=q.student_id AND semester_id=q.semester_id;END;
 END LOOP;
 RETURN jsonb_build_object('progression',x,'assigned',count);
END $$;
CREATE OR REPLACE FUNCTION idmc_ap_queue_position() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE actor uuid;sem uuid;st idmc_academic_stages;
BEGIN
 IF NEW.student_status='ACTIVE' AND NEW.current_level IS NOT NULL AND NEW.progression_state NOT IN ('PROGRESSION_PENDING','ACADEMIC_HOLD','COMPLETION_READY') AND (TG_OP='INSERT' OR NEW.current_academic_year_id IS DISTINCT FROM OLD.current_academic_year_id OR (OLD.current_level IS NULL AND NEW.current_level IS NOT NULL) OR NEW.student_status IS DISTINCT FROM OLD.student_status) THEN
 SELECT r.target_semester_id,r.approved_by INTO sem,actor FROM idmc_progression_rules r JOIN idmc_progression_decisions d ON d.rule_id=r.id WHERE d.student_id=NEW.id AND r.target_year_id=NEW.current_academic_year_id AND d.state='PROMOTED' ORDER BY d.decided_at DESC LIMIT 1;
 IF sem IS NULL AND NEW.progression_state='PROMOTED' THEN RETURN NEW;END IF;
 IF sem IS NULL THEN SELECT approved_by INTO actor FROM idmc_academic_stages WHERE curriculum_id=NEW.curriculum_id AND programme_version_id=NEW.programme_version_id AND level=NEW.current_level AND year_number=NEW.current_year_number;SELECT id INTO sem FROM semesters WHERE academic_year_id=NEW.current_academic_year_id AND semester_number=1;END IF;
 IF sem IS NOT NULL AND actor IS NOT NULL THEN INSERT INTO idmc_academic_assignment_queue(student_id,semester_id,actor_id) VALUES(NEW.id,sem,actor) ON CONFLICT DO NOTHING;END IF;
 END IF;RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS idmc_ap_queue_position ON students;
CREATE TRIGGER idmc_ap_queue_position AFTER INSERT OR UPDATE ON students FOR EACH ROW EXECUTE FUNCTION idmc_ap_queue_position();
CREATE OR REPLACE FUNCTION idmc_ap_registration_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE s students;reg student_registrations;o course_offerings;sem semesters;
BEGIN
 IF NEW.registration_type<>'NORMAL' OR NEW.registration_status IN ('DROPPED','REJECTED','CANCELLED') THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' AND NEW.course_id=OLD.course_id AND NEW.course_offering_id IS NOT DISTINCT FROM OLD.course_offering_id AND NEW.student_id=OLD.student_id AND NEW.registration_status=OLD.registration_status THEN RETURN NEW;END IF;
 SELECT * INTO s FROM students WHERE id=NEW.student_id;SELECT * INTO reg FROM student_registrations WHERE id=NEW.student_registration_id;SELECT * INTO o FROM course_offerings WHERE id=NEW.course_offering_id;SELECT * INTO sem FROM semesters WHERE id=reg.semester_id;
 IF s.current_level IS NULL THEN RAISE EXCEPTION 'Academic position is not reconciled; do not infer level from academic year';END IF;
 IF reg.student_id<>s.id OR reg.programme_id<>s.programme_id OR reg.programme_version_id IS DISTINCT FROM s.programme_version_id OR reg.academic_year_id IS DISTINCT FROM s.current_academic_year_id OR s.progression_state IN ('PROGRESSION_PENDING','ACADEMIC_HOLD','COMPLETION_READY') OR s.student_status<>'ACTIVE' THEN RAISE EXCEPTION 'Registration does not match the student current academic position';END IF;
 IF o.id IS NULL OR o.course_id<>NEW.course_id OR o.semester_id<>sem.id OR o.programme_id<>s.programme_id OR o.programme_version_id IS DISTINCT FROM s.programme_version_id THEN RAISE EXCEPTION 'Offering does not match the pinned programme version and semester';END IF;
 IF EXISTS(SELECT 1 FROM course_results cr JOIN course_offerings off ON off.id=cr.course_offering_id WHERE cr.student_id=s.id AND off.course_id=NEW.course_id AND cr.result_status IN ('PUBLISHED','LOCKED') AND cr.pass_status='PASS') THEN RAISE EXCEPTION 'Completed course cannot be registered again without an approved repeat workflow';END IF;
 IF NOT EXISTS(SELECT 1 FROM curriculum_courses cc JOIN courses c ON c.id=cc.course_id WHERE cc.curriculum_id=s.curriculum_id AND cc.course_id=NEW.course_id AND cc.year_number=s.current_year_number AND cc.semester_number=sem.semester_number AND c.level=s.current_level::text) THEN RAISE EXCEPTION 'Course is outside the pinned curriculum level, year or semester';END IF;RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS idmc_ap_registration ON course_registrations;
CREATE TRIGGER idmc_ap_registration BEFORE INSERT OR UPDATE ON course_registrations FOR EACH ROW EXECUTE FUNCTION idmc_ap_registration_guard();
ALTER TABLE idmc_academic_year_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE idmc_academic_assignment_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON idmc_academic_year_schedule,idmc_academic_assignment_queue FROM PUBLIC,anon,authenticated;
GRANT ALL ON idmc_academic_year_schedule,idmc_academic_assignment_queue TO service_role;

CREATE TABLE IF NOT EXISTS idmc_progression_exceptions(student_id uuid NOT NULL REFERENCES students(id),rule_id uuid NOT NULL REFERENCES idmc_progression_rules(id),course_id uuid NOT NULL REFERENCES courses(id),result_id uuid NOT NULL REFERENCES course_results(id),approved_by uuid NOT NULL REFERENCES users(id),reason text NOT NULL,approved_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(student_id,rule_id,course_id));
ALTER TABLE idmc_progression_exceptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON idmc_progression_exceptions FROM PUBLIC,anon,authenticated;
GRANT ALL ON idmc_progression_exceptions TO service_role;
CREATE OR REPLACE FUNCTION idmc_ap_exception(p_student uuid,p_rule uuid,p_course uuid,p_actor uuid,p_reason text) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
DECLARE r course_results;preview jsonb;
BEGIN
 IF NOT idmc_ap_role(p_actor,ARRAY['ACADEMIC_OFFICER']) THEN RAISE EXCEPTION 'Only Academic may authorise a progression exception' USING ERRCODE='42501';END IF;
 IF length(trim(coalesce(p_reason,'')))<10 THEN RAISE EXCEPTION 'Record the academic authority and reason for the exception';END IF;
 PERFORM 1 FROM students WHERE id=p_student FOR UPDATE;
 preview:=idmc_ap_preview(p_student,p_rule);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(preview->'blockers') b WHERE b->>'kind'='FAILED_OR_INCOMPLETE' AND b->>'courseId'=p_course::text) THEN RAISE EXCEPTION 'Exception must refer to a reported failed course; missing or unapproved results cannot be bypassed';END IF;
 SELECT cr.* INTO r FROM course_results cr JOIN course_offerings o ON o.id=cr.course_offering_id WHERE cr.student_id=p_student AND o.course_id=p_course ORDER BY (SELECT start_date FROM academic_years WHERE id=o.academic_year_id) DESC,cr.updated_at DESC LIMIT 1 FOR SHARE OF cr;
 IF r.result_status NOT IN ('PUBLISHED','LOCKED') OR r.pass_status NOT IN ('FAIL','SUPPLEMENTARY') THEN RAISE EXCEPTION 'Only a published failed or supplementary result can receive a documented exception';END IF;
 INSERT INTO idmc_progression_exceptions VALUES(p_student,p_rule,p_course,r.id,p_actor,p_reason,now()) ON CONFLICT(student_id,rule_id,course_id) DO UPDATE SET result_id=r.id,reason=p_reason,approved_by=p_actor,approved_at=now();
 INSERT INTO idmc_progression_events(actor_id,action,entity_id,details) VALUES(p_actor,'PROGRESSION_EXCEPTION_APPROVED',p_student,jsonb_build_object('ruleId',p_rule,'courseId',p_course,'result',to_jsonb(r),'reason',p_reason));
END $$;
CREATE OR REPLACE FUNCTION idmc_ap_migrate_curriculum(p_student uuid,p_stage uuid,p_actor uuid,p_reason text) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
DECLARE s students;t idmc_academic_stages;
BEGIN
 IF NOT idmc_ap_role(p_actor,ARRAY['ACADEMIC_OFFICER']) THEN RAISE EXCEPTION 'Only Academic may approve a curriculum version migration' USING ERRCODE='42501';END IF;
 SELECT * INTO s FROM students WHERE id=p_student FOR UPDATE;SELECT * INTO t FROM idmc_academic_stages WHERE id=p_stage;
 IF t.programme_id IS DISTINCT FROM s.programme_id OR t.level IS DISTINCT FROM s.current_level OR t.year_number IS DISTINCT FROM s.current_year_number OR t.id IS NULL OR length(trim(coalesce(p_reason,'')))<10 THEN RAISE EXCEPTION 'Migration must retain the current programme, level and study year and record authority';END IF;
 IF NOT EXISTS(SELECT 1 FROM curricula WHERE id=t.curriculum_id AND status='ACTIVE') THEN RAISE EXCEPTION 'Target curriculum must be active';END IF;
 PERFORM set_config('idmc.ap.actor',p_actor::text,true);
 UPDATE students SET programme_version_id=t.programme_version_id,curriculum_id=t.curriculum_id,updated_at=now() WHERE id=s.id;
 INSERT INTO idmc_progression_events(actor_id,action,entity_id,details) VALUES(p_actor,'CURRICULUM_VERSION_MIGRATION_APPROVED',s.id,jsonb_build_object('previous',to_jsonb(s),'target',to_jsonb(t),'reason',p_reason));
END $$;
CREATE OR REPLACE FUNCTION idmc_after_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE sid uuid;sem uuid;x jsonb;
BEGIN
 IF NEW.status='CONVERTED_TO_STUDENT' AND OLD.status IS DISTINCT FROM NEW.status THEN
 SELECT id INTO sid FROM students WHERE source_application_id=NEW.id;
 IF sid IS NOT NULL THEN
 INSERT INTO idmc_admission_registration_queue(student_id,academic_year_id) VALUES(sid,NEW.academic_year_id) ON CONFLICT DO NOTHING;
 BEGIN
 SELECT id INTO sem FROM semesters WHERE academic_year_id=NEW.academic_year_id AND semester_number=1;
 IF sem IS NULL THEN RAISE EXCEPTION 'Configure admission semester 1';END IF;
 x:=idmc_register_admitted(sid,NEW.academic_year_id,sem,NEW.reviewed_by);
 UPDATE idmc_admission_registration_queue SET status=CASE WHEN x->>'status' IN ('REGISTERED','LOCKED') THEN 'REGISTERED' ELSE 'COURSE_SELECTION_READY' END,last_error=CASE WHEN x->>'status' NOT IN ('REGISTERED','LOCKED') THEN 'Curriculum courses selected. Existing registration approval and finance clearance remain required.' END,updated_at=now() WHERE student_id=sid;
 EXCEPTION WHEN OTHERS THEN UPDATE idmc_admission_registration_queue SET status='PENDING',last_error=SQLERRM,updated_at=now() WHERE student_id=sid;END;
 END IF;END IF;RETURN NEW;
END $$;

-- Preview reads all compulsory curriculum requirements, not only courses already registered.
CREATE OR REPLACE FUNCTION idmc_ap_preview(p_student uuid,p_rule uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE s students; r idmc_progression_rules;st idmc_academic_stages;c record;res course_results;issues jsonb:='[]';total numeric:=0;points numeric:=0;n int:=0;i text;target academic_years;
BEGIN
 SELECT * INTO s FROM students WHERE id=p_student;SELECT * INTO r FROM idmc_progression_rules WHERE id=p_rule;SELECT * INTO st FROM idmc_academic_stages WHERE id=r.from_stage_id;SELECT * INTO target FROM academic_years WHERE id=r.target_year_id;
 SELECT code INTO i FROM idmc_intakes WHERE id=s.intake_id;
 IF s.id IS NULL OR st.id IS NULL OR s.current_level IS DISTINCT FROM st.level OR s.current_year_number IS DISTINCT FROM st.year_number OR s.curriculum_id IS DISTINCT FROM st.curriculum_id OR s.programme_version_id IS DISTINCT FROM st.programme_version_id OR s.programme_id IS DISTINCT FROM st.programme_id OR i IS DISTINCT FROM r.intake_code THEN RETURN jsonb_build_object('eligible',false,'state','NOT_APPLICABLE','blockers',jsonb_build_array(jsonb_build_object('kind','POSITION_OR_INTAKE_MISMATCH'))); END IF;
 IF s.student_status<>'ACTIVE' THEN issues:=issues||jsonb_build_array(jsonb_build_object('kind','STUDENT_NOT_ACTIVE','status',s.student_status)); END IF;
 IF s.current_academic_year_id IS NULL OR target.start_date<=(SELECT start_date FROM academic_years WHERE id=s.current_academic_year_id) THEN issues:=issues||jsonb_build_array(jsonb_build_object('kind','TARGET_YEAR_NOT_LATER'));END IF;
 FOR c IN SELECT cm.id,cm.course_code,cc.semester_number,coalesce(cc.credit_units,cm.credit_units) credits FROM curriculum_courses cc JOIN courses cm ON cm.id=cc.course_id WHERE cc.curriculum_id=st.curriculum_id AND cc.year_number=st.year_number AND cc.is_compulsory AND cm.level=st.level::text LOOP
 n:=n+1;
 SELECT cr.* INTO res FROM course_results cr JOIN course_offerings o ON o.id=cr.course_offering_id WHERE cr.student_id=s.id AND o.course_id=c.id AND ((o.academic_year_id=s.current_academic_year_id AND (SELECT semester_number FROM semesters WHERE id=o.semester_id)=c.semester_number) OR (SELECT start_date FROM academic_years WHERE id=o.academic_year_id)<(SELECT start_date FROM academic_years WHERE id=s.current_academic_year_id)) ORDER BY (SELECT start_date FROM academic_years WHERE id=o.academic_year_id) DESC,cr.updated_at DESC,cr.id LIMIT 1;
 IF res.id IS NULL THEN issues:=issues||jsonb_build_array(jsonb_build_object('kind','MISSING_RESULT','courseCode',c.course_code));
 ELSIF res.result_status NOT IN ('PUBLISHED','LOCKED') THEN issues:=issues||jsonb_build_array(jsonb_build_object('kind','AWAITING_APPROVAL','courseCode',c.course_code,'status',res.result_status));
 ELSIF res.pass_status<>'PASS' OR res.pass_status IS NULL THEN
 IF EXISTS(SELECT 1 FROM idmc_progression_exceptions ex WHERE ex.student_id=s.id AND ex.rule_id=p_rule AND ex.course_id=c.id AND ex.result_id=res.id) AND res.pass_status IN ('FAIL','SUPPLEMENTARY') THEN total:=total+c.credits;points:=points+coalesce(res.grade_point,0)*c.credits;
 ELSE issues:=issues||jsonb_build_array(jsonb_build_object('kind','FAILED_OR_INCOMPLETE','courseCode',c.course_code,'courseId',c.id));END IF;
 ELSIF res.grade_point IS NULL THEN issues:=issues||jsonb_build_array(jsonb_build_object('kind','MISSING_GRADE_POINT','courseCode',c.course_code));
 ELSE total:=total+c.credits;points:=points+res.grade_point*c.credits; END IF;
 END LOOP;
 IF n=0 THEN issues:=issues||jsonb_build_array(jsonb_build_object('kind','NO_APPROVED_REQUIRED_COURSES')); END IF;
 IF EXISTS(SELECT 1 FROM curriculum_courses cc JOIN courses cm ON cm.id=cc.course_id WHERE cc.curriculum_id=st.curriculum_id AND cc.year_number=st.year_number AND cc.is_compulsory AND (cm.level IS NULL OR cm.level<>st.level::text)) THEN issues:=issues||jsonb_build_array(jsonb_build_object('kind','CURRICULUM_LEVEL_MISMATCH'));END IF;
 IF EXISTS(SELECT 1 FROM curriculum_courses WHERE curriculum_id=st.curriculum_id AND is_compulsory AND year_number IS NULL) THEN issues:=issues||jsonb_build_array(jsonb_build_object('kind','CURRICULUM_YEAR_UNCLASSIFIED')); END IF;
 IF r.min_gpa IS NOT NULL AND (total=0 OR points/nullif(total,0)<r.min_gpa) THEN issues:=issues||jsonb_build_array(jsonb_build_object('kind','GPA_BELOW_APPROVED_MINIMUM','gpa',points/nullif(total,0),'minimum',r.min_gpa)); END IF;
 IF EXISTS(SELECT 1 FROM idmc_cw_request req WHERE req.student_id=s.id AND req.status IN ('PENDING','APPROVED') AND NOT EXISTS(SELECT 1 FROM idmc_progression_exceptions ex JOIN course_offerings o ON o.course_id=ex.course_id WHERE ex.student_id=s.id AND ex.rule_id=p_rule AND o.id=req.offering_id AND req.kind IN ('CARRY_OVER','REPEAT'))) THEN issues:=issues||jsonb_build_array(jsonb_build_object('kind','OPEN_REPEAT_RESIT_OR_SPECIAL_REQUEST')); END IF;
 RETURN jsonb_build_object('eligible',jsonb_array_length(issues)=0,'state',CASE WHEN jsonb_array_length(issues)=0 THEN 'ELIGIBLE' ELSE 'PROGRESSION_PENDING' END,'blockers',issues,'gpa',points/nullif(total,0),'requiredCourses',n,'snapshot',to_jsonb(s));
END $$;
CREATE OR REPLACE FUNCTION idmc_ap_progress(p_student uuid,p_rule uuid,p_actor uuid,p_automatic boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE s students;r idmc_progression_rules;t idmc_academic_stages;preview jsonb;decision idmc_progression_decisions;
BEGIN
 IF NOT idmc_ap_role(p_actor,ARRAY['ACADEMIC_OFFICER']) THEN RAISE EXCEPTION 'Only Academic may perform progression' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM students WHERE id=p_student FOR UPDATE;SELECT * INTO r FROM idmc_progression_rules WHERE id=p_rule FOR SHARE;
 SELECT * INTO decision FROM idmc_progression_decisions WHERE student_id=p_student AND rule_id=p_rule;
 IF decision.state IN ('PROMOTED','COMPLETION_READY') THEN RETURN to_jsonb(decision); END IF;
 IF p_automatic AND NOT r.automatic THEN RAISE EXCEPTION 'Rule not approved for automatic progression';END IF;
 IF NOT EXISTS(SELECT 1 FROM academic_years WHERE id=r.target_year_id AND status='ACTIVE' AND start_date<=current_date AND end_date>=current_date) THEN RAISE EXCEPTION 'Target academic year must be active and started'; END IF;
 -- Lock relevant published evidence so concurrent result changes cannot race the decision.
 PERFORM 1 FROM course_results WHERE student_id=p_student AND academic_year_id=s.current_academic_year_id FOR SHARE;
 preview:=idmc_ap_preview(p_student,p_rule);
 IF preview->>'state'='NOT_APPLICABLE' THEN RAISE EXCEPTION 'Student does not match the approved source stage and intake'; END IF;
 PERFORM set_config('idmc.ap.actor',p_actor::text,true);
 IF (preview->>'eligible')::boolean THEN
 SELECT * INTO t FROM idmc_academic_stages WHERE id=r.to_stage_id;
 UPDATE students SET programme_id=CASE WHEN r.completion THEN programme_id ELSE t.programme_id END,programme_version_id=CASE WHEN r.completion THEN programme_version_id ELSE t.programme_version_id END,curriculum_id=CASE WHEN r.completion THEN curriculum_id ELSE t.curriculum_id END,current_level=CASE WHEN r.completion THEN current_level ELSE t.level END,current_year_number=CASE WHEN r.completion THEN current_year_number ELSE t.year_number END,current_academic_year_id=CASE WHEN r.completion THEN current_academic_year_id ELSE r.target_year_id END,progression_state=CASE WHEN r.completion THEN 'COMPLETION_READY' ELSE 'PROMOTED' END,updated_at=now() WHERE id=p_student;
 ELSE UPDATE students SET progression_state='PROGRESSION_PENDING',updated_at=now() WHERE id=p_student; END IF;
 INSERT INTO idmc_progression_decisions(student_id,rule_id,state,blockers,snapshot,decided_by) VALUES(p_student,p_rule,CASE WHEN (preview->>'eligible')::boolean THEN CASE WHEN r.completion THEN 'COMPLETION_READY' ELSE 'PROMOTED' END ELSE 'PROGRESSION_PENDING' END,preview->'blockers',to_jsonb(s),p_actor)
 ON CONFLICT(student_id,rule_id) DO UPDATE SET state=excluded.state,blockers=excluded.blockers,decided_by=p_actor,decided_at=now() RETURNING * INTO decision;
 IF decision.state='PROMOTED' AND r.target_semester_id IS NOT NULL THEN INSERT INTO idmc_academic_assignment_queue(student_id,semester_id,actor_id) VALUES(p_student,r.target_semester_id,p_actor) ON CONFLICT DO NOTHING;END IF;
 INSERT INTO idmc_progression_events(actor_id,action,entity_id,details) VALUES(p_actor,'PROGRESSION_ASSESSED',p_student,jsonb_build_object('decision',to_jsonb(decision),'rule',to_jsonb(r),'preview',preview)); RETURN to_jsonb(decision);
END $$;
CREATE OR REPLACE FUNCTION idmc_ap_assign(p_student uuid,p_semester uuid,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE s students;sem semesters;st idmc_academic_stages;reg student_registrations;c record;offering uuid;n int;total numeric:=0;cnt int:=0;
BEGIN
 IF NOT idmc_ap_role(p_actor,ARRAY['ACADEMIC_OFFICER','ADMISSIONS_OFFICER']) THEN RAISE EXCEPTION 'Only Academic or Admissions may assign eligible curriculum courses' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM students WHERE id=p_student FOR UPDATE;SELECT * INTO sem FROM semesters WHERE id=p_semester;
 SELECT * INTO st FROM idmc_academic_stages WHERE programme_version_id=s.programme_version_id AND curriculum_id=s.curriculum_id AND level=s.current_level AND year_number=s.current_year_number;
 IF st.id IS NULL OR s.student_status<>'ACTIVE' OR s.progression_state IN ('PROGRESSION_PENDING','ACADEMIC_HOLD','COMPLETION_READY') OR s.intake_id IS NULL OR s.current_academic_year_id IS DISTINCT FROM sem.academic_year_id THEN RAISE EXCEPTION 'Reconcile intake, current academic position and approved progression before course assignment'; END IF;
 SELECT * INTO reg FROM student_registrations WHERE student_id=p_student AND semester_id=p_semester FOR UPDATE;
 IF reg.id IS NOT NULL AND reg.registration_status IN ('LOCKED','CANCELLED','REJECTED') THEN RAISE EXCEPTION 'Registration is locked or cancelled; retain existing history';END IF;
 SELECT coalesce(sum(coalesce(cc.credit_units,cm.credit_units)),0) INTO total FROM curriculum_courses cc JOIN courses cm ON cm.id=cc.course_id WHERE cc.curriculum_id=st.curriculum_id AND cc.year_number=st.year_number AND cc.semester_number=sem.semester_number AND cm.level=st.level::text AND cc.is_compulsory AND cm.status='ACTIVE';
 IF total<=0 THEN RAISE EXCEPTION 'No approved required courses for the student level and semester';END IF;
 IF reg.id IS NULL THEN INSERT INTO student_registrations(student_id,academic_year_id,semester_id,programme_id,programme_version_id,registration_number,maximum_credits,created_by,updated_by) VALUES(s.id,sem.academic_year_id,sem.id,s.programme_id,s.programme_version_id,'REG-'||gen_random_uuid(),total,p_actor,p_actor) RETURNING * INTO reg; END IF;
 FOR c IN SELECT cc.*,coalesce(cc.credit_units,cm.credit_units) credits FROM curriculum_courses cc JOIN courses cm ON cm.id=cc.course_id WHERE cc.curriculum_id=st.curriculum_id AND cc.year_number=st.year_number AND cc.semester_number=sem.semester_number AND cm.level=st.level::text AND cm.status='ACTIVE' AND cc.is_compulsory LOOP
 IF EXISTS(SELECT 1 FROM course_results cr JOIN course_offerings o ON o.id=cr.course_offering_id WHERE cr.student_id=s.id AND o.course_id=c.course_id AND cr.result_status IN ('PUBLISHED','LOCKED') AND cr.pass_status='PASS') THEN CONTINUE; END IF;
 IF EXISTS(SELECT 1 FROM course_prerequisites pr WHERE pr.course_id=c.course_id AND NOT EXISTS(SELECT 1 FROM course_results cr JOIN course_offerings o ON o.id=cr.course_offering_id WHERE cr.student_id=s.id AND o.course_id=pr.prerequisite_course_id AND cr.result_status IN ('PUBLISHED','LOCKED') AND cr.pass_status='PASS')) THEN RAISE EXCEPTION 'Prerequisite not completed for course %',c.course_id;END IF;
 SELECT count(*),min(id::text)::uuid INTO n,offering FROM course_offerings WHERE academic_year_id=sem.academic_year_id AND semester_id=sem.id AND course_id=c.course_id AND programme_id=s.programme_id AND programme_version_id=s.programme_version_id AND status IN ('OPEN','CLOSED');
 IF n<>1 THEN RAISE EXCEPTION 'Course % requires exactly one offering for the pinned programme version and period; found %',c.course_id,n; END IF;
 INSERT INTO course_registrations(student_registration_id,student_id,course_id,course_offering_id,credits,is_core,is_elective,registration_status,prerequisite_status,eligibility_status,created_by,updated_by)
 VALUES(reg.id,s.id,c.course_id,offering,c.credits,c.course_category='CORE',false,'SELECTED','PASSED','ELIGIBLE',p_actor,p_actor) ON CONFLICT(student_registration_id,course_id) WHERE registration_status NOT IN ('DROPPED','REJECTED','CANCELLED') DO NOTHING;cnt:=cnt+1;
 END LOOP;
 SELECT coalesce(sum(credits),0) INTO total FROM course_registrations WHERE student_registration_id=reg.id AND registration_status NOT IN ('DROPPED','REJECTED','CANCELLED');
 IF total>reg.maximum_credits THEN RAISE EXCEPTION 'Assigned credits exceed the approved registration maximum';END IF;
 UPDATE student_registrations SET total_registered_credits=total,updated_at=now(),updated_by=p_actor WHERE id=reg.id;
 INSERT INTO idmc_progression_events(actor_id,action,entity_id,details) VALUES(p_actor,'CURRICULUM_COURSES_ASSIGNED',s.id,jsonb_build_object('registrationId',reg.id,'courses',cnt,'credits',total)); RETURN jsonb_build_object('registrationId',reg.id,'eligibleCourses',cnt,'credits',total,'status',reg.registration_status);
END $$;
-- Safely replace the first-year/latest-curriculum shortcut with the pinned academic position workflow.
CREATE OR REPLACE FUNCTION idmc_register_admitted(p_student uuid,p_year uuid,p_semester uuid,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
BEGIN IF NOT EXISTS(SELECT 1 FROM students WHERE id=p_student AND current_academic_year_id=p_year) THEN RAISE EXCEPTION 'Academic must reconcile the student intake and pinned curriculum position first';END IF;RETURN idmc_ap_assign(p_student,p_semester,p_actor);END $$;
CREATE OR REPLACE FUNCTION idmc_ap_tick(p_limit integer DEFAULT 50) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE r record;s record;outcomes jsonb:='[]';processed int:=0;result jsonb;
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('IDMC_INTAKE_PROGRESSION_TICK',0)) THEN RETURN jsonb_build_object('busy',true); END IF;
 FOR r IN SELECT pr.* FROM idmc_progression_rules pr JOIN academic_years y ON y.id=pr.target_year_id WHERE pr.automatic AND y.status='ACTIVE' AND y.start_date<=current_date AND y.end_date>=current_date ORDER BY pr.approved_at LOOP
 IF NOT idmc_ap_role(r.approved_by,ARRAY['ACADEMIC_OFFICER']) THEN CONTINUE;END IF;
 FOR s IN SELECT ss.id FROM students ss JOIN idmc_academic_stages st ON st.id=r.from_stage_id JOIN idmc_intakes i ON i.id=ss.intake_id WHERE ss.student_status='ACTIVE' AND ss.programme_id=st.programme_id AND ss.programme_version_id=st.programme_version_id AND ss.curriculum_id=st.curriculum_id AND ss.current_level=st.level AND ss.current_year_number=st.year_number AND i.code=r.intake_code AND NOT EXISTS(SELECT 1 FROM idmc_progression_decisions d WHERE d.student_id=ss.id AND d.rule_id=r.id AND d.state IN ('PROMOTED','COMPLETION_READY')) ORDER BY coalesce((SELECT d.decided_at FROM idmc_progression_decisions d WHERE d.student_id=ss.id AND d.rule_id=r.id),'-infinity'::timestamptz),ss.id LOOP
 EXIT WHEN processed>=least(greatest(p_limit,1),100);processed:=processed+1;
 BEGIN result:=idmc_ap_progress(s.id,r.id,r.approved_by,true);outcomes:=outcomes||jsonb_build_array(result);EXCEPTION WHEN OTHERS THEN INSERT INTO idmc_progression_events(actor_id,action,entity_id,details) VALUES(r.approved_by,'AUTOMATIC_PROGRESSION_ERROR',s.id,jsonb_build_object('error',SQLERRM));END;
 END LOOP;EXIT WHEN processed>=least(greatest(p_limit,1),100); END LOOP;
 RETURN jsonb_build_object('processed',processed,'decisions',outcomes);
END $$;
CREATE OR REPLACE FUNCTION idmc_ap_position_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.current_level IS DISTINCT FROM OLD.current_level OR NEW.current_year_number IS DISTINCT FROM OLD.current_year_number OR NEW.current_academic_year_id IS DISTINCT FROM OLD.current_academic_year_id OR (OLD.current_level IS NOT NULL AND (NEW.programme_id IS DISTINCT FROM OLD.programme_id OR NEW.programme_version_id IS DISTINCT FROM OLD.programme_version_id OR NEW.curriculum_id IS DISTINCT FROM OLD.curriculum_id))) THEN
 IF NOT idmc_ap_role(nullif(current_setting('idmc.ap.actor',true),'')::uuid,ARRAY['ACADEMIC_OFFICER']) THEN RAISE EXCEPTION 'Canonical academic position may only change through approved Academic reconciliation or progression' USING ERRCODE='42501';END IF;
 END IF;RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS idmc_ap_position_guard ON students;
CREATE TRIGGER idmc_ap_position_guard BEFORE UPDATE ON students FOR EACH ROW EXECUTE FUNCTION idmc_ap_position_guard();
CREATE OR REPLACE FUNCTION idmc_ap_disable_rule(p_rule uuid,p_actor uuid,p_reason text) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF NOT idmc_ap_role(p_actor,ARRAY['ACADEMIC_OFFICER']) THEN RAISE EXCEPTION 'Only Academic may disable automatic progression' USING ERRCODE='42501';END IF;
 IF length(trim(coalesce(p_reason,'')))<5 THEN RAISE EXCEPTION 'Reason required';END IF;
 UPDATE idmc_progression_rules SET automatic=false WHERE id=p_rule;
 INSERT INTO idmc_progression_events(actor_id,action,entity_id,details) VALUES(p_actor,'AUTOMATIC_RULE_DISABLED',p_rule,jsonb_build_object('reason',p_reason));
END $$;

CREATE OR REPLACE FUNCTION idmc_ap_unmapped(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE total int;rows jsonb;
BEGIN
 IF NOT idmc_ap_role(p_actor,ARRAY['ACADEMIC_OFFICER']) THEN RAISE EXCEPTION 'Only Academic may inspect institution curriculum gaps' USING ERRCODE='42501';END IF;
 SELECT count(*) INTO total FROM courses c WHERE c.status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM curriculum_courses cc WHERE cc.course_id=c.id);
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO rows FROM (SELECT c.id,c.course_code,c.course_name FROM courses c WHERE c.status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM curriculum_courses cc WHERE cc.course_id=c.id) ORDER BY c.course_code LIMIT 1000)x;
 RETURN jsonb_build_object('total',total,'rows',rows);
END $$;
CREATE OR REPLACE FUNCTION idmc_ap_classify_application(p_app uuid,p_intake uuid,p_actor uuid,p_reason text) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE a applications;i idmc_intakes;c record;
BEGIN
 IF NOT idmc_ap_role(p_actor,ARRAY['ADMISSIONS_OFFICER']) THEN RAISE EXCEPTION 'Only Admissions may classify legacy admission intake' USING ERRCODE='42501';END IF;
 SELECT * INTO a FROM applications WHERE id=p_app FOR UPDATE;SELECT * INTO i FROM idmc_intakes WHERE id=p_intake FOR SHARE;
 IF a.intake_id IS NOT NULL OR a.id IS NULL OR i.id IS NULL OR a.academic_year_id<>i.academic_year_id OR length(trim(coalesce(p_reason,'')))<5 THEN RAISE EXCEPTION 'Choose an unclassified application, its original academic year intake, and a reason';END IF;
 FOR c IN SELECT programme_id FROM application_choices WHERE application_id=a.id LOOP
 PERFORM pg_advisory_xact_lock(hashtextextended(a.applicant_id::text||i.id::text||c.programme_id::text,0));
 IF EXISTS(SELECT 1 FROM applications aa JOIN application_choices cc ON cc.application_id=aa.id WHERE aa.id<>a.id AND aa.applicant_id=a.applicant_id AND aa.intake_id=i.id AND cc.programme_id=c.programme_id AND aa.status NOT IN ('CANCELLED','REJECTED')) THEN RAISE EXCEPTION 'Duplicate intake/programme application needs Admissions reconciliation';END IF;
 END LOOP;
 PERFORM set_config('idmc.ap.classify_actor',p_actor::text,true);
 UPDATE applications SET intake_id=i.id,updated_at=now() WHERE id=a.id RETURNING * INTO a;
 UPDATE students SET intake_id=i.id,updated_at=now() WHERE source_application_id=a.id AND intake_id IS NULL;
 INSERT INTO idmc_progression_events(actor_id,action,entity_id,details) VALUES(p_actor,'LEGACY_INTAKE_CLASSIFIED',a.id,jsonb_build_object('intakeId',i.id,'reason',p_reason)); RETURN to_jsonb(a);
END $$;

CREATE TABLE IF NOT EXISTS idmc_intake_cw_review(offering_id uuid NOT NULL REFERENCES course_offerings(id),intake_code text NOT NULL CHECK(intake_code IN ('MARCH','SEPTEMBER')),status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','REVIEWED','RETURNED')),submitted_by uuid REFERENCES users(id),reviewed_by uuid REFERENCES users(id),comment text,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(offering_id,intake_code));
ALTER TABLE idmc_intake_cw_review ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON idmc_intake_cw_review FROM PUBLIC,anon,authenticated;
GRANT ALL ON idmc_intake_cw_review TO service_role;
CREATE OR REPLACE FUNCTION idmc_ap_submit_coursework(p_offering uuid,p_actor uuid,p_code text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE c record;s record;chosen text:=nullif(p_code,'');n int;
BEGIN
 IF NOT idmc_ap_role(p_actor,ARRAY['LECTURER']) OR NOT EXISTS(SELECT 1 FROM lecturer_assignments WHERE lecturer_user_id=p_actor AND course_offering_id=p_offering AND assignment_status='ACTIVE') THEN RAISE EXCEPTION 'Only the assigned lecturer may submit coursework' USING ERRCODE='42501';END IF;
 IF chosen IS NULL THEN SELECT count(*),min(intake_code) INTO n,chosen FROM idmc_intake_result_windows WHERE offering_id=p_offering AND is_open AND now()>=opens_at AND now()<closes_at;IF n<>1 THEN RAISE EXCEPTION 'Choose March or September intake before submitting coursework';END IF;END IF;
 IF NOT EXISTS(SELECT 1 FROM idmc_intake_result_windows WHERE offering_id=p_offering AND intake_code=chosen AND is_open AND now()>=opens_at AND now()<closes_at) THEN RAISE EXCEPTION 'Selected intake entry window is closed';END IF;
 IF (SELECT count(*) FROM idmc_cw_component WHERE offering_id=p_offering)<>4 THEN RAISE EXCEPTION 'Map four assessment components first';END IF;
 SELECT count(*) INTO n FROM course_registrations cr JOIN students ss ON ss.id=cr.student_id JOIN idmc_intakes i ON i.id=ss.intake_id WHERE cr.course_offering_id=p_offering AND cr.registration_status IN ('APPROVED','REGISTERED') AND i.code=chosen;
 IF n=0 THEN RAISE EXCEPTION 'No registered students for this intake';END IF;
 FOR c IN SELECT * FROM idmc_cw_component WHERE offering_id=p_offering LOOP
 FOR s IN SELECT cr.student_id FROM course_registrations cr JOIN students ss ON ss.id=cr.student_id JOIN idmc_intakes i ON i.id=ss.intake_id WHERE cr.course_offering_id=p_offering AND cr.registration_status IN ('APPROVED','REGISTERED') AND i.code=chosen LOOP
 IF NOT EXISTS(SELECT 1 FROM assessment_marks WHERE assessment_id=c.assessment_id AND student_id=s.student_id AND marks IS NOT NULL) THEN RAISE EXCEPTION 'Every selected-intake student needs all four component marks';END IF;
 END LOOP;END LOOP;
 UPDATE assessment_marks am SET status='SUBMITTED',submitted_by=p_actor,submitted_at=now() WHERE am.assessment_id IN (SELECT assessment_id FROM idmc_cw_component WHERE offering_id=p_offering) AND am.status='DRAFT' AND EXISTS(SELECT 1 FROM students ss JOIN idmc_intakes i ON i.id=ss.intake_id WHERE ss.id=am.student_id AND i.code=chosen);
 UPDATE assessments SET status='SUBMITTED' WHERE id IN (SELECT assessment_id FROM idmc_cw_component WHERE offering_id=p_offering) AND status IN ('DRAFT','OPEN');
 INSERT INTO idmc_intake_cw_review(offering_id,intake_code,submitted_by) VALUES(p_offering,chosen,p_actor) ON CONFLICT(offering_id,intake_code) DO UPDATE SET status='PENDING',submitted_by=p_actor,updated_at=now();
 INSERT INTO idmc_cw_review(offering_id,submitted_by) VALUES(p_offering,p_actor) ON CONFLICT(offering_id) DO UPDATE SET status='PENDING',submitted_by=p_actor,updated_at=now();
 INSERT INTO idmc_progression_events(actor_id,action,entity_id,details) VALUES(p_actor,'INTAKE_COURSEWORK_SUBMITTED',p_offering,jsonb_build_object('intake',chosen,'students',n));
 RETURN jsonb_build_object('submitted',true,'intake',chosen,'studentVisible',true,'hodReview','PENDING');
END $$;
CREATE OR REPLACE FUNCTION idmc_cw_submit(p_offering uuid,p_actor uuid) RETURNS jsonb LANGUAGE sql SET search_path=public AS $$SELECT idmc_ap_submit_coursework(p_offering,p_actor,NULL)$$;

CREATE OR REPLACE FUNCTION idmc_ap_review_coursework(p_offering uuid,p_actor uuid,p_code text,p_status text,p_comment text) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
DECLARE dept uuid;
BEGIN
 SELECT c.department_id INTO dept FROM course_offerings o JOIN courses c ON c.id=o.course_id WHERE o.id=p_offering;
 IF NOT idmc_ap_role(p_actor,ARRAY['HOD','DEPUTY_HOD']) OR NOT idmc_hod_department(p_actor,dept) THEN RAISE EXCEPTION 'Only the department HOD may review coursework' USING ERRCODE='42501';END IF;
 IF p_code NOT IN ('MARCH','SEPTEMBER') OR p_status NOT IN ('REVIEWED','RETURNED') OR length(trim(coalesce(p_comment,'')))<2 THEN RAISE EXCEPTION 'Choose intake, review status and comment';END IF;
 UPDATE idmc_intake_cw_review SET status=p_status,comment=p_comment,reviewed_by=p_actor,updated_at=now() WHERE offering_id=p_offering AND intake_code=p_code;
 IF NOT FOUND THEN RAISE EXCEPTION 'Lecturer must submit this intake coursework first';END IF;
 UPDATE idmc_cw_review SET status=CASE WHEN EXISTS(SELECT 1 FROM idmc_intake_cw_review WHERE offering_id=p_offering AND status='PENDING') THEN 'PENDING' WHEN EXISTS(SELECT 1 FROM idmc_intake_cw_review WHERE offering_id=p_offering AND status='RETURNED') THEN 'RETURNED' ELSE 'REVIEWED' END,comment=p_comment,reviewed_by=p_actor,updated_at=now() WHERE offering_id=p_offering;
 INSERT INTO idmc_progression_events(actor_id,action,entity_id,details) VALUES(p_actor,'INTAKE_COURSEWORK_REVIEWED',p_offering,jsonb_build_object('intake',p_code,'status',p_status,'comment',p_comment));
END $$;
CREATE OR REPLACE FUNCTION idmc_set_result_window(p_offering uuid,p_open boolean,p_actor uuid) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
DECLARE dept uuid;actual boolean;
BEGIN
 SELECT p.department_id INTO dept FROM course_offerings o JOIN programmes p ON p.id=o.programme_id WHERE o.id=p_offering;
 IF NOT idmc_ap_role(p_actor,ARRAY['ACADEMIC_OFFICER']) AND NOT(idmc_ap_role(p_actor,ARRAY['HOD','DEPUTY_HOD']) AND idmc_hod_department(p_actor,dept)) THEN RAISE EXCEPTION 'Only Academic or the programme HOD may manage result windows' USING ERRCODE='42501';END IF;
 actual:=EXISTS(SELECT 1 FROM idmc_intake_result_windows WHERE offering_id=p_offering AND is_open);
 IF p_open IS DISTINCT FROM actual THEN RAISE EXCEPTION 'Choose March or September and change its result window in Intake & Academic Progression';END IF;
 INSERT INTO idmc_result_windows(course_offering_id,is_open,changed_by,changed_at) VALUES(p_offering,actual,p_actor,now()) ON CONFLICT(course_offering_id) DO UPDATE SET is_open=excluded.is_open,changed_by=p_actor,changed_at=now();
END $$;

DO $$DECLARE tab text;f record;BEGIN
 FOREACH tab IN ARRAY ARRAY['idmc_intakes','idmc_academic_stages','idmc_progression_rules','idmc_progression_decisions','idmc_intake_result_windows','idmc_progression_events'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab); EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,anon,authenticated',tab);EXECUTE format('GRANT ALL ON %I TO service_role',tab);END LOOP;
 FOR f IN SELECT oid::regprocedure sig FROM pg_proc WHERE pronamespace='public'::regnamespace AND (proname LIKE 'idmc_ap_%' OR proname IN ('idmc_intake_state','idmc_intake_manage','idmc_application_intake_guard','idmc_intake_choice_guard','idmc_student_intake_guard','idmc_register_admitted','idmc_after_admission','idmc_set_result_window','idmc_cw_submit')) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.sig);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.sig);END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
