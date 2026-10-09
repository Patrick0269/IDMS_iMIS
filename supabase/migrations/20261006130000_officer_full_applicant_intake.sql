BEGIN;

CREATE TABLE IF NOT EXISTS public.application_next_of_kin (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL UNIQUE REFERENCES public.applications(id) ON DELETE CASCADE,
  full_name varchar(200) NOT NULL,
  relationship varchar(100) NOT NULL,
  phone varchar(50) NOT NULL,
  email varchar(255),
  address varchar(500),
  recorded_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT application_next_of_kin_email_check CHECK (email IS NULL OR email ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
);

ALTER TABLE public.application_next_of_kin ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.application_next_of_kin FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.application_next_of_kin TO service_role;

CREATE OR REPLACE FUNCTION public.idmc_officer_application(p_data jsonb, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  aid uuid;
  appid uuid;
  year_id uuid := nullif(p_data->>'academicYearId', '')::uuid;
  programme_id uuid := nullif(p_data->>'programmeId', '')::uuid;
  second_programme_id uuid := nullif(p_data->>'secondProgrammeId', '')::uuid;
  mail text := lower(trim(p_data->>'email'));
  item jsonb;
  qualification_count integer := 0;
  applicant_existed boolean := false;
  app_number text := 'IDMC/APP/' || to_char(current_date, 'YYYY') || '/' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_actor AND status='ACTIVE') THEN
    RAISE EXCEPTION 'An active Admissions staff account is required';
  END IF;
  IF coalesce(mail, '') !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN RAISE EXCEPTION 'Enter a valid applicant email'; END IF;
  IF coalesce(p_data->>'applicantConfirmed','false') <> 'true' THEN RAISE EXCEPTION 'Confirm the applicant authorized this submission'; END IF;
  IF coalesce(trim(p_data->>'firstName'), '') = '' OR coalesce(trim(p_data->>'lastName'), '') = '' THEN RAISE EXCEPTION 'Applicant first and last names are required'; END IF;
  IF year_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.academic_years WHERE id=year_id AND status IN ('ACTIVE','OPEN')) THEN RAISE EXCEPTION 'Select an open academic year'; END IF;
  IF programme_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.programmes WHERE id=programme_id AND status='ACTIVE') THEN RAISE EXCEPTION 'Select an active first-choice programme'; END IF;
  IF second_programme_id IS NOT NULL AND (second_programme_id=programme_id OR NOT EXISTS (SELECT 1 FROM public.programmes WHERE id=second_programme_id AND status='ACTIVE')) THEN RAISE EXCEPTION 'Second choice must be a different active programme'; END IF;
  IF coalesce(trim(p_data->>'kinName'), '') = '' OR coalesce(trim(p_data->>'kinRelationship'), '') = '' OR coalesce(trim(p_data->>'kinPhone'), '') = '' THEN RAISE EXCEPTION 'Next of kin name, relationship and phone are required'; END IF;
  IF jsonb_typeof(p_data->'qualifications') <> 'array' OR jsonb_array_length(p_data->'qualifications') < 1 THEN RAISE EXCEPTION 'Enter at least one academic qualification'; END IF;
  IF (SELECT count(*) FROM public.applicants WHERE lower(email)=mail) > 1 THEN RAISE EXCEPTION 'More than one applicant uses this email; reconcile those records first'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(mail || year_id::text, 0));
  SELECT id INTO aid FROM public.applicants WHERE lower(email)=mail LIMIT 1;
  applicant_existed := aid IS NOT NULL;
  IF aid IS NULL THEN
    INSERT INTO public.applicants(applicant_number,first_name,middle_name,last_name,email,phone,date_of_birth,gender,nationality,national_id_number,passport_number,address_line_1,district,region,country,applicant_type,status)
    VALUES('APP-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,16)),trim(p_data->>'firstName'),nullif(trim(p_data->>'middleName'),''),trim(p_data->>'lastName'),mail,nullif(trim(p_data->>'phone'),''),nullif(p_data->>'dateOfBirth','')::date,nullif(p_data->>'gender',''),nullif(trim(p_data->>'nationality'),''),nullif(trim(p_data->>'nationalIdNumber'),''),nullif(trim(p_data->>'passportNumber'),''),nullif(trim(p_data->>'addressLine1'),''),nullif(trim(p_data->>'district'),''),nullif(trim(p_data->>'region'),''),'Tanzania','NEW','ACTIVE')
    RETURNING id INTO aid;
  ELSE
    UPDATE public.applicants SET
      first_name=trim(p_data->>'firstName'), middle_name=nullif(trim(p_data->>'middleName'),''), last_name=trim(p_data->>'lastName'),
      phone=coalesce(nullif(trim(p_data->>'phone'),''),phone), date_of_birth=coalesce(nullif(p_data->>'dateOfBirth','')::date,date_of_birth),
      gender=coalesce(nullif(p_data->>'gender',''),gender), nationality=coalesce(nullif(trim(p_data->>'nationality'),''),nationality),
      national_id_number=coalesce(nullif(trim(p_data->>'nationalIdNumber'),''),national_id_number), passport_number=coalesce(nullif(trim(p_data->>'passportNumber'),''),passport_number),
      address_line_1=coalesce(nullif(trim(p_data->>'addressLine1'),''),address_line_1), district=coalesce(nullif(trim(p_data->>'district'),''),district),
      region=coalesce(nullif(trim(p_data->>'region'),''),region), updated_at=now()
    WHERE id=aid;
  END IF;
  IF EXISTS (SELECT 1 FROM public.applications WHERE applicant_id=aid AND academic_year_id=year_id AND status NOT IN ('CANCELLED','REJECTED')) THEN
    RAISE EXCEPTION 'This applicant already has an active application for the selected academic year';
  END IF;

  INSERT INTO public.applications(applicant_id,academic_year_id,application_number,status,submitted_at,completion_percentage,review_comments)
  VALUES(aid,year_id,app_number,'SUBMITTED',now(),100,'Application submitted on the applicant behalf by Admissions; supporting documents and qualifications require verification.')
  RETURNING id INTO appid;
  INSERT INTO public.application_choices(application_id,programme_id,choice_number,preference_type) VALUES(appid,programme_id,1,'PREFERRED');
  IF second_programme_id IS NOT NULL THEN INSERT INTO public.application_choices(application_id,programme_id,choice_number,preference_type) VALUES(appid,second_programme_id,2,'ALTERNATIVE'); END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_data->'qualifications') LOOP
    IF coalesce(trim(item->>'type'),'') NOT IN ('SECONDARY','CERTIFICATE','DIPLOMA','ADVANCED_DIPLOMA','BACHELOR','POSTGRADUATE_DIPLOMA','MASTERS','PHD','PROFESSIONAL','OTHER') OR coalesce(trim(item->>'institutionName'),'')='' THEN
      RAISE EXCEPTION 'Each qualification needs a valid type and school or institution';
    END IF;
    INSERT INTO public.academic_qualifications(applicant_id,qualification_type,institution_name,country,award_name,index_number,completion_year,grade,verification_status,verification_comments)
    VALUES(aid,trim(item->>'type'),trim(item->>'institutionName'),'Tanzania',nullif(trim(item->>'awardName'),''),nullif(trim(item->>'indexNumber'),''),nullif(item->>'completionYear','')::integer,nullif(trim(item->>'grade'),''),'REQUIRES_REVIEW','Entered by Admissions officer; verify original certificates before eligibility decision.');
    qualification_count := qualification_count + 1;
  END LOOP;
  IF qualification_count=0 THEN RAISE EXCEPTION 'Enter at least one academic qualification'; END IF;
  INSERT INTO public.application_next_of_kin(application_id,full_name,relationship,phone,email,address,recorded_by)
  VALUES(appid,trim(p_data->>'kinName'),trim(p_data->>'kinRelationship'),trim(p_data->>'kinPhone'),nullif(lower(trim(p_data->>'kinEmail')),''),nullif(trim(p_data->>'kinAddress'),''),p_actor);
  INSERT INTO public.idmc_workflow_events(entity_id,action,actor_id,details)
  VALUES(appid,'OFFICER_APPLICATION_SUBMITTED',p_actor,jsonb_build_object('applicant',aid,'qualificationCount',qualification_count,'source','ADMISSIONS_OFFICER'));
  RETURN jsonb_build_object('applicationId',appid,'applicantId',aid,'applicationNumber',app_number,'applicantName',concat_ws(' ',trim(p_data->>'firstName'),nullif(trim(p_data->>'middleName'),''),trim(p_data->>'lastName')),'email',mail,'reusedApplicant',applicant_existed,'status','SUBMITTED','qualificationCount',qualification_count);
END;
$$;

REVOKE ALL ON FUNCTION public.idmc_officer_application(jsonb,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_officer_application(jsonb,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.idmc_save_application_choices(p_application uuid,p_choices jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  applicant uuid;
  item jsonb;
  programme_id uuid;
  item_number integer := 0;
  seen uuid[] := ARRAY[]::uuid[];
  output jsonb := '[]'::jsonb;
BEGIN
  SELECT applicant_id INTO applicant FROM public.applications WHERE id=p_application AND status IN ('DRAFT','CORRECTION_REQUIRED') FOR UPDATE;
  IF applicant IS NULL THEN RAISE EXCEPTION 'Editable application not found'; END IF;
  IF jsonb_typeof(p_choices)<>'array' OR jsonb_array_length(p_choices)<1 OR jsonb_array_length(p_choices)>2 THEN RAISE EXCEPTION 'Provide one or two programme choices'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_choices) LOOP
    item_number := item_number + 1;
    programme_id := nullif(item->>'programmeId','')::uuid;
    IF programme_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.programmes WHERE id=programme_id AND status='ACTIVE') THEN RAISE EXCEPTION 'Choose an active programme'; END IF;
    IF programme_id=ANY(seen) THEN RAISE EXCEPTION 'Programme choices must be different'; END IF;
    seen := array_append(seen,programme_id);
  END LOOP;
  DELETE FROM public.application_choices WHERE application_id=p_application;
  item_number := 0;
  FOR item IN SELECT value FROM jsonb_array_elements(p_choices) LOOP
    item_number := item_number + 1;
    programme_id := (item->>'programmeId')::uuid;
    INSERT INTO public.application_choices(application_id,programme_id,choice_number,preference_type)
    VALUES(p_application,programme_id,item_number,CASE WHEN item_number=1 THEN 'PREFERRED' ELSE 'ALTERNATIVE' END);
  END LOOP;
  SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.choice_number),'[]'::jsonb) INTO output FROM public.application_choices c WHERE c.application_id=p_application;
  RETURN output;
END;
$$;
REVOKE ALL ON FUNCTION public.idmc_save_application_choices(uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_save_application_choices(uuid,jsonb) TO service_role;

COMMIT;
