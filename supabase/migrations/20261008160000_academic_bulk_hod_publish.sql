BEGIN;
CREATE OR REPLACE FUNCTION public.idmc_academic_assert_actor(p_actor uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM public.users u JOIN public.user_roles ur ON ur.user_id=u.id JOIN public.roles r ON r.id=ur.role_id
  JOIN public.role_permissions rp ON rp.role_id=r.id JOIN public.permissions p ON p.id=rp.permission_id
  WHERE u.id=p_actor AND u.status='ACTIVE' AND ur.status='ACTIVE' AND r.status='ACTIVE'
  AND (ur.expires_at IS NULL OR ur.expires_at>now()) AND coalesce((to_jsonb(rp)->>'granted')::boolean,true) AND p.status='ACTIVE' AND p.permission_code='academics.manage'
 ) THEN RAISE EXCEPTION 'Active academics.manage permission required' USING ERRCODE='42501'; END IF;
END $$;


-- Every incoming FK is checked, including CASCADE and newly added modules.
CREATE OR REPLACE FUNCTION public.idmc_setup_row_usage(p_table regclass,p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE fk record; n bigint; answer jsonb='{}';
BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint k WHERE k.contype='f' AND k.confrelid=p_table
 AND (cardinality(k.conkey)<>1 OR cardinality(k.confkey)<>1 OR k.confkey[1]<>(SELECT attnum FROM pg_attribute WHERE attrelid=p_table AND attname='id')))
 THEN RAISE EXCEPTION 'Nonstandard foreign key: review dependencies before cleanup'; END IF;
 FOR fk IN SELECT ns.nspname schema_name,c.relname table_name,a.attname column_name
 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace
 JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=k.conkey[1]
 WHERE k.contype='f' AND k.confrelid=p_table LOOP
  EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I=ANY($1)',fk.schema_name,fk.table_name,fk.column_name) INTO n USING p_ids;
  IF n>0 THEN answer=answer||jsonb_build_object(fk.schema_name||'.'||fk.table_name||'.'||fk.column_name,n); END IF;
 END LOOP;
 RETURN answer;
END $$;
CREATE OR REPLACE FUNCTION public.idmc_academic_course_cleanup_preview(p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item jsonb; blockers jsonb; offers uuid[]; maps uuid[]; result jsonb='[]';
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements(public.idmc_academic_course_usage(p_ids)) LOOP
  blockers=(item->'references')-'public.course_offerings.course_id'-'public.curriculum_courses.course_id';
  SELECT coalesce(array_agg(id),'{}') INTO offers FROM public.course_offerings WHERE course_id=(item->>'id')::uuid;
  SELECT coalesce(array_agg(id),'{}') INTO maps FROM public.curriculum_courses WHERE course_id=(item->>'id')::uuid;
  blockers=blockers||public.idmc_setup_row_usage('public.course_offerings'::regclass,offers)
    ||public.idmc_setup_row_usage('public.curriculum_courses'::regclass,maps);
  IF EXISTS(SELECT 1 FROM public.course_offerings WHERE id=ANY(offers) AND status NOT IN ('DRAFT','OPEN')) THEN
   blockers=blockers||jsonb_build_object('protected_offering_status',1);
  END IF;
  result=result||jsonb_build_array(item||jsonb_build_object('canUnuse',blockers='{}','blockers',blockers,'offerings',cardinality(offers),'mappings',cardinality(maps)));
 END LOOP;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.idmc_academic_course_cleanup(p_ids uuid[],p_action text,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE preview jsonb; old_offers jsonb; old_maps jsonb; n integer; m integer;
BEGIN
 PERFORM public.idmc_academic_assert_actor(p_actor);
 IF p_action NOT IN ('UNUSE','UNUSE_DELETE') THEN RAISE EXCEPTION 'Unsupported cleanup action'; END IF;
 PERFORM 1 FROM public.courses WHERE id=ANY(p_ids) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.course_offerings WHERE course_id=ANY(p_ids) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.curriculum_courses WHERE course_id=ANY(p_ids) ORDER BY id FOR UPDATE;
 preview=public.idmc_academic_course_cleanup_preview(p_ids);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(preview) x WHERE NOT (x->>'canUnuse')::boolean) THEN
  RAISE EXCEPTION 'Selection has academic activity or protected dependencies. Nothing removed; review blockers or archive.' USING ERRCODE='23503';
 END IF;
 SELECT jsonb_agg(to_jsonb(o)) INTO old_offers FROM public.course_offerings o WHERE course_id=ANY(p_ids);
 SELECT jsonb_agg(to_jsonb(mapping_row)) INTO old_maps FROM public.curriculum_courses mapping_row WHERE course_id=ANY(p_ids);
 DELETE FROM public.course_offerings WHERE course_id=ANY(p_ids); GET DIAGNOSTICS n=ROW_COUNT;
 DELETE FROM public.curriculum_courses WHERE course_id=ANY(p_ids); GET DIAGNOSTICS m=ROW_COUNT;
 IF p_action='UNUSE_DELETE' THEN PERFORM public.idmc_academic_course_action(p_ids,'DELETE',p_actor); END IF;
 INSERT INTO public.audit_logs(user_id,action_code,module_code,entity_type,old_values,new_values)
 VALUES(p_actor,'ACADEMIC_COURSES_'||p_action,'ACADEMICS','courses',jsonb_build_object('offerings',old_offers,'mappings',old_maps),jsonb_build_object('ids',p_ids,'offeringsRemoved',n,'mappingsRemoved',m));
 RETURN jsonb_build_object('affected',jsonb_array_length(preview),'offeringsRemoved',n,'mappingsRemoved',m,'action',p_action);
END $$;
CREATE OR REPLACE FUNCTION public.idmc_academic_create_curriculum(p_curriculum jsonb,p_items jsonb,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE curriculum_id_value uuid; items jsonb; mapped jsonb;
BEGIN
 PERFORM public.idmc_academic_assert_actor(p_actor);
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Select 1 to 500 courses'; END IF;
 IF p_curriculum->>'status' IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'Use ACTIVE status to create a curriculum with course mappings'; END IF;
 IF coalesce(btrim(p_curriculum->>'curriculumCode'),'')='' OR coalesce(btrim(p_curriculum->>'curriculumName'),'')='' THEN RAISE EXCEPTION 'Curriculum code and name are required'; END IF;
 INSERT INTO public.curricula(programme_version_id,curriculum_code,curriculum_name,effective_from,effective_to,total_credits,status)
 VALUES((p_curriculum->>'programmeVersionId')::uuid,btrim(p_curriculum->>'curriculumCode'),btrim(p_curriculum->>'curriculumName'),(p_curriculum->>'effectiveFrom')::date,nullif(p_curriculum->>'effectiveTo','')::date,nullif(p_curriculum->>'totalCredits','')::numeric,'ACTIVE') RETURNING id INTO curriculum_id_value;
 SELECT jsonb_agg(value||jsonb_build_object('curriculumId',curriculum_id_value)) INTO items FROM jsonb_array_elements(p_items);
 mapped=public.idmc_academic_save_mapping(items,false,null,null,p_actor);
 RETURN mapped||jsonb_build_object('curriculumId',curriculum_id_value);
END $$;

INSERT INTO public.permissions(permission_code,permission_name,module_code,action_code,description,status)
VALUES ('results.hod.publish','Publish Department Results','RESULTS','HOD_PUBLISH','HOD publishes submitted departmental results directly','ACTIVE'),
 ('results.principal.comment','Comment on Published Results','RESULTS','PRINCIPAL_COMMENT','Principal views published results and sends comments to HOD','ACTIVE')
ON CONFLICT(permission_code) DO UPDATE SET status='ACTIVE',description=EXCLUDED.description;
INSERT INTO public.role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM public.roles r CROSS JOIN public.permissions p
WHERE (r.role_code='HOD' AND p.permission_code='results.hod.publish') OR (r.role_code='PRINCIPAL' AND p.permission_code='results.principal.comment')
ON CONFLICT DO NOTHING;
DELETE FROM public.role_permissions rp USING public.roles r,public.permissions p
WHERE rp.role_id=r.id AND rp.permission_id=p.id AND r.role_code='PRINCIPAL' AND p.permission_code='results.principal.approve';

CREATE OR REPLACE FUNCTION public.idmc_result_actor(p_actor uuid,p_role text,p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.users u JOIN public.user_roles ur ON ur.user_id=u.id JOIN public.roles r ON r.id=ur.role_id
 JOIN public.role_permissions rp ON rp.role_id=r.id JOIN public.permissions p ON p.id=rp.permission_id
 WHERE u.id=p_actor AND u.status='ACTIVE' AND ur.status='ACTIVE' AND (ur.expires_at IS NULL OR ur.expires_at>now())
 AND r.status='ACTIVE' AND r.role_code=p_role AND p.status='ACTIVE' AND p.permission_code=p_permission
 AND coalesce((to_jsonb(rp)->>'granted')::boolean,true))
$$;
CREATE OR REPLACE FUNCTION public.idmc_hod_department(p_actor uuid,p_department uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.idmc_result_actor(p_actor,'HOD','results.hod.publish') AND (
 EXISTS(SELECT 1 FROM public.user_scopes WHERE user_id=p_actor AND scope_type='DEPARTMENT' AND department_id=p_department)
 OR EXISTS(SELECT 1 FROM public.staff WHERE user_id=p_actor AND department_id=p_department AND employment_status='ACTIVE'))
$$;
CREATE TABLE IF NOT EXISTS public.idmc_result_comments (
 id uuid PRIMARY KEY, result_id uuid NOT NULL REFERENCES public.course_results(id),
 principal_user_id uuid NOT NULL REFERENCES public.users(id), department_id uuid NOT NULL REFERENCES public.departments(id),
 comment text NOT NULL CHECK(length(btrim(comment)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_idmc_result_comments_result ON public.idmc_result_comments(result_id,created_at);
ALTER TABLE public.idmc_result_comments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.idmc_result_comments FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.idmc_result_comments TO service_role;

CREATE OR REPLACE FUNCTION public.idmc_hod_publish(p_result uuid,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.course_results%ROWTYPE; dept uuid;
BEGIN
 SELECT * INTO r FROM public.course_results WHERE id=p_result FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Result not found'; END IF;
 SELECT c.department_id INTO dept FROM public.course_offerings o JOIN public.courses c ON c.id=o.course_id WHERE o.id=r.course_offering_id;
 IF NOT public.idmc_hod_department(p_actor,dept) THEN RAISE EXCEPTION 'Active HOD permission for this department required' USING ERRCODE='42501'; END IF;
 IF r.result_status='PUBLISHED' THEN RETURN jsonb_build_object('id',r.id,'studentId',r.student_id,'alreadyPublished',true); END IF;
 IF r.result_status NOT IN ('SUBMITTED','HOD_VERIFIED','EXAMINATION_REVIEWED','DEPUTY_REVIEWED','PRINCIPAL_APPROVED','VERIFIED','APPROVED') THEN RAISE EXCEPTION 'Only submitted or reviewed results can be published'; END IF;
 UPDATE public.course_results SET result_status='PUBLISHED',published_by=p_actor,published_at=now(),hod_verified_by=coalesce(hod_verified_by,p_actor),hod_verified_at=coalesce(hod_verified_at,now()),updated_at=now() WHERE id=p_result;
 INSERT INTO public.audit_logs(user_id,action_code,module_code,entity_type,entity_id,old_values,new_values)
 VALUES(p_actor,'RESULT_HOD_PUBLISH','RESULTS','course_results',p_result,to_jsonb(r),jsonb_build_object('result_status','PUBLISHED','published_by',p_actor));
 RETURN jsonb_build_object('id',r.id,'studentId',r.student_id,'result_status','PUBLISHED','alreadyPublished',false);
END $$;
CREATE OR REPLACE FUNCTION public.idmc_principal_result_comment(p_result uuid,p_comment_id uuid,p_comment text,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.course_results%ROWTYPE; dept uuid; existing public.idmc_result_comments%ROWTYPE; recipients integer;
BEGIN
 IF NOT public.idmc_result_actor(p_actor,'PRINCIPAL','results.principal.comment') THEN RAISE EXCEPTION 'Active Principal comment permission required' USING ERRCODE='42501'; END IF;
 IF p_comment_id IS NULL OR p_comment IS NULL OR length(btrim(p_comment)) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Enter a comment of 1 to 2000 characters'; END IF;
 SELECT * INTO r FROM public.course_results WHERE id=p_result FOR UPDATE;
 IF NOT FOUND OR r.result_status NOT IN ('PUBLISHED','LOCKED') THEN RAISE EXCEPTION 'Comment on published results only'; END IF;
 SELECT * INTO existing FROM public.idmc_result_comments WHERE id=p_comment_id;
 IF FOUND THEN
  IF existing.result_id<>p_result OR existing.principal_user_id<>p_actor OR existing.comment<>btrim(p_comment) THEN RAISE EXCEPTION 'Comment request ID already used'; END IF;
  RETURN jsonb_build_object('id',existing.id,'alreadySaved',true);
 END IF;
 SELECT c.department_id INTO dept FROM public.course_offerings o JOIN public.courses c ON c.id=o.course_id WHERE o.id=r.course_offering_id;
 INSERT INTO public.idmc_result_comments(id,result_id,principal_user_id,department_id,comment) VALUES(p_comment_id,p_result,p_actor,dept,btrim(p_comment));
 INSERT INTO public.notifications(notification_number,recipient_user_id,notification_type,title,body,priority,status,metadata)
 SELECT 'RC-'||p_comment_id::text||'-'||u.id::text,u.id,'RESULT_COMMENT','Principal comment on results',btrim(p_comment),'NORMAL','PENDING',jsonb_build_object('resultId',p_result,'commentId',p_comment_id,'href','hod-results.html')
 FROM public.users u WHERE u.status='ACTIVE' AND public.idmc_hod_department(u.id,dept);
 GET DIAGNOSTICS recipients=ROW_COUNT;
 INSERT INTO public.audit_logs(user_id,action_code,module_code,entity_type,entity_id,new_values)
 VALUES(p_actor,'RESULT_PRINCIPAL_COMMENT','RESULTS','idmc_result_comments',p_comment_id,jsonb_build_object('resultId',p_result,'recipients',recipients,'comment',btrim(p_comment)));
 RETURN jsonb_build_object('id',p_comment_id,'recipients',recipients,'alreadySaved',false);
END $$;
CREATE OR REPLACE FUNCTION public.idmc_result_workspace(p_actor uuid,p_mode text,p_offset integer,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE answer jsonb; total bigint;
BEGIN
 IF p_mode NOT IN ('HOD','PRINCIPAL') OR p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid results page'; END IF;
 IF NOT public.idmc_result_actor(p_actor,p_mode,CASE WHEN p_mode='HOD' THEN 'results.hod.publish' ELSE 'results.principal.comment' END) THEN RAISE EXCEPTION 'Active results workspace role required' USING ERRCODE='42501'; END IF;
 SELECT count(*) INTO total FROM public.course_results r JOIN public.course_offerings o ON o.id=r.course_offering_id JOIN public.courses c ON c.id=o.course_id
 WHERE (p_mode='HOD' AND public.idmc_hod_department(p_actor,c.department_id) AND r.result_status IN ('SUBMITTED','HOD_VERIFIED','EXAMINATION_REVIEWED','DEPUTY_REVIEWED','PRINCIPAL_APPROVED','VERIFIED','APPROVED','PUBLISHED','LOCKED'))
 OR (p_mode='PRINCIPAL' AND r.result_status IN ('PUBLISHED','LOCKED'));
 SELECT coalesce(jsonb_agg(to_jsonb(rows)),'[]') INTO answer FROM (
 SELECT r.id,r.result_status,r.total_mark,r.grade_code,r.student_id,s.student_number,concat_ws(' ',s.first_name,s.middle_name,s.last_name) student_name,
 concat_ws(' · ',c.course_code,c.course_name) course_label,y.year_name academic_year,se.semester_name,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('id',cm.id,'comment',cm.comment,'createdAt',cm.created_at,'principal',coalesce(u.display_name,u.email)) ORDER BY cm.created_at),'[]') FROM public.idmc_result_comments cm JOIN public.users u ON u.id=cm.principal_user_id WHERE cm.result_id=r.id) comments
 FROM public.course_results r JOIN public.course_offerings o ON o.id=r.course_offering_id JOIN public.courses c ON c.id=o.course_id
 JOIN public.students s ON s.id=r.student_id LEFT JOIN public.academic_years y ON y.id=r.academic_year_id LEFT JOIN public.semesters se ON se.id=r.semester_id
 WHERE (p_mode='HOD' AND public.idmc_hod_department(p_actor,c.department_id) AND r.result_status IN ('SUBMITTED','HOD_VERIFIED','EXAMINATION_REVIEWED','DEPUTY_REVIEWED','PRINCIPAL_APPROVED','VERIFIED','APPROVED','PUBLISHED','LOCKED'))
 OR (p_mode='PRINCIPAL' AND r.result_status IN ('PUBLISHED','LOCKED'))
 ORDER BY r.updated_at DESC,r.id LIMIT p_limit OFFSET p_offset) rows;
 RETURN jsonb_build_object('items',answer,'total',total,'offset',p_offset,'limit',p_limit);
END $$;
CREATE OR REPLACE FUNCTION public.validate_course_result_status_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE dept uuid;
BEGIN

  IF NEW.result_status='PUBLISHED' AND OLD.result_status<>'PUBLISHED' THEN
    SELECT c.department_id INTO dept FROM public.course_offerings o JOIN public.courses c ON c.id=o.course_id WHERE o.id=NEW.course_offering_id;
    IF OLD.result_status NOT IN ('SUBMITTED','HOD_VERIFIED','EXAMINATION_REVIEWED','DEPUTY_REVIEWED','PRINCIPAL_APPROVED','VERIFIED','APPROVED') OR NOT public.idmc_hod_department(NEW.published_by,dept) THEN
      RAISE EXCEPTION 'Only the department HOD can publish submitted results' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.result_status = OLD.result_status THEN RETURN NEW; END IF;
  IF OLD.result_status = 'DRAFT' AND NEW.result_status IN ('CALCULATED','CANCELLED') THEN RETURN NEW; END IF;
  IF OLD.result_status = 'CALCULATED' AND NEW.result_status IN ('SUBMITTED','DRAFT','CANCELLED') THEN RETURN NEW; END IF;
  IF OLD.result_status = 'SUBMITTED' AND NEW.result_status IN ('HOD_VERIFIED','CALCULATED') THEN RETURN NEW; END IF;
  IF OLD.result_status = 'HOD_VERIFIED' AND NEW.result_status IN ('EXAMINATION_REVIEWED','WITHHELD') THEN RETURN NEW; END IF;
  IF OLD.result_status = 'EXAMINATION_REVIEWED' AND NEW.result_status IN ('DEPUTY_REVIEWED','WITHHELD') THEN RETURN NEW; END IF;
  IF OLD.result_status = 'DEPUTY_REVIEWED' AND NEW.result_status IN ('PRINCIPAL_APPROVED','WITHHELD') THEN RETURN NEW; END IF;
  IF OLD.result_status = 'PRINCIPAL_APPROVED' AND NEW.result_status = 'PUBLISHED' THEN RETURN NEW; END IF;
  IF OLD.result_status = 'PUBLISHED' AND NEW.result_status = 'LOCKED' THEN RETURN NEW; END IF;
  IF OLD.result_status = 'WITHHELD' AND NEW.result_status = 'HOD_VERIFIED' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Invalid course result status transition: % -> %', OLD.result_status, NEW.result_status;
END;
$$;

-- Replace the earlier approval timestamp gate as well as the transition gate.
CREATE OR REPLACE FUNCTION public.validate_course_result_publication()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE dept uuid;
BEGIN
 IF NEW.result_status='PUBLISHED' AND OLD.result_status<>'PUBLISHED' THEN
  IF NEW.total_mark IS NULL OR NEW.grade_code IS NULL OR NEW.grade_point IS NULL OR NEW.pass_status IS NULL THEN
   RAISE EXCEPTION 'Complete result calculation before publication';
  END IF;
  SELECT c.department_id INTO dept FROM public.course_offerings o JOIN public.courses c ON c.id=o.course_id WHERE o.id=NEW.course_offering_id;
  IF NOT public.idmc_hod_department(NEW.published_by,dept) THEN RAISE EXCEPTION 'Department HOD must publish results' USING ERRCODE='42501'; END IF;
  NEW.published_at=coalesce(NEW.published_at,now());
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.idmc_setup_row_usage(regclass,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_setup_row_usage(regclass,uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.idmc_academic_course_cleanup_preview(uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_academic_course_cleanup_preview(uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.idmc_academic_course_cleanup(uuid[],text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_academic_course_cleanup(uuid[],text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.idmc_academic_create_curriculum(jsonb,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_academic_create_curriculum(jsonb,jsonb,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.idmc_result_actor(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_result_actor(uuid,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.idmc_hod_department(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_hod_department(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.idmc_hod_publish(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_hod_publish(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.idmc_principal_result_comment(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_principal_result_comment(uuid,uuid,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.idmc_result_workspace(uuid,text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_result_workspace(uuid,text,integer,integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
