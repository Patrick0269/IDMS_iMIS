BEGIN;
CREATE TABLE IF NOT EXISTS public.idmc_course_delete_jobs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES public.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 state text NOT NULL DEFAULT 'PREVIEW' CHECK(state IN ('PREVIEW','DONE')),
 course_ids uuid[] NOT NULL, plan jsonb NOT NULL, plan_hash text NOT NULL, counts jsonb NOT NULL,
 finished_at timestamptz, result jsonb
);
ALTER TABLE public.idmc_course_delete_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.idmc_course_delete_jobs FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.idmc_course_delete_jobs TO service_role;
CREATE OR REPLACE FUNCTION public.idmc_course_force_assert(p_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM public.idmc_academic_assert_actor(p_actor);
 IF NOT EXISTS(SELECT 1 FROM public.users u JOIN public.user_roles ur ON ur.user_id=u.id JOIN public.roles r ON r.id=ur.role_id
 WHERE u.id=p_actor AND u.status='ACTIVE' AND ur.status='ACTIVE' AND (ur.expires_at IS NULL OR ur.expires_at>now()) AND r.status='ACTIVE' AND r.role_code IN ('ADMIN','SUPER_ADMIN','SYSTEM_ADMIN')) THEN
  RAISE EXCEPTION 'Deleting courses with academic history requires an active ADMIN or SUPER_ADMIN role and academics.manage permission' USING ERRCODE='42501';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id=ur.role_id JOIN public.role_permissions rp ON rp.role_id=r.id JOIN public.permissions p ON p.id=rp.permission_id
 WHERE ur.user_id=p_actor AND ur.status='ACTIVE' AND (ur.expires_at IS NULL OR ur.expires_at>now()) AND r.status='ACTIVE' AND p.status='ACTIVE' AND p.permission_code='academics.manage' AND coalesce((to_jsonb(rp)->>'granted')::boolean,true)) THEN
 RAISE EXCEPTION 'Active granted academics.manage permission required' USING ERRCODE='42501'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.idmc_course_force_tables() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT ARRAY['public.courses','public.curriculum_courses','public.course_prerequisites','public.course_offerings','public.course_registrations','public.course_add_drop_requests','public.classes','public.class_students','public.lecturer_assignments','public.timetable_entries','public.attendance_sessions','public.attendance_records','public.attendance_corrections','public.assessments','public.assessment_marks','public.assessment_submissions','public.assessment_mark_corrections','public.examination_papers','public.examination_candidates','public.examination_sessions','public.examination_invigilators','public.examination_attendance','public.examination_marks','public.examination_mark_corrections','public.course_result_policies','public.course_results','public.course_result_corrections','public.result_import_rows','public.student_course_attempts','public.student_academic_deficiencies','public.student_transcript_courses','public.student_transcript_semesters','public.student_semester_results','public.student_gpa_records','public.student_cgpa_records','public.student_academic_standings','public.clinical_placements','public.clinical_assessments','public.field_practicals','public.field_practical_reports','public.student_coursework_responses','public.student_course_evaluations','public.idmc_result_windows','public.idmc_result_comments','public.academic_records','public.examination_candidate_sessions','public.placement_logbook_entries','public.historical_academic_import_rows']::text[]
$$;

CREATE OR REPLACE FUNCTION public.idmc_course_row_key(p_table oid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE answer jsonb;
BEGIN
 SELECT jsonb_object_agg(a.attname,p_payload->a.attname) INTO answer FROM pg_index i
 JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid=p_table AND i.indisprimary;
 IF answer IS NULL THEN RAISE EXCEPTION 'Table % has no primary key; cannot back up and delete safely',p_table::regclass; END IF;
 RETURN answer;
END $$;
CREATE OR REPLACE FUNCTION public.idmc_course_collect_children() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE fk record; condition text; amount bigint; inserted integer; added integer; rounds integer=0;
BEGIN
 LOOP
  added=0;rounds=rounds+1;
  FOR fk IN SELECT k.oid,k.conrelid,k.confrelid,k.conkey,k.confkey,ns.nspname schema_name,c.relname table_name
  FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace
  WHERE k.contype='f' AND EXISTS(SELECT 1 FROM pg_temp._idmc_course_plan p WHERE p.table_oid=k.confrelid AND p.operation='DELETE') ORDER BY k.oid LOOP
   SELECT string_agg(format('(to_jsonb(child)->%L IS DISTINCT FROM ''null''::jsonb AND to_jsonb(child)->%L=parent.payload->%L)',source.attname,source.attname,target.attname),' AND ' ORDER BY idx)
   INTO condition FROM generate_subscripts(fk.conkey,1) idx
   JOIN pg_attribute source ON source.attrelid=fk.conrelid AND source.attnum=fk.conkey[idx]
   JOIN pg_attribute target ON target.attrelid=fk.confrelid AND target.attnum=fk.confkey[idx];
   EXECUTE format('SELECT count(*) FROM %I.%I child JOIN pg_temp._idmc_course_plan parent ON parent.table_oid=$1 AND parent.operation=''DELETE'' AND %s',fk.schema_name,fk.table_name,condition) INTO amount USING fk.confrelid;
   IF amount>0 THEN
    IF NOT (fk.schema_name||'.'||fk.table_name)=ANY(public.idmc_course_force_tables()) THEN
     RAISE EXCEPTION 'Dependency %.% is outside the course reset scope (% matching rows). Nothing deleted.',fk.schema_name,fk.table_name,amount;
    END IF;
    EXECUTE format('INSERT INTO pg_temp._idmc_course_plan(table_oid,row_key,payload,operation) SELECT DISTINCT $2,public.idmc_course_row_key($2,to_jsonb(child)),to_jsonb(child),''DELETE'' FROM %I.%I child JOIN pg_temp._idmc_course_plan parent ON parent.table_oid=$1 AND parent.operation=''DELETE'' AND %s ON CONFLICT(table_oid,row_key) DO NOTHING',fk.schema_name,fk.table_name,condition) USING fk.confrelid,fk.conrelid;
    GET DIAGNOSTICS inserted=ROW_COUNT;added=added+inserted;
   END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_temp._idmc_course_plan)>20000 THEN RAISE EXCEPTION 'Course reset exceeds 20000 rows; split the selection'; END IF;
  EXIT WHEN added=0;
  IF rounds>50 THEN RAISE EXCEPTION 'Dependency closure exceeded depth limit'; END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.idmc_course_build_plan(p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE answer jsonb; tab text;
BEGIN
 IF p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 100 OR EXISTS(SELECT 1 FROM unnest(p_ids) x WHERE x IS NULL) THEN RAISE EXCEPTION 'Select 1 to 100 courses'; END IF;
 IF (SELECT count(*) FROM public.courses WHERE id=ANY(p_ids))<>(SELECT count(DISTINCT x) FROM unnest(p_ids) x) THEN RAISE EXCEPTION 'A selected course no longer exists; refresh Course Master'; END IF;
 DROP TABLE IF EXISTS pg_temp._idmc_course_plan;
 CREATE TEMP TABLE _idmc_course_plan(table_oid oid NOT NULL,row_key jsonb NOT NULL,payload jsonb NOT NULL,operation text NOT NULL,removed boolean NOT NULL DEFAULT false,PRIMARY KEY(table_oid,row_key)) ON COMMIT DROP;
 INSERT INTO pg_temp._idmc_course_plan SELECT 'public.courses'::regclass,public.idmc_course_row_key('public.courses'::regclass,to_jsonb(c)),to_jsonb(c),'DELETE',false FROM public.courses c WHERE id=ANY(p_ids);
 -- Legacy academic records use course code + institution instead of a course FK.
 IF to_regclass('public.academic_records') IS NOT NULL THEN
  INSERT INTO pg_temp._idmc_course_plan SELECT 'public.academic_records'::regclass,public.idmc_course_row_key('public.academic_records'::regclass,to_jsonb(ar)),to_jsonb(ar),'DELETE',false
  FROM public.academic_records ar WHERE EXISTS(SELECT 1 FROM public.courses c WHERE c.id=ANY(p_ids) AND c.institution_id=ar.institution_id AND upper(regexp_replace(c.course_code,'\s+','','g'))=upper(regexp_replace(ar.course_code,'\s+','','g')));
 END IF;
 PERFORM public.idmc_course_collect_children();
 -- Remove affected derived summaries; source marks/results for OTHER courses remain.
 FOR tab IN SELECT unnest(ARRAY['public.student_semester_results','public.student_gpa_records']) LOOP
  IF to_regclass(tab) IS NOT NULL THEN
   EXECUTE format('INSERT INTO pg_temp._idmc_course_plan SELECT $1,public.idmc_course_row_key($1,to_jsonb(r)),to_jsonb(r),''DELETE'',false FROM %s r WHERE EXISTS(SELECT 1 FROM pg_temp._idmc_course_plan p WHERE p.table_oid=to_regclass(''public.course_results'') AND p.operation=''DELETE'' AND p.payload->>''student_id''=r.student_id::text AND p.payload->>''academic_year_id''=r.academic_year_id::text AND p.payload->>''semester_id''=r.semester_id::text) ON CONFLICT(table_oid,row_key) DO NOTHING',to_regclass(tab)) USING to_regclass(tab)::oid;
  END IF;
 END LOOP;
 FOR tab IN SELECT unnest(ARRAY['public.student_cgpa_records','public.student_academic_standings']) LOOP
  IF to_regclass(tab) IS NOT NULL THEN
   EXECUTE format('INSERT INTO pg_temp._idmc_course_plan SELECT $1,public.idmc_course_row_key($1,to_jsonb(r)),to_jsonb(r),''DELETE'',false FROM %s r WHERE EXISTS(SELECT 1 FROM pg_temp._idmc_course_plan p WHERE p.table_oid=to_regclass(''public.course_results'') AND p.operation=''DELETE'' AND p.payload->>''student_id''=r.student_id::text) ON CONFLICT(table_oid,row_key) DO NOTHING',to_regclass(tab)) USING to_regclass(tab)::oid;
  END IF;
 END LOOP;
 PERFORM public.idmc_course_collect_children();
 IF to_regclass('public.student_transcripts') IS NOT NULL THEN
  INSERT INTO pg_temp._idmc_course_plan SELECT 'public.student_transcripts'::regclass,public.idmc_course_row_key('public.student_transcripts'::regclass,to_jsonb(tr)),to_jsonb(tr),'REVOKE_TRANSCRIPT',false
  FROM public.student_transcripts tr WHERE EXISTS(SELECT 1 FROM pg_temp._idmc_course_plan p WHERE p.table_oid IN (to_regclass('public.student_transcript_courses'),to_regclass('public.student_transcript_semesters')) AND p.operation='DELETE' AND p.payload->>'transcript_id'=tr.id::text) ON CONFLICT(table_oid,row_key) DO NOTHING;
 END IF;
 IF to_regclass('public.student_registrations') IS NOT NULL THEN
  INSERT INTO pg_temp._idmc_course_plan SELECT 'public.student_registrations'::regclass,public.idmc_course_row_key('public.student_registrations'::regclass,to_jsonb(sr)),to_jsonb(sr),'REFRESH_CREDITS',false
  FROM public.student_registrations sr WHERE EXISTS(SELECT 1 FROM pg_temp._idmc_course_plan p WHERE p.table_oid=to_regclass('public.course_registrations') AND p.operation='DELETE' AND p.payload->>'student_registration_id'=sr.id::text) ON CONFLICT(table_oid,row_key) DO NOTHING;
 END IF;
 IF to_regclass('public.result_import_batches') IS NOT NULL THEN
  INSERT INTO pg_temp._idmc_course_plan SELECT 'public.result_import_batches'::regclass,public.idmc_course_row_key('public.result_import_batches'::regclass,to_jsonb(b)),to_jsonb(b),'INVALIDATE_IMPORT',false
  FROM public.result_import_batches b WHERE EXISTS(SELECT 1 FROM pg_temp._idmc_course_plan p WHERE p.table_oid=to_regclass('public.result_import_rows') AND p.operation='DELETE' AND p.payload->>'batch_id'=b.id::text) ON CONFLICT(table_oid,row_key) DO NOTHING;
 END IF;
 IF to_regclass('public.historical_academic_import_batches') IS NOT NULL THEN
  INSERT INTO pg_temp._idmc_course_plan SELECT 'public.historical_academic_import_batches'::regclass,public.idmc_course_row_key('public.historical_academic_import_batches'::regclass,to_jsonb(b)),to_jsonb(b),'INVALIDATE_HISTORY',false
  FROM public.historical_academic_import_batches b WHERE EXISTS(SELECT 1 FROM pg_temp._idmc_course_plan p WHERE p.table_oid=to_regclass('public.historical_academic_import_rows') AND p.operation='DELETE' AND p.payload->>'batch_id'=b.id::text) ON CONFLICT(table_oid,row_key) DO NOTHING;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('table',ns.nspname||'.'||c.relname,'key',p.row_key,'data',p.payload,'operation',p.operation) ORDER BY ns.nspname,c.relname,p.row_key::text),'[]') INTO answer
 FROM pg_temp._idmc_course_plan p JOIN pg_class c ON c.oid=p.table_oid JOIN pg_namespace ns ON ns.oid=c.relnamespace;
 IF octet_length(answer::text)>20000000 THEN RAISE EXCEPTION 'Backup exceeds 20MB; split the selection'; END IF;
 RETURN answer;
END $$;
CREATE OR REPLACE FUNCTION public.idmc_course_live_children(p_table oid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE fk record; condition text; amount bigint;
BEGIN
 FOR fk IN SELECT * FROM pg_constraint k WHERE k.contype='f' AND k.confrelid=p_table AND k.conrelid<>p_table LOOP
  SELECT string_agg(format('(to_jsonb(child)->%L IS DISTINCT FROM ''null''::jsonb AND to_jsonb(child)->%L=parent.payload->%L)',source.attname,source.attname,target.attname),' AND ' ORDER BY idx) INTO condition
  FROM generate_subscripts(fk.conkey,1) idx JOIN pg_attribute source ON source.attrelid=fk.conrelid AND source.attnum=fk.conkey[idx]
  JOIN pg_attribute target ON target.attrelid=fk.confrelid AND target.attnum=fk.confkey[idx];
  EXECUTE format('SELECT count(*) FROM %s child JOIN pg_temp._idmc_course_plan parent ON parent.table_oid=$1 AND parent.operation=''DELETE'' AND NOT parent.removed AND %s',fk.conrelid::regclass,condition) INTO amount USING p_table;
  IF amount>0 THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END $$;
CREATE OR REPLACE FUNCTION public.idmc_course_force_preview(p_ids uuid[],p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE plan jsonb; counts jsonb; job uuid; courses jsonb;
BEGIN
 PERFORM public.idmc_course_force_assert(p_actor);
 plan=public.idmc_course_build_plan(p_ids);
 SELECT jsonb_agg(jsonb_build_object('table',table_name,'operation',op,'count',n) ORDER BY table_name,op) INTO counts FROM (
 SELECT x->>'table' table_name,x->>'operation' op,count(*) n FROM jsonb_array_elements(plan) x GROUP BY x->>'table',x->>'operation') rows;
 INSERT INTO public.idmc_course_delete_jobs(actor_id,course_ids,plan,plan_hash,counts) VALUES(p_actor,p_ids,plan,md5(plan::text),counts) RETURNING id INTO job;
 SELECT jsonb_agg(jsonb_build_object('id',id,'code',course_code,'name',course_name) ORDER BY course_code,id) INTO courses FROM public.courses WHERE id=ANY(p_ids);
 RETURN jsonb_build_object('jobId',job,'counts',counts,'courses',courses,'totalRows',jsonb_array_length(plan),'expiresInMinutes',30,'backupPrepared',true);
END $$;
CREATE OR REPLACE FUNCTION public.idmc_course_force_delete(p_job uuid,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE job public.idmc_course_delete_jobs%ROWTYPE; tab text; row_json jsonb; actual jsonb; t record; trig record;
 progressed integer; amount bigint; expected bigint; remaining integer; summary jsonb; cycles_broken boolean=false;
BEGIN
 PERFORM public.idmc_course_force_assert(p_actor);
 SELECT * INTO job FROM public.idmc_course_delete_jobs WHERE id=p_job AND actor_id=p_actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Preview belongs to another account or does not exist' USING ERRCODE='42501'; END IF;
 IF job.state='DONE' THEN RETURN job.result||jsonb_build_object('alreadyDeleted',true); END IF;
 IF job.expires_at<now() THEN RAISE EXCEPTION 'Preview expired; refresh the selected course usage'; END IF;
 PERFORM pg_advisory_xact_lock(810081713);
 PERFORM set_config('lock_timeout','5s',true);
 -- Lock only academic reset tables; unrelated identity/finance tables stay outside scope.
 FOR tab IN SELECT value FROM unnest(public.idmc_course_force_tables()||ARRAY['public.student_registrations','public.student_transcripts','public.result_import_batches','public.historical_academic_import_batches']) value WHERE to_regclass(value) IS NOT NULL ORDER BY value LOOP
  EXECUTE format('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE',to_regclass(tab));
 END LOOP;
 FOR row_json IN SELECT value FROM jsonb_array_elements(job.plan) LOOP
  EXECUTE format('SELECT 1 FROM %s r WHERE to_jsonb(r) @> $1 FOR UPDATE',to_regclass(row_json->>'table')) USING row_json->'key';
 END LOOP;
 actual=public.idmc_course_build_plan(job.course_ids);
 IF md5(actual::text)<>job.plan_hash THEN RAISE EXCEPTION 'Course usage changed since preview. Nothing deleted; preview and confirm the current usage again'; END IF;
 -- Backup already committed at preview; audit + deletion + trigger restoration are atomic.
 DROP TABLE IF EXISTS pg_temp._idmc_course_guard_states;
 CREATE TEMP TABLE _idmc_course_guard_states(table_oid oid,name text,state "char") ON COMMIT DROP;
 INSERT INTO pg_temp._idmc_course_guard_states SELECT tgrelid,tgname,tgenabled FROM pg_trigger
 WHERE NOT tgisinternal AND tgenabled<>'D' AND EXISTS(SELECT 1 FROM pg_temp._idmc_course_plan p WHERE p.table_oid=tgrelid)
 AND (tgrelid::regclass::text||':'||tgname)=ANY(ARRAY[
 'course_registrations:trg_prevent_locked_course_registration','course_add_drop_requests:trg_prevent_add_drop_after_lock',
 'assessment_marks:trg_prevent_locked_assessment_mark_change','assessment_marks:trg_prevent_assessment_mark_delete',
 'examination_marks:trg_prevent_examination_mark_delete','attendance_records:trg_prevent_locked_attendance_change',
 'timetable_entries:trg_prevent_locked_timetable_change','course_results:trg_prevent_course_result_delete',
 'student_transcripts:trg_validate_transcript_status_transition']);
 -- regclass may be schema-qualified under this function's empty search_path.
 INSERT INTO pg_temp._idmc_course_guard_states SELECT tgrelid,tgname,tgenabled FROM pg_trigger
 WHERE NOT tgisinternal AND tgenabled<>'D' AND EXISTS(SELECT 1 FROM pg_temp._idmc_course_plan p WHERE p.table_oid=tgrelid)
 AND (tgrelid::regclass::text||':'||tgname)=ANY(ARRAY[
 'public.course_registrations:trg_prevent_locked_course_registration','public.course_add_drop_requests:trg_prevent_add_drop_after_lock',
 'public.assessment_marks:trg_prevent_locked_assessment_mark_change','public.assessment_marks:trg_prevent_assessment_mark_delete',
 'public.examination_marks:trg_prevent_examination_mark_delete','public.attendance_records:trg_prevent_locked_attendance_change',
 'public.timetable_entries:trg_prevent_locked_timetable_change','public.course_results:trg_prevent_course_result_delete',
 'public.student_transcripts:trg_validate_transcript_status_transition']);
 FOR trig IN SELECT DISTINCT * FROM pg_temp._idmc_course_guard_states LOOP
  EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I',trig.table_oid::regclass,trig.name);
 END LOOP;
 LOOP
  progressed=0;
  FOR t IN SELECT DISTINCT p.table_oid FROM pg_temp._idmc_course_plan p WHERE p.operation='DELETE' AND NOT p.removed ORDER BY p.table_oid LOOP
   IF public.idmc_course_live_children(t.table_oid) THEN CONTINUE; END IF;
   SELECT count(*) INTO expected FROM pg_temp._idmc_course_plan p WHERE p.table_oid=t.table_oid AND p.operation='DELETE' AND NOT p.removed;
   EXECUTE format('DELETE FROM %s r USING pg_temp._idmc_course_plan p WHERE p.table_oid=$1 AND p.operation=''DELETE'' AND NOT p.removed AND to_jsonb(r) @> p.row_key',t.table_oid::regclass) USING t.table_oid;
   GET DIAGNOSTICS amount=ROW_COUNT;
   IF amount<>expected THEN RAISE EXCEPTION 'Deletion count changed for %',t.table_oid::regclass; END IF;
   UPDATE pg_temp._idmc_course_plan p SET removed=true WHERE p.table_oid=t.table_oid AND p.operation='DELETE';progressed=progressed+1;
  END LOOP;
  SELECT count(*) INTO remaining FROM pg_temp._idmc_course_plan WHERE operation='DELETE' AND NOT removed;
  EXIT WHEN remaining=0;
  IF progressed=0 THEN
   IF cycles_broken THEN RAISE EXCEPTION 'Unknown cyclic dependencies require a scoped reset. Nothing deleted'; END IF;
   -- Two nullable historical import links form a known cycle. Backups retain
   -- their original values; null only the exact rows that will be removed.
   IF to_regclass('public.student_course_attempts') IS NOT NULL AND to_regclass('public.historical_academic_import_rows') IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.student_course_attempts'::regclass AND attname='import_row_id' AND NOT attnotnull) THEN
     UPDATE public.student_course_attempts a SET import_row_id=NULL WHERE EXISTS(SELECT 1 FROM pg_temp._idmc_course_plan p WHERE p.table_oid='public.student_course_attempts'::regclass AND p.operation='DELETE' AND NOT p.removed AND p.row_key->>'id'=a.id::text);
    END IF;
    IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.historical_academic_import_rows'::regclass AND attname='course_attempt_id' AND NOT attnotnull) THEN
     UPDATE public.historical_academic_import_rows r SET course_attempt_id=NULL WHERE EXISTS(SELECT 1 FROM pg_temp._idmc_course_plan p WHERE p.table_oid='public.historical_academic_import_rows'::regclass AND p.operation='DELETE' AND NOT p.removed AND p.row_key->>'id'=r.id::text);
    END IF;
   END IF;
   cycles_broken=true;
  END IF;
 END LOOP;
 IF to_regclass('public.student_registrations') IS NOT NULL THEN
  UPDATE public.student_registrations sr SET total_registered_credits=coalesce((SELECT sum(cr.credits) FROM public.course_registrations cr WHERE cr.student_registration_id=sr.id AND cr.registration_status NOT IN ('DROPPED','REJECTED','CANCELLED')),0),updated_at=now()
  WHERE EXISTS(SELECT 1 FROM pg_temp._idmc_course_plan p WHERE p.table_oid='public.student_registrations'::regclass AND p.operation='REFRESH_CREDITS' AND p.row_key->>'id'=sr.id::text);
 END IF;
 IF to_regclass('public.student_transcripts') IS NOT NULL THEN
  UPDATE public.student_transcripts tr SET transcript_status='REVOKED',revoked_at=now(),revoked_by=p_actor,updated_at=now()
  WHERE EXISTS(SELECT 1 FROM pg_temp._idmc_course_plan p WHERE p.table_oid='public.student_transcripts'::regclass AND p.operation='REVOKE_TRANSCRIPT' AND p.row_key->>'id'=tr.id::text);
 END IF;
 IF to_regclass('public.result_import_batches') IS NOT NULL THEN
  UPDATE public.result_import_batches b SET status='FAILED',failure_message='Courses removed by an administrator; review remaining rows before re-import.',
   total_rows=(SELECT count(*) FROM public.result_import_rows r WHERE r.batch_id=b.id),valid_rows=(SELECT count(*) FROM public.result_import_rows r WHERE r.batch_id=b.id AND r.validation_status IN ('VALID','IMPORTED')),
   invalid_rows=(SELECT count(*) FROM public.result_import_rows r WHERE r.batch_id=b.id AND r.validation_status='INVALID'),
   duplicate_rows=(SELECT count(*) FROM public.result_import_rows r WHERE r.batch_id=b.id AND EXISTS(SELECT 1 FROM unnest(r.error_codes) x WHERE x LIKE '%DUPLICATE%'))
  WHERE EXISTS(SELECT 1 FROM pg_temp._idmc_course_plan p WHERE p.table_oid='public.result_import_batches'::regclass AND p.operation='INVALIDATE_IMPORT' AND p.row_key->>'id'=b.id::text);
 END IF;
 IF to_regclass('public.historical_academic_import_batches') IS NOT NULL THEN
  UPDATE public.historical_academic_import_batches b SET status='FAILED',rollback_reason='Courses removed by an administrator; validate remaining records again.',updated_at=now(),
   total_rows=(SELECT count(*) FROM public.historical_academic_import_rows r WHERE r.batch_id=b.id),
   valid_rows=(SELECT count(*) FROM public.historical_academic_import_rows r WHERE r.batch_id=b.id AND r.validation_status IN ('VALID','IMPORTED')),
   invalid_rows=(SELECT count(*) FROM public.historical_academic_import_rows r WHERE r.batch_id=b.id AND r.validation_status='INVALID'),
   duplicate_rows=(SELECT count(*) FROM public.historical_academic_import_rows r WHERE r.batch_id=b.id AND r.validation_status='DUPLICATE'),
   imported_rows=(SELECT count(*) FROM public.historical_academic_import_rows r WHERE r.batch_id=b.id AND r.validation_status='IMPORTED'),
   skipped_rows=(SELECT count(*) FROM public.historical_academic_import_rows r WHERE r.batch_id=b.id AND r.validation_status='SKIPPED')
  WHERE EXISTS(SELECT 1 FROM pg_temp._idmc_course_plan p WHERE p.table_oid='public.historical_academic_import_batches'::regclass AND p.operation='INVALIDATE_HISTORY' AND p.row_key->>'id'=b.id::text);
 END IF;
 FOR trig IN SELECT DISTINCT * FROM pg_temp._idmc_course_guard_states LOOP
  EXECUTE format('ALTER TABLE %s ENABLE %s TRIGGER %I',trig.table_oid::regclass,CASE WHEN trig.state='A' THEN 'ALWAYS' WHEN trig.state='R' THEN 'REPLICA' ELSE '' END,trig.name);
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.courses WHERE id=ANY(job.course_ids)) THEN RAISE EXCEPTION 'Course deletion read-back failed'; END IF;
 summary=jsonb_build_object('backupJob',job.id,'affected',cardinality(job.course_ids),'counts',job.counts,'alreadyDeleted',false);
 INSERT INTO public.audit_logs(user_id,action_code,module_code,entity_type,new_values) VALUES(p_actor,'ACADEMIC_COURSES_FORCE_DELETE','ACADEMICS','courses',summary);
 UPDATE public.idmc_course_delete_jobs SET state='DONE',finished_at=now(),result=summary WHERE id=job.id;
 RETURN summary;
END $$;
CREATE OR REPLACE FUNCTION public.idmc_course_force_status(p_job uuid,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE job public.idmc_course_delete_jobs%ROWTYPE;
BEGIN
 PERFORM public.idmc_course_force_assert(p_actor);
 SELECT * INTO job FROM public.idmc_course_delete_jobs WHERE id=p_job AND actor_id=p_actor;
 IF NOT FOUND THEN RAISE EXCEPTION 'Preview belongs to another account or does not exist' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('state',job.state,'jobId',job.id,'counts',job.counts,'result',job.result);
END $$;
REVOKE ALL ON FUNCTION public.idmc_course_force_status(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_course_force_status(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.idmc_course_live_children(oid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_course_live_children(oid) TO service_role;
REVOKE ALL ON FUNCTION public.idmc_course_force_assert(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_course_force_assert(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.idmc_course_force_tables() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_course_force_tables() TO service_role;
REVOKE ALL ON FUNCTION public.idmc_course_row_key(oid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_course_row_key(oid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.idmc_course_collect_children() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_course_collect_children() TO service_role;
REVOKE ALL ON FUNCTION public.idmc_course_build_plan(uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_course_build_plan(uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.idmc_course_force_preview(uuid[],uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_course_force_preview(uuid[],uuid) TO service_role;
REVOKE ALL ON FUNCTION public.idmc_course_force_delete(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_course_force_delete(uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
