BEGIN;
-- One atomic save: owning department, Course Master and explicit programme placement.
CREATE OR REPLACE FUNCTION public.idmc_academic_save_course(p_course jsonb,p_id uuid,p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.courses%ROWTYPE; old_row jsonb; dept public.departments%ROWTYPE;
 target record; candidates uuid[]; programme uuid; curriculum uuid; mapped jsonb;
 map_requested boolean; placement boolean; course_value uuid; period public.semesters%ROWTYPE; offer uuid;
BEGIN
 PERFORM public.idmc_academic_assert_actor(p_actor);
 IF jsonb_typeof(p_course) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Course details are required'; END IF;
 IF p_id IS NOT NULL THEN SELECT * INTO c FROM public.courses WHERE id=p_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Course not found'; END IF; old_row=to_jsonb(c); END IF;
 c.institution_id=coalesce(nullif(p_course->>'institutionId','')::uuid,c.institution_id);
 c.department_id=coalesce(nullif(p_course->>'departmentId','')::uuid,c.department_id);
 c.course_code=coalesce(nullif(btrim(p_course->>'courseCode'),''),c.course_code);
 c.course_name=coalesce(nullif(btrim(p_course->>'courseName'),''),c.course_name);
 c.credit_units=coalesce(nullif(p_course->>'creditUnits','')::numeric,c.credit_units,0);
 c.course_short_name=CASE WHEN p_course ? 'courseShortName' THEN nullif(p_course->>'courseShortName','') ELSE c.course_short_name END;
 c.contact_hours=CASE WHEN p_course ? 'contactHours' THEN nullif(p_course->>'contactHours','')::numeric ELSE c.contact_hours END;
 c.course_type=coalesce(nullif(p_course->>'courseType',''),c.course_type,'CORE');
 c.level=CASE WHEN p_course ? 'level' THEN nullif(p_course->>'level','') ELSE c.level END;
 c.description=CASE WHEN p_course ? 'description' THEN nullif(p_course->>'description','') ELSE c.description END;
 c.status=coalesce(nullif(p_course->>'status',''),c.status,'ACTIVE');
 c.cross_cutting=coalesce((p_course->>'crossCutting')::boolean,c.cross_cutting,false);
 SELECT * INTO dept FROM public.departments WHERE id=c.department_id;
 IF NOT FOUND OR dept.status<>'ACTIVE' OR dept.institution_id IS DISTINCT FROM c.institution_id THEN RAISE EXCEPTION 'Assign an active owning department from the same institution'; END IF;
 IF c.course_code IS NULL OR c.course_name IS NULL THEN RAISE EXCEPTION 'Course code and name are required'; END IF;
 IF c.credit_units<0 OR c.credit_units>9999 OR c.credit_units::text='NaN' OR c.contact_hours<0 OR c.contact_hours::text='NaN' THEN RAISE EXCEPTION 'Invalid course credits/contact hours'; END IF;
 -- Default auto placement for newly created courses; editing never silently overwrites mappings.
 map_requested=coalesce((p_course->>'autoMap')::boolean,p_id IS NULL AND nullif(p_course->>'yearNumber','') IS NOT NULL AND nullif(p_course->>'semesterNumber','') IS NOT NULL);
 programme=nullif(p_course->>'programmeId','')::uuid; curriculum=nullif(p_course->>'curriculumId','')::uuid;
 placement=map_requested OR programme IS NOT NULL OR curriculum IS NOT NULL;
 IF placement THEN
  IF c.status<>'ACTIVE' THEN RAISE EXCEPTION 'Automatic programme placement requires an active course'; END IF;
  IF programme IS NULL AND curriculum IS NOT NULL THEN SELECT pv.programme_id INTO programme FROM public.curricula cu JOIN public.programme_versions pv ON pv.id=cu.programme_version_id WHERE cu.id=curriculum; END IF;
  IF programme IS NULL THEN
   SELECT array_agg(p.id ORDER BY p.id) INTO candidates FROM public.programmes p WHERE p.department_id=c.department_id AND p.institution_id=c.institution_id AND p.status='ACTIVE';
   IF coalesce(cardinality(candidates),0)<>1 THEN RAISE EXCEPTION 'Choose programme by name: owning department has % active programmes',coalesce(cardinality(candidates),0); END IF;
   programme=candidates[1];
  END IF;
  IF curriculum IS NULL THEN
   SELECT array_agg(cu.id ORDER BY cu.id) INTO candidates FROM public.curricula cu JOIN public.programme_versions pv ON pv.id=cu.programme_version_id WHERE pv.programme_id=programme AND pv.status='ACTIVE' AND cu.status='ACTIVE';
   IF coalesce(cardinality(candidates),0)<>1 THEN RAISE EXCEPTION 'Choose curriculum by name: programme has % active curricula',coalesce(cardinality(candidates),0); END IF;
   curriculum=candidates[1];
  END IF;
  SELECT cu.id,cu.programme_version_id,pv.programme_id,pv.status version_status,cu.status curriculum_status,p.status programme_status,p.department_id,p.institution_id
   INTO target FROM public.curricula cu JOIN public.programme_versions pv ON pv.id=cu.programme_version_id JOIN public.programmes p ON p.id=pv.programme_id WHERE cu.id=curriculum;
  IF NOT FOUND OR target.programme_id IS DISTINCT FROM programme OR target.institution_id IS DISTINCT FROM c.institution_id OR target.version_status<>'ACTIVE' OR target.curriculum_status<>'ACTIVE' OR target.programme_status<>'ACTIVE' THEN RAISE EXCEPTION 'Choose an active curriculum/version belonging to the selected programme and institution'; END IF;
  IF NOT c.cross_cutting AND target.department_id IS DISTINCT FROM c.department_id THEN RAISE EXCEPTION 'Owning department must match programme; use cross-cutting for another department'; END IF;
  IF nullif(p_course->>'yearNumber','') IS NULL OR nullif(p_course->>'semesterNumber','') IS NULL THEN RAISE EXCEPTION 'Enter study year and semester for automatic curriculum placement'; END IF;
 END IF;
 IF p_id IS NOT NULL AND NOT c.cross_cutting AND EXISTS(SELECT 1 FROM public.curriculum_courses cc JOIN public.curricula cu ON cu.id=cc.curriculum_id JOIN public.programme_versions pv ON pv.id=cu.programme_version_id JOIN public.programmes p ON p.id=pv.programme_id WHERE cc.course_id=p_id AND (p.department_id IS DISTINCT FROM c.department_id OR p.institution_id IS DISTINCT FROM c.institution_id)) THEN RAISE EXCEPTION 'Existing mappings use another department. Keep cross-cutting enabled or review those mappings first'; END IF;
 IF p_id IS NULL THEN
  INSERT INTO public.courses(institution_id,department_id,course_code,course_name,course_short_name,credit_units,contact_hours,course_type,level,description,status,cross_cutting)
  VALUES(c.institution_id,c.department_id,c.course_code,c.course_name,c.course_short_name,c.credit_units,c.contact_hours,c.course_type,c.level,c.description,c.status,c.cross_cutting) RETURNING id INTO course_value;
 ELSE
  course_value=p_id; UPDATE public.courses SET institution_id=c.institution_id,department_id=c.department_id,course_code=c.course_code,course_name=c.course_name,course_short_name=c.course_short_name,credit_units=c.credit_units,contact_hours=c.contact_hours,course_type=c.course_type,level=c.level,description=c.description,status=c.status,cross_cutting=c.cross_cutting,updated_at=now() WHERE id=p_id;
 END IF;
 IF placement THEN
  mapped=public.idmc_academic_save_mapping(jsonb_build_array(jsonb_build_object('courseId',course_value,'curriculumId',curriculum,'creditUnits',coalesce(nullif(p_course->>'mappingCredits','')::numeric,c.credit_units),'courseCategory',coalesce(nullif(p_course->>'courseCategory',''),c.course_type),'isCompulsory',coalesce((p_course->>'isCompulsory')::boolean,coalesce(nullif(p_course->>'courseCategory',''),c.course_type)='CORE'),'yearNumber',(p_course->>'yearNumber')::integer,'semesterNumber',(p_course->>'semesterNumber')::integer)),false,null,null,p_actor);
 END IF;
 IF nullif(p_course->>'academicYearId','') IS NOT NULL OR nullif(p_course->>'semesterId','') IS NOT NULL THEN
  IF NOT placement THEN RAISE EXCEPTION 'Map the programme curriculum before opening delivery'; END IF;
  SELECT * INTO period FROM public.semesters WHERE id=nullif(p_course->>'semesterId','')::uuid AND academic_year_id=nullif(p_course->>'academicYearId','')::uuid;
  IF NOT FOUND OR period.status NOT IN ('PLANNED','ACTIVE') OR period.semester_number<>(p_course->>'semesterNumber')::integer THEN RAISE EXCEPTION 'Choose a planned/active academic semester matching curriculum placement'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.academic_years WHERE id=period.academic_year_id AND status IN ('PLANNED','ACTIVE')) THEN RAISE EXCEPTION 'Academic year is closed or missing'; END IF;
  SELECT id INTO offer FROM public.course_offerings WHERE course_id=course_value AND programme_id=programme AND programme_version_id=target.programme_version_id AND academic_year_id=period.academic_year_id AND semester_id=period.id AND status IN ('DRAFT','OPEN') ORDER BY id LIMIT 1;
  IF offer IS NULL THEN
   IF EXISTS(SELECT 1 FROM public.course_offerings WHERE course_id=course_value AND programme_id=programme AND programme_version_id=target.programme_version_id AND academic_year_id=period.academic_year_id AND semester_id=period.id) THEN RAISE EXCEPTION 'A closed offering already exists; review it explicitly'; END IF;
   INSERT INTO public.course_offerings(course_id,programme_id,programme_version_id,academic_year_id,semester_id,offering_code,status,created_by,updated_by)
   VALUES(course_value,programme,target.programme_version_id,period.academic_year_id,period.id,'AUTO-'||replace(course_value::text,'-','')||'-'||substr(md5(curriculum::text||period.id::text),1,16),'OPEN',p_actor,p_actor) RETURNING id INTO offer;
  END IF;
 END IF;
 INSERT INTO public.audit_logs(user_id,action_code,module_code,entity_type,entity_id,old_values,new_values) VALUES(p_actor,'ACADEMIC_COURSE_MASTER_SAVE','ACADEMICS','courses',course_value,old_row,jsonb_build_object('course',p_course,'mapping',mapped,'offeringId',offer));
 RETURN (SELECT to_jsonb(saved_course) FROM public.courses saved_course WHERE saved_course.id=course_value)||jsonb_build_object('id',course_value,'mapped',coalesce((mapped->>'mapped')::integer,0),'programmeId',programme,'curriculumId',curriculum,'offeringId',offer);
END $$;
REVOKE ALL ON FUNCTION public.idmc_academic_save_course(jsonb,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_academic_save_course(jsonb,uuid,uuid) TO service_role;
-- Named timetable input resolves only inside the chosen timetable period.
CREATE OR REPLACE FUNCTION public.idmc_timetable_named_rows(p_timetable uuid,p_rows jsonb,p_actor uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item jsonb; ids uuid[]; rows_value jsonb='[]'; tt record;
BEGIN
 IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Provide 1 to 500 timetable rows'; END IF;
 SELECT academic_year_id,semester_id INTO tt FROM public.timetables WHERE id=p_timetable;
 IF NOT FOUND THEN RAISE EXCEPTION 'Choose an existing timetable'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  IF nullif(item->>'courseOfferingId','') IS NOT NULL THEN rows_value=rows_value||jsonb_build_array(item); CONTINUE; END IF;
  SELECT array_agg(o.id ORDER BY o.id) INTO ids FROM public.course_offerings o JOIN public.courses c ON c.id=o.course_id JOIN public.programmes p ON p.id=o.programme_id
  WHERE o.academic_year_id=tt.academic_year_id AND o.semester_id=tt.semester_id
   AND (nullif(item->>'courseName','') IS NOT NULL OR nullif(item->>'courseCode','') IS NOT NULL OR nullif(item->>'offeringCode','') IS NOT NULL)
   AND (nullif(item->>'courseName','') IS NULL OR lower(btrim(c.course_name))=lower(btrim(item->>'courseName')))
   AND (nullif(item->>'courseCode','') IS NULL OR lower(btrim(c.course_code))=lower(btrim(item->>'courseCode')))
   AND (nullif(item->>'programmeName','') IS NULL OR lower(btrim(p.programme_name))=lower(btrim(item->>'programmeName')) OR lower(btrim(p.programme_code))=lower(btrim(item->>'programmeName')))
   AND (nullif(item->>'programme','') IS NULL OR lower(btrim(p.programme_name))=lower(btrim(item->>'programme')) OR lower(btrim(p.programme_code))=lower(btrim(item->>'programme')))
   AND (nullif(item->>'offeringCode','') IS NULL OR lower(btrim(o.offering_code))=lower(btrim(item->>'offeringCode')));
  IF coalesce(cardinality(ids),0)<>1 THEN RAISE EXCEPTION 'Course name/code is missing or ambiguous in selected timetable period. Specify programmeName and offeringCode'; END IF;
  rows_value=rows_value||jsonb_build_array(item||jsonb_build_object('courseOfferingId',ids[1]));
 END LOOP;
 RETURN public.idmc_timetable_rows(p_timetable,rows_value,p_actor);
END $$;
REVOKE ALL ON FUNCTION public.idmc_timetable_named_rows(uuid,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_timetable_named_rows(uuid,jsonb,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
