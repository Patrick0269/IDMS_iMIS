BEGIN;
CREATE OR REPLACE FUNCTION public.idmc_assessment_batch(p_data jsonb,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE x jsonb; oid uuid; aid uuid; used numeric; weight numeric:=(p_data->>'weightPercentage')::numeric; result jsonb:='[]';
BEGIN
 IF coalesce(jsonb_array_length(p_data->'courseOfferingIds'),0) NOT BETWEEN 1 AND 100 OR weight<=0 OR weight>100 THEN RAISE EXCEPTION 'Select courses and a valid weight'; END IF;
 FOR x IN SELECT * FROM jsonb_array_elements(p_data->'courseOfferingIds') LOOP
 oid:=(x#>>'{}')::uuid; PERFORM 1 FROM public.course_offerings WHERE id=oid FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Course offering not found'; END IF;
 SELECT coalesce(sum(weight_percentage),0) INTO used FROM public.assessments WHERE course_offering_id=oid AND status<>'CANCELLED';
 IF used+weight>100 THEN RAISE EXCEPTION 'Assessment weights exceed 100 percent for %',oid; END IF;
 INSERT INTO public.assessments(course_offering_id,assessment_code,assessment_name,assessment_type,maximum_marks,weight_percentage,status,created_by,due_date,instructions)
 VALUES(oid,p_data->>'assessmentCode',p_data->>'assessmentName',p_data->>'assessmentType',(p_data->>'maximumMarks')::numeric,weight,'DRAFT',p_actor,NULLIF(p_data->>'dueDate','')::date,NULLIF(p_data->>'instructions','')) RETURNING id INTO aid;
 result:=result||jsonb_build_object('id',aid,'courseOfferingId',oid);
 END LOOP; RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.idmc_staff_bundle(p_data jsonb,p_actor uuid) RETURNS uuid LANGUAGE plpgsql SET search_path=public AS $$
DECLARE sid uuid; x jsonb;
BEGIN
 INSERT INTO public.staff(institution_id,department_id,employee_number,first_name,middle_name,last_name,email,phone,job_title,staff_category,employment_type,appointment_date,highest_qualification,physical_address,emergency_contact_name,emergency_contact_phone,created_by)
 VALUES((p_data->>'institutionId')::uuid,NULLIF(p_data->>'departmentId','')::uuid,p_data->>'employeeNumber',p_data->>'firstName',NULLIF(p_data->>'middleName',''),p_data->>'lastName',p_data->>'email',p_data->>'phone',p_data->>'jobTitle',coalesce(p_data->>'staffCategory','ADMINISTRATIVE'),coalesce(p_data->>'employmentType','FULL_TIME'),NULLIF(p_data->>'appointmentDate','')::date,p_data->>'highestQualification',p_data->>'physicalAddress',p_data->>'emergencyContactName',p_data->>'emergencyContactPhone',p_actor) RETURNING id INTO sid;
 FOR x IN SELECT * FROM jsonb_array_elements(coalesce(p_data->'qualifications','[]')) LOOP
 INSERT INTO public.staff_qualifications(staff_id,qualification_level,qualification_name,institution_name,field_of_study,completion_year,certificate_number)
 VALUES(sid,x->>'qualificationLevel',x->>'qualificationName',x->>'institutionName',x->>'fieldOfStudy',NULLIF(x->>'completionYear','')::integer,x->>'certificateNumber');
 END LOOP;
 FOR x IN SELECT * FROM jsonb_array_elements(coalesce(p_data->'history','[]')) LOOP
 INSERT INTO public.staff_employment_history(staff_id,job_title,employment_type,start_date,end_date,notes) VALUES(sid,x->>'jobTitle',coalesce(x->>'employmentType','FULL_TIME'),(x->>'startDate')::date,NULLIF(x->>'endDate','')::date,x->>'notes');
 END LOOP;
 FOR x IN SELECT * FROM jsonb_array_elements(coalesce(p_data->'files','[]')) LOOP
 INSERT INTO public.idmc_staff_files(staff_id,file_name,mime_type,document_type,content_base64,uploaded_by) VALUES(sid,x->>'fileName',x->>'mimeType',x->>'documentType',x->>'contentBase64',p_actor);
 END LOOP;
 INSERT INTO public.idmc_workflow_events(entity_id,action,actor_id) VALUES(sid,'STAFF_REGISTERED',p_actor); RETURN sid;
END $$;
CREATE OR REPLACE FUNCTION public.idmc_marks_window_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE actor uuid; oid uuid; opened boolean;
BEGIN
 IF TG_TABLE_NAME='course_results' AND (to_jsonb(NEW)->>'result_status') IS DISTINCT FROM 'SUBMITTED' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME<>'course_results' AND (to_jsonb(NEW)->>'status') NOT IN ('DRAFT','SUBMITTED') THEN RETURN NEW; END IF;
 actor:=coalesce((to_jsonb(NEW)->>'submitted_by')::uuid,(to_jsonb(NEW)->>'entered_by')::uuid);
 IF actor IS NULL THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id=ur.role_id WHERE ur.user_id=actor AND ur.status='ACTIVE' AND r.status='ACTIVE' AND (ur.expires_at IS NULL OR ur.expires_at>now()) AND r.role_code='LECTURER')
 AND NOT EXISTS(SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id=ur.role_id WHERE ur.user_id=actor AND ur.status='ACTIVE' AND r.status='ACTIVE' AND (ur.expires_at IS NULL OR ur.expires_at>now()) AND r.role_code IN ('ADMIN','SUPER_ADMIN','HOD','ACADEMIC_OFFICER','EXAMINATION_OFFICER','EXAM_OFFICER')) THEN
 IF TG_TABLE_NAME='assessment_marks' THEN SELECT course_offering_id INTO oid FROM public.assessments WHERE id=NEW.assessment_id;
 ELSIF TG_TABLE_NAME='examination_marks' THEN SELECT course_offering_id INTO oid FROM public.examination_papers WHERE id=NEW.examination_paper_id;
 ELSE oid:=(to_jsonb(NEW)->>'course_offering_id')::uuid; END IF;
 SELECT is_open INTO opened FROM public.idmc_result_windows WHERE course_offering_id=oid FOR SHARE;
 IF NOT coalesce(opened,false) THEN RAISE EXCEPTION 'HOD marks entry window is closed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.lecturer_assignments WHERE lecturer_user_id=actor AND course_offering_id=oid AND assignment_status='ACTIVE') THEN RAISE EXCEPTION 'Course is not assigned to this lecturer'; END IF;
 END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS idmc_marks_window ON public.assessment_marks;
CREATE TRIGGER idmc_marks_window BEFORE INSERT OR UPDATE ON public.assessment_marks FOR EACH ROW EXECUTE FUNCTION public.idmc_marks_window_guard();
DROP TRIGGER IF EXISTS idmc_marks_window ON public.examination_marks;
CREATE TRIGGER idmc_marks_window BEFORE INSERT OR UPDATE ON public.examination_marks FOR EACH ROW EXECUTE FUNCTION public.idmc_marks_window_guard();
DROP TRIGGER IF EXISTS idmc_marks_window ON public.course_results;
CREATE TRIGGER idmc_marks_window BEFORE INSERT OR UPDATE ON public.course_results FOR EACH ROW EXECUTE FUNCTION public.idmc_marks_window_guard();
REVOKE ALL ON FUNCTION public.idmc_assessment_batch(jsonb,uuid),public.idmc_staff_bundle(jsonb,uuid),public.idmc_marks_window_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_assessment_batch(jsonb,uuid),public.idmc_staff_bundle(jsonb,uuid) TO service_role;
COMMIT;
