BEGIN;

-- HR staff records must link to an active, pre-existing IDMC user account.
CREATE OR REPLACE FUNCTION public.idmc_staff_bundle(p_data jsonb, p_actor uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    sid uuid;
    x jsonb;
    linked_user public.users%ROWTYPE;
    idms_institution_id uuid;
    selected_department_id uuid;
BEGIN
    IF NULLIF(btrim(p_data->>'userId'), '') IS NULL THEN
        RAISE EXCEPTION 'Find an existing user account by email before registering staff.';
    END IF;
    IF NULLIF(btrim(p_data->>'employeeNumber'), '') IS NULL THEN
        RAISE EXCEPTION 'Employee number is required.';
    END IF;

    SELECT * INTO linked_user
    FROM public.users
    WHERE id = (p_data->>'userId')::uuid;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'The selected account no longer exists in User Management.';
    END IF;
    IF upper(coalesce(linked_user.status, '')) <> 'ACTIVE' THEN
        RAISE EXCEPTION 'The selected user account is not active.';
    END IF;
    IF linked_user.auth_user_id IS NULL THEN
        RAISE EXCEPTION 'The selected user account has no login identity.';
    END IF;
    IF lower(coalesce(linked_user.email, '')) <> lower(coalesce(p_data->>'email', '')) THEN
        RAISE EXCEPTION 'The email changed after account lookup. Find the user again.';
    END IF;
    IF NULLIF(btrim(linked_user.first_name), '') IS NULL OR NULLIF(btrim(linked_user.last_name), '') IS NULL THEN
        RAISE EXCEPTION 'The user account needs first and last names before HR registration.';
    END IF;

    SELECT id INTO idms_institution_id
    FROM public.institutions
    WHERE upper(institution_code) = 'IDMS' AND upper(status) = 'ACTIVE'
    LIMIT 1;
    IF idms_institution_id IS NULL THEN
        RAISE EXCEPTION 'Active IDMS institution configuration is missing.';
    END IF;

    selected_department_id := NULLIF(p_data->>'departmentId', '')::uuid;
    IF selected_department_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.departments
        WHERE id = selected_department_id
          AND institution_id = idms_institution_id
          AND upper(status) = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'Choose an active department belonging to IDMS.';
    END IF;

    IF EXISTS (SELECT 1 FROM public.staff WHERE user_id = linked_user.id) THEN
        RAISE EXCEPTION 'This user already has a staff profile in HR.';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.staff
        WHERE lower(email) = lower(linked_user.email)
          AND user_id IS DISTINCT FROM linked_user.id
    ) THEN
        RAISE EXCEPTION 'A staff record already uses this email. Ask an administrator to reconcile the existing HR record.';
    END IF;

    INSERT INTO public.staff(
        institution_id, user_id, department_id, employee_number,
        first_name, middle_name, last_name, email, phone,
        job_title, staff_category, employment_type, appointment_date,
        highest_qualification, physical_address, emergency_contact_name,
        emergency_contact_phone, created_by
    ) VALUES (
        idms_institution_id, linked_user.id, selected_department_id,
        btrim(p_data->>'employeeNumber'), linked_user.first_name,
        linked_user.middle_name, linked_user.last_name, linked_user.email,
        coalesce(NULLIF(btrim(p_data->>'phone'), ''), linked_user.phone),
        NULLIF(btrim(p_data->>'jobTitle'), ''),
        coalesce(NULLIF(p_data->>'staffCategory', ''), 'ADMINISTRATIVE'),
        coalesce(NULLIF(p_data->>'employmentType', ''), 'FULL_TIME'),
        NULLIF(p_data->>'appointmentDate', '')::date,
        NULLIF(btrim(p_data->>'highestQualification'), ''),
        NULLIF(btrim(p_data->>'physicalAddress'), ''),
        NULLIF(btrim(p_data->>'emergencyContactName'), ''),
        NULLIF(btrim(p_data->>'emergencyContactPhone'), ''), p_actor
    ) RETURNING id INTO sid;

    FOR x IN SELECT * FROM jsonb_array_elements(coalesce(p_data->'qualifications', '[]'::jsonb)) LOOP
        INSERT INTO public.staff_qualifications(
            staff_id, qualification_level, qualification_name, institution_name,
            field_of_study, completion_year, certificate_number
        ) VALUES (
            sid, NULLIF(x->>'qualificationLevel', ''), NULLIF(x->>'qualificationName', ''),
            NULLIF(x->>'institutionName', ''), NULLIF(x->>'fieldOfStudy', ''),
            NULLIF(x->>'completionYear', '')::integer, NULLIF(x->>'certificateNumber', '')
        );
    END LOOP;

    FOR x IN SELECT * FROM jsonb_array_elements(coalesce(p_data->'history', '[]'::jsonb)) LOOP
        INSERT INTO public.staff_employment_history(staff_id, job_title, employment_type, start_date, end_date, notes)
        VALUES (
            sid, x->>'jobTitle', coalesce(NULLIF(x->>'employmentType', ''), 'FULL_TIME'),
            NULLIF(x->>'startDate', '')::date, NULLIF(x->>'endDate', '')::date, NULLIF(x->>'notes', '')
        );
    END LOOP;

    FOR x IN SELECT * FROM jsonb_array_elements(coalesce(p_data->'files', '[]'::jsonb)) LOOP
        INSERT INTO public.idmc_staff_files(staff_id, file_name, mime_type, document_type, content_base64, uploaded_by)
        VALUES (sid, x->>'fileName', x->>'mimeType', x->>'documentType', x->>'contentBase64', p_actor);
    END LOOP;

    INSERT INTO public.idmc_workflow_events(entity_id, action, actor_id, details)
    VALUES (sid, 'STAFF_REGISTERED_FROM_EXISTING_USER', p_actor, jsonb_build_object('user_id', linked_user.id, 'institution_id', idms_institution_id, 'department_id', selected_department_id));
    RETURN sid;
END;
$$;

REVOKE ALL ON FUNCTION public.idmc_staff_bundle(jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_staff_bundle(jsonb, uuid) TO service_role;
NOTIFY pgrst, 'reload schema';

COMMIT;