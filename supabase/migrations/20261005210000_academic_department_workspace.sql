BEGIN;
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS academic_group text;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS cross_cutting boolean NOT NULL DEFAULT false;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.departments'::regclass AND conname='departments_academic_group_check') THEN
  ALTER TABLE public.departments ADD CONSTRAINT departments_academic_group_check CHECK (academic_group IS NULL OR academic_group IN ('SOCIAL','PROJECT'));
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_departments_academic_group ON public.departments(academic_group);
COMMENT ON COLUMN public.departments.academic_group IS 'Explicit Academic Management section. NULL remains unassigned; course type PROJECT is not a department.';

CREATE OR REPLACE FUNCTION public.idmc_academic_assert_actor(p_actor uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM public.users u JOIN public.user_roles ur ON ur.user_id=u.id JOIN public.roles r ON r.id=ur.role_id
  JOIN public.role_permissions rp ON rp.role_id=r.id JOIN public.permissions p ON p.id=rp.permission_id
  WHERE u.id=p_actor AND u.status='ACTIVE' AND ur.status='ACTIVE' AND r.status='ACTIVE'
  AND (ur.expires_at IS NULL OR ur.expires_at>now()) AND p.status='ACTIVE' AND p.permission_code='academics.manage'
 ) THEN RAISE EXCEPTION 'Active academics.manage permission required' USING ERRCODE='42501'; END IF;
END $$;

-- Inspect every declared foreign key, including references with CASCADE.
CREATE OR REPLACE FUNCTION public.idmc_academic_course_usage(p_ids uuid[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c record; fk record; n bigint; refs jsonb; answer jsonb='[]'::jsonb;
BEGIN
 IF coalesce(cardinality(p_ids),0)=0 OR cardinality(p_ids)>100 THEN RAISE EXCEPTION 'Select 1 to 100 courses'; END IF;
 IF EXISTS (SELECT 1 FROM pg_constraint k WHERE k.contype='f' AND k.confrelid='public.courses'::regclass
  AND (cardinality(k.conkey)<>1 OR cardinality(k.confkey)<>1 OR k.confkey[1]<>(SELECT attnum FROM pg_attribute WHERE attrelid='public.courses'::regclass AND attname='id')))
 THEN RAISE EXCEPTION 'Nonstandard course foreign key detected; review references before deleting or archiving courses'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(p_ids) x WHERE x IS NULL) THEN RAISE EXCEPTION 'Invalid course selection'; END IF;
 IF (SELECT count(*) FROM public.courses WHERE id=ANY(p_ids))<>(SELECT count(DISTINCT x) FROM unnest(p_ids) x) THEN RAISE EXCEPTION 'A selected course no longer exists'; END IF;
 FOR c IN SELECT * FROM public.courses WHERE id=ANY(p_ids) ORDER BY id LOOP
  refs='{}'::jsonb;
  FOR fk IN
   SELECT ns.nspname schema_name,cl.relname table_name,a.attname column_name
   FROM pg_constraint k JOIN pg_class cl ON cl.oid=k.conrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace
   JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=k.conkey[1]
   JOIN pg_attribute target ON target.attrelid=k.confrelid AND target.attnum=k.confkey[1]
   WHERE k.contype='f' AND k.confrelid='public.courses'::regclass AND cardinality(k.conkey)=1 AND target.attname='id'
  LOOP
   EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I=$1',fk.schema_name,fk.table_name,fk.column_name) INTO n USING c.id;
   IF n>0 THEN refs=refs || jsonb_build_object(fk.schema_name||'.'||fk.table_name||'.'||fk.column_name,n); END IF;
  END LOOP;
  answer=answer || jsonb_build_array(jsonb_build_object('id',c.id,'code',c.course_code,'name',c.course_name,'canDelete',refs='{}'::jsonb,'references',refs));
 END LOOP;
 RETURN answer;
END $$;

CREATE OR REPLACE FUNCTION public.idmc_academic_course_action(p_ids uuid[],p_action text,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE usage jsonb; before_rows jsonb; affected integer;
BEGIN
 PERFORM public.idmc_academic_assert_actor(p_actor);
 IF p_action NOT IN ('DELETE','ARCHIVE') THEN RAISE EXCEPTION 'Unsupported action'; END IF;
 PERFORM 1 FROM public.courses WHERE id=ANY(p_ids) ORDER BY id FOR UPDATE;
 usage=public.idmc_academic_course_usage(p_ids);
 SELECT jsonb_agg(to_jsonb(c)) INTO before_rows FROM public.courses c WHERE id=ANY(p_ids);
 IF p_action='DELETE' THEN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(usage) x WHERE NOT (x->>'canDelete')::boolean) THEN
   RAISE EXCEPTION 'Selection contains courses in use. No courses deleted. Remove only unused links or archive instead.' USING ERRCODE='23503';
  END IF;
  DELETE FROM public.courses WHERE id=ANY(p_ids);
 ELSE
  UPDATE public.courses SET status='ARCHIVED',updated_at=now() WHERE id=ANY(p_ids);
 END IF;
 GET DIAGNOSTICS affected=ROW_COUNT;
 INSERT INTO public.audit_logs(user_id,action_code,module_code,entity_type,old_values,new_values)
 VALUES(p_actor,'ACADEMIC_COURSES_'||p_action,'ACADEMICS','courses',before_rows,jsonb_build_object('ids',p_ids,'affected',affected));
 RETURN jsonb_build_object('action',p_action,'affected',affected);
END $$;

-- Map all requested course/curriculum pairs and, for shared setup, open one
-- canonical offering per course/period. One RPC is one transaction.
CREATE OR REPLACE FUNCTION public.idmc_academic_save_mapping(p_items jsonb,p_shared boolean,p_year uuid,p_semester uuid,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item jsonb; c public.courses%ROWTYPE; target record; offer public.course_offerings%ROWTYPE;
 mapped integer=0; opened integer=0; seen uuid[]='{}'; course_id_value uuid; curriculum_id_value uuid;
 credits numeric; study_year integer; semester_number_value integer; category text; semester_record public.semesters%ROWTYPE;
BEGIN
 PERFORM public.idmc_academic_assert_actor(p_actor);
 IF jsonb_typeof(p_items)<>'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Provide 1 to 500 mapping rows'; END IF;
 IF p_shared THEN
  SELECT * INTO semester_record FROM public.semesters WHERE id=p_semester AND academic_year_id=p_year;
  IF NOT FOUND OR semester_record.status IN ('CLOSED','ARCHIVED') THEN RAISE EXCEPTION 'Choose a valid open/planned semester in the selected academic year'; END IF;
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  course_id_value=(item->>'courseId')::uuid; curriculum_id_value=(item->>'curriculumId')::uuid;
  IF item->>'creditUnits' IS NULL OR trim(item->>'creditUnits')='' THEN RAISE EXCEPTION 'Every mapping requires explicit credits'; END IF;
  credits=(item->>'creditUnits')::numeric;study_year=(item->>'yearNumber')::integer;semester_number_value=(item->>'semesterNumber')::integer;
  category=coalesce(item->>'courseCategory','CORE');
  IF credits IS NULL OR credits<0 OR credits>9999 OR study_year IS NULL OR study_year<1 OR semester_number_value IS NULL OR semester_number_value<1 THEN RAISE EXCEPTION 'Invalid credits, study year or semester'; END IF;
  IF category NOT IN ('CORE','ELECTIVE','OPTIONAL','GENERAL','PRACTICAL','FIELD','CLINICAL','PROJECT','OTHER') THEN RAISE EXCEPTION 'Invalid course category'; END IF;
  SELECT * INTO c FROM public.courses WHERE id=course_id_value AND status='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Selected course is missing or inactive'; END IF;
  SELECT cu.*,pv.programme_id,pv.status version_status,p.status programme_status,p.institution_id,p.department_id
  INTO target FROM public.curricula cu JOIN public.programme_versions pv ON pv.id=cu.programme_version_id JOIN public.programmes p ON p.id=pv.programme_id WHERE cu.id=curriculum_id_value;
  IF NOT FOUND OR target.status<>'ACTIVE' OR target.version_status<>'ACTIVE' OR target.programme_status<>'ACTIVE' THEN RAISE EXCEPTION 'Target curriculum, version and programme must be active'; END IF;
  IF target.institution_id<>c.institution_id THEN RAISE EXCEPTION 'Course and target programme belong to different institutions'; END IF;
  IF p_shared AND semester_number_value<>semester_record.semester_number THEN RAISE EXCEPTION 'Course mapping semester must match the offering semester'; END IF;
  IF NOT p_shared AND NOT c.cross_cutting AND c.department_id IS DISTINCT FROM target.department_id THEN RAISE EXCEPTION 'Use cross-cutting setup to share a course with another department'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(curriculum_id_value::text,0));
  INSERT INTO public.curriculum_courses(curriculum_id,course_id,year_number,semester_number,course_category,is_compulsory,credit_units)
  VALUES(curriculum_id_value,c.id,study_year,semester_number_value,category,coalesce((item->>'isCompulsory')::boolean,true),credits)
  ON CONFLICT(curriculum_id,course_id) DO UPDATE SET year_number=EXCLUDED.year_number,semester_number=EXCLUDED.semester_number,course_category=EXCLUDED.course_category,is_compulsory=EXCLUDED.is_compulsory,credit_units=EXCLUDED.credit_units,updated_at=now();
  mapped=mapped+1;
  IF p_shared THEN
   UPDATE public.courses SET cross_cutting=true,updated_at=now() WHERE id=c.id;
   IF NOT c.id=ANY(seen) THEN
    seen=array_append(seen,c.id);
    SELECT * INTO offer FROM public.course_offerings WHERE course_id=c.id AND academic_year_id=p_year AND semester_id=p_semester AND status IN ('OPEN','DRAFT') ORDER BY (status='OPEN') DESC,id LIMIT 1 FOR UPDATE;
    IF FOUND THEN
     IF offer.status='DRAFT' THEN UPDATE public.course_offerings SET status='OPEN',updated_by=p_actor,updated_at=now() WHERE id=offer.id; END IF;
    ELSE
     IF EXISTS(SELECT 1 FROM public.course_offerings WHERE course_id=c.id AND academic_year_id=p_year AND semester_id=p_semester) THEN RAISE EXCEPTION 'This course already has a closed/suspended/completed offering. Review it explicitly before reopening'; END IF;
     INSERT INTO public.course_offerings(academic_year_id,semester_id,programme_id,programme_version_id,course_id,offering_code,section_name,status,created_by,updated_by)
     VALUES(p_year,p_semester,target.programme_id,target.programme_version_id,c.id,'SHARED-'||replace(c.id::text,'-','')||'-'||replace(p_semester::text,'-',''),'SHARED','OPEN',p_actor,p_actor);
    END IF;
    opened=opened+1;
   END IF;
  END IF;
 END LOOP;
 INSERT INTO public.audit_logs(user_id,action_code,module_code,entity_type,new_values) VALUES(p_actor,CASE WHEN p_shared THEN 'ACADEMIC_SHARED_SETUP' ELSE 'ACADEMIC_MAPPING_BATCH' END,'ACADEMICS','curriculum_courses',jsonb_build_object('items',p_items,'year',p_year,'semester',p_semester,'mapped',mapped,'offerings',opened));
 RETURN jsonb_build_object('mapped',mapped,'offerings',opened,'shared',p_shared);
END $$;

CREATE OR REPLACE FUNCTION public.idmc_academic_department_group(p_department uuid,p_group text,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE before_row jsonb; after_row jsonb;
BEGIN
 PERFORM public.idmc_academic_assert_actor(p_actor);
 IF p_group IS NOT NULL AND p_group NOT IN ('SOCIAL','PROJECT') THEN RAISE EXCEPTION 'Invalid department group'; END IF;
 SELECT to_jsonb(d) INTO before_row FROM public.departments d WHERE id=p_department FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Department not found'; END IF;
 UPDATE public.departments SET academic_group=p_group WHERE id=p_department RETURNING to_jsonb(departments.*) INTO after_row;
 INSERT INTO public.audit_logs(user_id,action_code,module_code,entity_type,entity_id,old_values,new_values) VALUES(p_actor,'ACADEMIC_DEPARTMENT_GROUP','ACADEMICS','departments',p_department,before_row,after_row);
 RETURN after_row;
END $$;
REVOKE ALL ON FUNCTION public.idmc_academic_department_group(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_academic_department_group(uuid,text,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.idmc_academic_assert_actor(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.idmc_academic_course_usage(uuid[]) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.idmc_academic_course_action(uuid[],text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.idmc_academic_save_mapping(jsonb,boolean,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_academic_course_usage(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.idmc_academic_course_action(uuid[],text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.idmc_academic_save_mapping(jsonb,boolean,uuid,uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
