BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_data_reset_table_map (
  category_code text NOT NULL,
  table_name text NOT NULL,
  PRIMARY KEY (category_code, table_name)
);

INSERT INTO public.admin_data_reset_table_map(category_code, table_name) VALUES
('admissions','admission_acceptances'),('admissions','admission_decisions'),('admissions','admission_offers'),('admissions','applicants'),('admissions','application_choices'),('admissions','application_documents'),('admissions','applications'),('admissions','historical_academic_import_batches'),('admissions','historical_academic_import_rows'),('admissions','historical_import_account_results'),('admissions','historical_import_batches'),('admissions','historical_import_rows'),('admissions','joining_instructions'),
('students','alumni_records'),('students','certificate_verifications'),('students','certificates'),('students','graduation_applications'),('students','graduation_approvals'),('students','graduation_awards'),('students','graduation_candidates'),('students','graduation_clearance_history'),('students','graduation_clearance_items'),('students','graduation_clearances'),('students','graduation_eligibility_checks'),('students','student_academic_deficiencies'),('students','student_academic_standings'),('students','student_cgpa_records'),('students','student_cohorts'),('students','student_course_attempts'),('students','student_course_evaluations'),('students','student_coursework_responses'),('students','student_deletion_requests'),('students','student_documents'),('students','student_gpa_records'),('students','student_identifiers'),('students','student_lifecycle_events'),('students','student_programme_history'),('students','student_registrations'),('students','student_semester_results'),('students','student_service_requests'),('students','student_status_history'),('students','student_transcript_courses'),('students','student_transcript_semesters'),('students','student_transcripts'),('students','students'),('students','class_students'),('students','course_add_drop_requests'),('students','course_registrations'),('students','clinical_assessments'),('students','clinical_placements'),('students','field_practical_reports'),('students','field_practicals'),('students','hostel_allocations'),('students','hostel_service_requests'),('students','library_fines'),('students','library_loans'),('students','library_members'),('students','library_reservations'),('students','placement_logbook_entries'),('students','student_payment_requests'),('students','student_profiles'),
('academics','academic_calendar_events'),('academics','academic_records'),('academics','assessment_mark_corrections'),('academics','assessment_marks'),('academics','assessment_submissions'),('academics','assessments'),('academics','attendance_corrections'),('academics','attendance_records'),('academics','attendance_sessions'),('academics','course_result_corrections'),('academics','course_results'),('academics','examination_attendance'),('academics','examination_candidate_sessions'),('academics','examination_candidates'),('academics','examination_invigilators'),('academics','examination_mark_corrections'),('academics','examination_marks'),('academics','examination_papers'),('academics','examination_periods'),('academics','examination_sessions'),('academics','result_import_batches'),('academics','result_import_rows'),('academics','timetable_entries'),('academics','timetable_slots'),('academics','timetables'),('academics','idmc_result_windows'),('academics','idmc_admission_registration_queue'),
('finance','fee_items'),('finance','fee_structures'),('finance','finance_expense_participants'),('finance','finance_expense_requests'),('finance','finance_workflow_history'),('finance','financial_transactions'),('finance','invoice_items'),('finance','invoices'),('finance','payment_allocations'),('finance','payment_provider_events'),('finance','payments'),('finance','refunds'),('finance','scholarship_applications'),('finance','student_charges'),('finance','student_fee_adjustments'),('finance','student_fee_structure_assignments'),('finance','student_financial_accounts'),('finance','student_payment_requests'),('finance','student_scholarships'),('finance','staff_payroll_entries'),('finance','payroll_components'),('finance','payroll_entry_lines'),('finance','payroll_periods'),
('staff','staff'),('staff','staff_attendance'),('staff','staff_attendance_adjustments'),('staff','staff_documents'),('staff','staff_employment_history'),('staff','staff_leave_approvals'),('staff','staff_leave_balances'),('staff','staff_leave_requests'),('staff','staff_lifecycle_events'),('staff','staff_qualifications'),('staff','lecturer_assignments'),
('operations','asset_assignments'),('operations','asset_maintenance'),('operations','assets'),('operations','clinical_placements'),('operations','field_practicals'),('operations','hostel_allocations'),('operations','hostel_service_requests'),('operations','inventory_transactions'),('operations','library_fines'),('operations','library_loans'),('operations','library_reservations'),('operations','procurement_request_items'),('operations','procurement_requests'),('operations','purchase_order_items'),('operations','purchase_orders'),('operations','research_ethics_reviews'),('operations','research_funding'),('operations','research_outputs'),('operations','research_projects'),('operations','research_team_members'),('operations','asset_categories'),('operations','inventory_categories'),('operations','inventory_items'),('operations','suppliers'),('operations','library_items'),('operations','hostel_beds'),('operations','hostel_rooms'),
('communications','announcement_audiences'),('communications','announcements'),('communications','helpdesk_messages'),('communications','helpdesk_tickets'),('communications','notification_deliveries'),('communications','notification_queue'),('communications','notifications'),('communications','document_versions'),('communications','documents'),('communications','report_runs'),('communications','report_schedules'),
('audit','audit_logs'),('audit','security_logs'),('audit','idmc_workflow_events'),('audit','user_status_history'),('audit','system_maintenance_windows')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.admin_data_reset_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  project_reference text NOT NULL,
  categories text[] NOT NULL,
  deleted_rows jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_deleted bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_data_reset_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_data_reset_table_map, public.admin_data_reset_runs FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_data_reset_preview(p_categories text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r record; n bigint; result jsonb := '{}'::jsonb;
BEGIN
  IF p_categories IS NULL OR cardinality(p_categories)=0 OR EXISTS (
    SELECT 1 FROM unnest(p_categories) c WHERE c NOT IN ('admissions','students','academics','finance','staff','operations','communications','audit')
  ) THEN RAISE EXCEPTION 'Select one or more supported data groups.'; END IF;
  FOR r IN SELECT DISTINCT table_name FROM public.admin_data_reset_table_map WHERE category_code=ANY(p_categories) ORDER BY table_name LOOP
    IF to_regclass(format('public.%I',r.table_name)) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I',r.table_name) INTO n;
      result := result || jsonb_build_object(r.table_name,n);
    END IF;
  END LOOP;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.admin_data_reset_execute(p_categories text[], p_project_reference text, p_actor_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r record; candidate record; deleted_count bigint; total_count bigint:=0; counts jsonb:='{}'::jsonb;
  remaining text[]; protected_student_id uuid; protected_user_id uuid; kept_admins uuid[]; run_id uuid;
BEGIN
  IF p_categories IS NULL OR cardinality(p_categories)=0 OR EXISTS (
    SELECT 1 FROM unnest(p_categories) c WHERE c NOT IN ('admissions','students','academics','finance','staff','operations','communications','audit')
  ) THEN RAISE EXCEPTION 'Select one or more supported data groups.'; END IF;
  IF length(trim(coalesce(p_project_reference,'')))<8 THEN RAISE EXCEPTION 'A valid project reference is required.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_actor_user_id) THEN RAISE EXCEPTION 'Admin actor could not be verified.'; END IF;
  SELECT s.id,s.user_id INTO protected_student_id,protected_user_id FROM public.students s
   WHERE s.student_number='IDMC/2026/00001' OR s.registration_number='IDMC/2026/00001' LIMIT 1;
  SELECT array_agg(DISTINCT ur.user_id) INTO kept_admins FROM public.user_roles ur JOIN public.roles ro ON ro.id=ur.role_id
    WHERE ro.role_code IN ('ADMIN','SUPER_ADMIN') AND ur.status='ACTIVE';
  IF kept_admins IS NULL THEN kept_admins:=ARRAY[]::uuid[]; END IF;
  SELECT array_agg(DISTINCT table_name) INTO remaining FROM public.admin_data_reset_table_map WHERE category_code=ANY(p_categories)
    AND to_regclass(format('public.%I',table_name)) IS NOT NULL;
  IF remaining IS NULL OR cardinality(remaining)=0 THEN RAISE EXCEPTION 'Selected groups have no available data tables.'; END IF;
  CREATE TEMP TABLE IF NOT EXISTS _idmc_reset_counts(table_name text PRIMARY KEY, deleted_rows bigint) ON COMMIT DROP;
  TRUNCATE _idmc_reset_counts;
  WHILE cardinality(remaining)>0 LOOP
    SELECT t.table_name INTO candidate FROM unnest(remaining) AS t(table_name)
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_constraint fk JOIN pg_class child ON child.oid=fk.conrelid JOIN pg_class parent ON parent.oid=fk.confrelid
       WHERE fk.contype='f' AND child.relnamespace='public'::regnamespace AND parent.relnamespace='public'::regnamespace
         AND parent.relname=t.table_name AND child.relname=ANY(remaining) AND child.relname<>parent.relname
     ) ORDER BY t.table_name LIMIT 1;
    IF candidate.table_name IS NULL THEN RAISE EXCEPTION 'Selected groups contain a circular foreign-key dependency; no data was deleted.'; END IF;
    IF candidate.table_name='students' THEN
      IF protected_student_id IS NOT NULL THEN EXECUTE 'DELETE FROM public.students WHERE id<>$1' USING protected_student_id;
      ELSE DELETE FROM public.students; END IF;
    ELSE
      EXECUTE format('DELETE FROM public.%I',candidate.table_name);
    END IF;
    GET DIAGNOSTICS deleted_count=ROW_COUNT;
    INSERT INTO _idmc_reset_counts VALUES(candidate.table_name,deleted_count) ON CONFLICT(table_name) DO UPDATE SET deleted_rows=excluded.deleted_rows;
    total_count:=total_count+deleted_count;
    remaining:=array_remove(remaining,candidate.table_name);
  END LOOP;
  SELECT coalesce(jsonb_object_agg(table_name,deleted_rows),'{}'::jsonb) INTO counts FROM _idmc_reset_counts;
  INSERT INTO public.admin_data_reset_runs(actor_user_id,project_reference,categories,deleted_rows,total_deleted)
  VALUES(p_actor_user_id,p_project_reference,p_categories,counts,total_count) RETURNING id INTO run_id;
  RETURN jsonb_build_object('runId',run_id,'deletedRows',counts,'totalDeleted',total_count,'preservedStudent','IDMC/2026/00001','preservedAdminUsers',cardinality(kept_admins));
END $$;

REVOKE ALL ON FUNCTION public.admin_data_reset_preview(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_data_reset_execute(text[],text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_data_reset_preview(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_data_reset_execute(text[],text,uuid) TO service_role;

INSERT INTO public.permissions(permission_code,permission_name,module_code,action_code,description,status)
VALUES('system.data.purge','Delete selected operational data','SYSTEM','DATA_PURGE','Admin-only selective data cleanup after project-reference confirmation.','ACTIVE')
ON CONFLICT(permission_code) DO UPDATE SET permission_name=excluded.permission_name,description=excluded.description,status='ACTIVE';
INSERT INTO public.role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM public.roles r CROSS JOIN public.permissions p WHERE r.role_code IN ('ADMIN','SUPER_ADMIN') AND p.permission_code='system.data.purge'
ON CONFLICT DO NOTHING;
COMMIT;
