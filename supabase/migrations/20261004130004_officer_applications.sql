BEGIN;
CREATE OR REPLACE FUNCTION public.idmc_officer_application(p_data jsonb,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE aid uuid; appid uuid; mail text:=lower(trim(p_data->>'email')); yr uuid:=(p_data->>'academicYearId')::uuid; prog uuid:=(p_data->>'programmeId')::uuid;
BEGIN
 IF coalesce(mail,'')='' OR coalesce(trim(p_data->>'firstName'),'')='' OR coalesce(trim(p_data->>'lastName'),'')='' THEN RAISE EXCEPTION 'Name and email are required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(mail||yr::text,0));
 IF NOT EXISTS(SELECT 1 FROM public.programmes WHERE id=prog AND status='ACTIVE') THEN RAISE EXCEPTION 'Select an active programme'; END IF;
 IF (SELECT count(*) FROM public.applicants WHERE lower(email)=mail)>1 THEN RAISE EXCEPTION 'More than one applicant uses this email; reconcile the records first'; END IF;
 SELECT id INTO aid FROM public.applicants WHERE lower(email)=mail;
 IF aid IS NULL THEN
 INSERT INTO public.applicants(applicant_number,first_name,middle_name,last_name,email,phone)
 VALUES('APP-'||left(gen_random_uuid()::text,16),trim(p_data->>'firstName'),nullif(trim(p_data->>'middleName'),''),trim(p_data->>'lastName'),mail,p_data->>'phone') RETURNING id INTO aid;
 END IF;
 SELECT id INTO appid FROM public.applications WHERE applicant_id=aid AND academic_year_id=yr AND status NOT IN ('CANCELLED','REJECTED') ORDER BY created_at DESC LIMIT 1;
 IF appid IS NOT NULL THEN RETURN jsonb_build_object('applicationId',appid,'applicantId',aid,'reused',true); END IF;
 INSERT INTO public.applications(applicant_id,academic_year_id,application_number,status) VALUES(aid,yr,'AP-'||gen_random_uuid()::text,'DRAFT') RETURNING id INTO appid;
 INSERT INTO public.application_choices(application_id,programme_id,choice_number) VALUES(appid,prog,1);
 INSERT INTO public.idmc_workflow_events(entity_id,action,actor_id,details) VALUES(appid,'OFFICER_APPLICATION_CREATED',p_actor,jsonb_build_object('applicant',aid));
 RETURN jsonb_build_object('applicationId',appid,'applicantId',aid,'reused',false);
END $$;
REVOKE ALL ON FUNCTION public.idmc_officer_application(jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_officer_application(jsonb,uuid) TO service_role;
COMMIT;
