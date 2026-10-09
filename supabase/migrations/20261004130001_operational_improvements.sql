BEGIN;
-- Preserve an exact snapshot for review/rollback of this role transfer.
DO $backup$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.roles WHERE role_code='ADMISSIONS_OFFICER') OR NOT EXISTS(SELECT 1 FROM public.roles WHERE role_code='REGISTRAR') THEN RAISE EXCEPTION 'Required roles ADMISSIONS_OFFICER and REGISTRAR must exist before transfer'; END IF;
 IF to_regclass('public.idmc_20261003_role_backup') IS NULL THEN
 CREATE TABLE public.idmc_20261003_role_backup AS SELECT rp.* FROM public.role_permissions rp JOIN public.roles r ON r.id=rp.role_id WHERE r.role_code IN ('REGISTRAR','ADMISSIONS_OFFICER','HR_OFFICER','LECTURER');
 END IF;
END $backup$;
ALTER TABLE public.idmc_20261003_role_backup ENABLE ROW LEVEL SECURITY;
INSERT INTO public.role_permissions(role_id,permission_id)
SELECT a.id,rp.permission_id FROM public.roles a CROSS JOIN public.role_permissions rp JOIN public.roles r ON r.id=rp.role_id WHERE a.role_code='ADMISSIONS_OFFICER' AND r.role_code='REGISTRAR' ON CONFLICT DO NOTHING;
DELETE FROM public.role_permissions WHERE role_id IN (SELECT id FROM public.roles WHERE role_code='REGISTRAR');
INSERT INTO public.role_permissions(role_id,permission_id) SELECT r.id,p.id FROM public.roles r CROSS JOIN public.permissions p WHERE r.role_code='ADMISSIONS_OFFICER' AND (p.permission_code LIKE 'applications.%' OR p.permission_code LIKE 'admissions.%' OR p.permission_code LIKE 'registration.%') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions(role_id,permission_id) SELECT r.id,p.id FROM public.roles r CROSS JOIN public.permissions p WHERE r.role_code='HR_OFFICER' AND (p.permission_code LIKE 'staff.%' OR p.permission_code LIKE 'leave.%') AND p.permission_code <> 'staff.accounts.manage' ON CONFLICT DO NOTHING;
DELETE FROM public.role_permissions rp USING public.roles r,public.permissions p WHERE rp.role_id=r.id AND rp.permission_id=p.id AND p.permission_code='staff.accounts.manage' AND r.role_code NOT IN ('ADMIN','SUPER_ADMIN');
DELETE FROM public.role_permissions rp USING public.roles r,public.permissions p WHERE rp.role_id=r.id AND rp.permission_id=p.id AND r.role_code='LECTURER' AND (p.permission_code IN ('timetable.manage','academic.manage','academics.manage','academic.core.manage','curriculum.manage','courses.manage','programmes.manage'));
INSERT INTO public.permissions(permission_code,permission_name,module_code,action_code,status) VALUES
('results.window.manage','Open and close marks entry','RESULTS','WINDOW_MANAGE','ACTIVE'),
('students.withdrawal.approve','Approve student withdrawal','STUDENTS','WITHDRAW_APPROVE','ACTIVE'),
('students.withdrawal.view','View complete withdrawn student records','STUDENTS','WITHDRAW_VIEW','ACTIVE') ON CONFLICT(permission_code) DO NOTHING;
INSERT INTO public.role_permissions(role_id,permission_id) SELECT r.id,p.id FROM public.roles r CROSS JOIN public.permissions p WHERE
(p.permission_code='results.window.manage' AND r.role_code IN ('ADMIN','SUPER_ADMIN','HOD')) OR
(p.permission_code='students.withdrawal.approve' AND r.role_code IN ('ADMIN','SUPER_ADMIN')) OR
(p.permission_code='students.withdrawal.view' AND r.role_code IN ('ADMIN','SUPER_ADMIN','DIRECTOR','PRINCIPAL')) ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions(role_id,permission_id) SELECT r.id,p.id FROM public.roles r CROSS JOIN public.permissions p WHERE r.role_code='LECTURER' AND p.permission_code IN ('assessment.view','assessment.manage') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.idmc_result_windows(course_offering_id uuid PRIMARY KEY REFERENCES public.course_offerings(id),is_open boolean NOT NULL DEFAULT false,changed_by uuid REFERENCES public.users(id),changed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.idmc_workflow_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),entity_id uuid,action text NOT NULL,actor_id uuid REFERENCES public.users(id),details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.idmc_staff_files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),staff_id uuid NOT NULL REFERENCES public.staff(id),file_name text NOT NULL,mime_type text NOT NULL,document_type text NOT NULL,content_base64 text NOT NULL CHECK(length(content_base64)<=7000000),uploaded_by uuid REFERENCES public.users(id),uploaded_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.idmc_staff_files ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'PENDING', ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.users(id), ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
CREATE TABLE IF NOT EXISTS public.idmc_student_withdrawals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),student_id uuid NOT NULL REFERENCES public.students(id),reason text NOT NULL,status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),requested_by uuid REFERENCES public.users(id),decided_by uuid REFERENCES public.users(id),requested_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,record_snapshot jsonb);
CREATE UNIQUE INDEX IF NOT EXISTS idmc_one_pending_withdrawal ON public.idmc_student_withdrawals(student_id) WHERE status='PENDING';
ALTER TABLE public.idmc_result_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idmc_workflow_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idmc_staff_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idmc_student_withdrawals ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.idmc_result_windows,public.idmc_workflow_events,public.idmc_staff_files,public.idmc_student_withdrawals TO service_role;
REVOKE ALL ON public.idmc_result_windows,public.idmc_workflow_events,public.idmc_staff_files,public.idmc_student_withdrawals,public.idmc_20261003_role_backup FROM anon,authenticated;
CREATE INDEX IF NOT EXISTS idmc_staff_files_staff ON public.idmc_staff_files(staff_id);
CREATE INDEX IF NOT EXISTS idmc_reg_offering_status ON public.course_registrations(course_offering_id,registration_status,student_id);
CREATE INDEX IF NOT EXISTS idmc_timetable_offering_status ON public.timetable_entries(course_offering_id,status);

ALTER TABLE public.fee_items ADD COLUMN IF NOT EXISTS first_installment_amount numeric(18,2) CHECK(first_installment_amount>=0);
ALTER TABLE public.student_charges ADD COLUMN IF NOT EXISTS first_installment_amount numeric(18,2) CHECK(first_installment_amount>=0);
-- All financial writes run in one transaction; concurrent retries reuse the invoice.
CREATE OR REPLACE FUNCTION public.idmc_invoice_from_structure(p_student uuid,p_structure uuid,p_semester text,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE s public.fee_structures; a public.student_fee_structure_assignments; i public.invoices; f record; ch uuid; total numeric; inv uuid; instructions jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_student::text||p_structure::text||p_semester,0));
 SELECT * INTO s FROM public.fee_structures WHERE id=p_structure AND status='ACTIVE';
 IF s.id IS NULL THEN RAISE EXCEPTION 'Select an active fee structure'; END IF;
 IF NULLIF(trim(p_semester),'') IS NULL OR (s.semester IS NOT NULL AND s.semester<>p_semester) THEN RAISE EXCEPTION 'Semester must match the selected fee structure'; END IF;
 PERFORM 1 FROM public.students WHERE id=p_student; IF NOT FOUND THEN RAISE EXCEPTION 'Student not found'; END IF;
 SELECT * INTO a FROM public.student_fee_structure_assignments WHERE student_id=p_student AND fee_structure_id=p_structure AND semester=p_semester FOR UPDATE;
 IF a.assignment_status='INVOICED' THEN SELECT * INTO i FROM public.invoices WHERE id=a.invoice_id; RETURN jsonb_build_object('assignment',to_jsonb(a),'invoice',to_jsonb(i),'reused',true); END IF;
 IF EXISTS(SELECT 1 FROM public.student_charges WHERE student_id=p_student AND fee_structure_id=p_structure AND semester=p_semester AND status<>'CANCELLED') THEN RAISE EXCEPTION 'Existing charges found: reconcile the previous incomplete invoice before retrying'; END IF;
 SELECT sum(coalesce(semester_amount,amount)) INTO total FROM public.fee_items WHERE fee_structure_id=p_structure AND amount_confirmed AND coalesce(semester_amount,amount)>0;
 IF coalesce(total,0)<=0 THEN RAISE EXCEPTION 'Fee structure has no confirmed positive amounts'; END IF;
 SELECT setting_value INTO instructions FROM public.system_settings WHERE setting_key='FINANCE_PAYMENT_INSTRUCTIONS' AND institution_id=(SELECT id FROM public.institutions ORDER BY created_at,id LIMIT 1) LIMIT 1;
 INSERT INTO public.invoices(student_id,invoice_number,invoice_date,due_date,academic_year,semester,subtotal,total_amount,amount_paid,balance_amount,status,currency_code,first_installment_amount,control_number,control_institution_name,issued_by,issued_at,created_by,notes)
 VALUES(p_student,'INV-'||gen_random_uuid()::text,current_date,current_date+30,s.academic_year,p_semester,total,total,0,total,'ISSUED',coalesce(s.currency_code,'TZS'),s.first_installment_amount,NULLIF(instructions->>'controlNumber',''),NULLIF(instructions->>'accountName',''),p_actor,now(),p_actor,'Generated from '||s.fee_structure_name) RETURNING id INTO inv;
 FOR f IN SELECT * FROM public.fee_items WHERE fee_structure_id=p_structure AND amount_confirmed AND coalesce(semester_amount,amount)>0 ORDER BY display_order LOOP
 INSERT INTO public.student_charges(student_id,fee_structure_id,fee_item_id,charge_number,description,academic_year,semester,original_amount,first_installment_amount,status,charge_date,due_date,created_by,updated_by)
 VALUES(p_student,p_structure,f.id,'CHG-'||gen_random_uuid()::text,f.fee_item_name,s.academic_year,p_semester,coalesce(f.semester_amount,f.amount),f.first_installment_amount,'POSTED',current_date,current_date+30,p_actor,p_actor) RETURNING id INTO ch;
 INSERT INTO public.invoice_items(invoice_id,student_charge_id,description,quantity,unit_amount,discount_amount) VALUES(inv,ch,f.fee_item_name,1,coalesce(f.semester_amount,f.amount),0);
 END LOOP;
 PERFORM public.refresh_invoice_financials(inv); PERFORM public.refresh_student_financial_account(p_student);
 INSERT INTO public.student_fee_structure_assignments(student_id,fee_structure_id,semester,invoice_id,assignment_status,assigned_by)
 VALUES(p_student,p_structure,p_semester,inv,'INVOICED',p_actor) ON CONFLICT(student_id,fee_structure_id,semester) DO UPDATE SET invoice_id=excluded.invoice_id,assignment_status='INVOICED',error_message=NULL,updated_at=now() RETURNING * INTO a;
 SELECT * INTO i FROM public.invoices WHERE id=inv;
 INSERT INTO public.idmc_workflow_events(entity_id,action,actor_id,details) VALUES(inv,'INVOICE_GENERATED',p_actor,jsonb_build_object('student',p_student,'structure',p_structure));
 RETURN jsonb_build_object('assignment',to_jsonb(a),'invoice',to_jsonb(i),'reused',false);
END $$;

CREATE OR REPLACE FUNCTION public.idmc_register_admitted(p_student uuid,p_year uuid,p_semester uuid,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE st public.students; reg public.student_registrations; sem public.semesters; app public.applications; ver uuid; cur uuid; total numeric; n integer; c record; offid uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_student::text||p_semester::text,0));
 SELECT * INTO st FROM public.students WHERE id=p_student FOR UPDATE;
 IF st.id IS NULL OR st.student_status NOT IN ('ACTIVE','PENDING_ACTIVATION') THEN RAISE EXCEPTION 'Student must have completed admission and be active or pending activation'; END IF;
 SELECT * INTO app FROM public.applications WHERE id=st.source_application_id AND status='CONVERTED_TO_STUDENT';
 IF app.id IS NULL THEN RAISE EXCEPTION 'Complete the admission conversion first'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.admission_offers o JOIN public.admission_acceptances a ON a.admission_offer_id=o.id WHERE o.application_id=app.id AND a.acceptance_status='ACCEPTED') THEN RAISE EXCEPTION 'An accepted admission offer is required'; END IF;
 SELECT * INTO sem FROM public.semesters WHERE id=p_semester AND academic_year_id=p_year;
 IF sem.id IS NULL THEN RAISE EXCEPTION 'Semester does not belong to this year'; END IF;
 SELECT * INTO reg FROM public.student_registrations WHERE student_id=p_student AND academic_year_id=p_year AND semester_id=p_semester FOR UPDATE;
 IF reg.registration_status IN ('REGISTERED','LOCKED') THEN RETURN to_jsonb(reg); END IF;
 IF reg.registration_status IN ('CANCELLED','REJECTED') THEN RAISE EXCEPTION 'Cancelled or rejected registration requires review'; END IF;
 ver:=st.programme_version_id;
 IF ver IS NULL THEN SELECT id INTO ver FROM public.programme_versions WHERE programme_id=st.programme_id AND status='ACTIVE' ORDER BY effective_from DESC LIMIT 1; END IF;
 SELECT id INTO cur FROM public.curricula WHERE programme_version_id=ver AND status='ACTIVE' ORDER BY effective_from DESC LIMIT 1;
 IF cur IS NULL THEN RAISE EXCEPTION 'No active curriculum for the student programme'; END IF;
 -- New admissions use year 1. Continuing students retain their existing registration workflow.
 SELECT sum(coalesce(cc.credit_units,cm.credit_units)),count(*) INTO total,n FROM public.curriculum_courses cc JOIN public.courses cm ON cm.id=cc.course_id WHERE cc.curriculum_id=cur AND cc.semester_number=sem.semester_number AND coalesce(cc.year_number,1)=1 AND cc.is_compulsory AND cm.status='ACTIVE';
 IF n=0 OR total<=0 THEN RAISE EXCEPTION 'No compulsory first-year curriculum courses for this semester'; END IF;
 IF reg.id IS NULL THEN
 INSERT INTO public.student_registrations(student_id,academic_year_id,semester_id,programme_id,programme_version_id,registration_number,maximum_credits,created_by,updated_by)
 VALUES(p_student,p_year,p_semester,st.programme_id,ver,'REG-'||gen_random_uuid()::text,greatest(total,60),p_actor,p_actor) RETURNING * INTO reg;
 END IF;
 FOR c IN SELECT cc.*,coalesce(cc.credit_units,cm.credit_units) credits FROM public.curriculum_courses cc JOIN public.courses cm ON cm.id=cc.course_id WHERE cc.curriculum_id=cur AND cc.semester_number=sem.semester_number AND coalesce(cc.year_number,1)=1 AND cc.is_compulsory AND cm.status='ACTIVE' LOOP
 SELECT count(*),min(id::text)::uuid INTO n,offid FROM public.course_offerings WHERE course_id=c.course_id AND programme_id=st.programme_id AND academic_year_id=p_year AND semester_id=p_semester AND status IN ('OPEN','CLOSED') AND (programme_version_id IS NULL OR programme_version_id=ver);
 IF n<>1 THEN RAISE EXCEPTION 'Course % needs exactly one open/closed offering; found %',c.course_id,n; END IF;
 IF EXISTS(SELECT 1 FROM public.course_prerequisites WHERE course_id=c.course_id) THEN RAISE EXCEPTION 'Course % has prerequisites; academic review is required',c.course_id; END IF;
 INSERT INTO public.course_registrations(student_registration_id,student_id,course_id,course_offering_id,credits,registration_status,is_core,is_elective,prerequisite_status,eligibility_status,approved_at,approved_by,created_by)
 SELECT reg.id,p_student,c.course_id,offid,c.credits,'REGISTERED',true,false,'NOT_REQUIRED','ELIGIBLE',now(),p_actor,p_actor WHERE NOT EXISTS(SELECT 1 FROM public.course_registrations WHERE student_registration_id=reg.id AND course_id=c.course_id);
 UPDATE public.course_registrations SET course_offering_id=offid,registration_status='REGISTERED',approved_at=now(),approved_by=p_actor WHERE student_registration_id=reg.id AND course_id=c.course_id AND registration_status IN ('SELECTED','PENDING_APPROVAL','APPROVED');
 END LOOP;
 UPDATE public.student_registrations SET registration_status='REGISTERED',submitted_at=coalesce(submitted_at,now()),approved_at=now(),approved_by=p_actor,updated_by=p_actor,updated_at=now() WHERE id=reg.id RETURNING * INTO reg;
 INSERT INTO public.idmc_workflow_events(entity_id,action,actor_id) VALUES(reg.id,'ADMISSION_REGISTERED',p_actor);
 RETURN to_jsonb(reg);
END $$;
CREATE TABLE IF NOT EXISTS public.idmc_admission_registration_queue(student_id uuid PRIMARY KEY REFERENCES public.students(id),academic_year_id uuid NOT NULL REFERENCES public.academic_years(id),status text NOT NULL DEFAULT 'PENDING',last_error text,updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.idmc_admission_registration_queue ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.idmc_admission_registration_queue TO service_role;
REVOKE ALL ON public.idmc_admission_registration_queue FROM anon,authenticated;
CREATE OR REPLACE FUNCTION public.idmc_after_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE sid uuid; sem uuid;
BEGIN
 IF NEW.status='CONVERTED_TO_STUDENT' AND OLD.status IS DISTINCT FROM NEW.status THEN
 SELECT id INTO sid FROM public.students WHERE source_application_id=NEW.id;
 IF sid IS NOT NULL THEN
 INSERT INTO public.idmc_admission_registration_queue(student_id,academic_year_id) VALUES(sid,NEW.academic_year_id) ON CONFLICT DO NOTHING;
 BEGIN
 SELECT id INTO sem FROM public.semesters WHERE academic_year_id=NEW.academic_year_id AND semester_number=1;
 IF sem IS NULL THEN RAISE EXCEPTION 'Create semester 1 for the admission year'; END IF;
 PERFORM public.idmc_register_admitted(sid,NEW.academic_year_id,sem,NEW.reviewed_by);
 UPDATE public.idmc_admission_registration_queue SET status='REGISTERED',last_error=NULL,updated_at=now() WHERE student_id=sid;
 EXCEPTION WHEN OTHERS THEN UPDATE public.idmc_admission_registration_queue SET status='PENDING',last_error=SQLERRM,updated_at=now() WHERE student_id=sid;
 END;
 END IF; END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS idmc_auto_admission_registration ON public.applications;
CREATE TRIGGER idmc_auto_admission_registration AFTER UPDATE OF status ON public.applications FOR EACH ROW EXECUTE FUNCTION public.idmc_after_admission();

CREATE OR REPLACE FUNCTION public.idmc_set_result_window(p_offering uuid,p_open boolean,p_actor uuid) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 INSERT INTO public.idmc_result_windows(course_offering_id,is_open,changed_by) VALUES(p_offering,p_open,p_actor) ON CONFLICT(course_offering_id) DO UPDATE SET is_open=excluded.is_open,changed_by=excluded.changed_by,changed_at=now();
 INSERT INTO public.idmc_workflow_events(entity_id,action,actor_id) VALUES(p_offering,CASE WHEN p_open THEN 'MARKS_WINDOW_OPENED' ELSE 'MARKS_WINDOW_CLOSED' END,p_actor);
END $$;
-- Never expose these privileged RPCs directly to browser roles.
REVOKE ALL ON FUNCTION public.idmc_invoice_from_structure(uuid,uuid,text,uuid),public.idmc_register_admitted(uuid,uuid,uuid,uuid),public.idmc_set_result_window(uuid,boolean,uuid),public.idmc_after_admission() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_invoice_from_structure(uuid,uuid,text,uuid),public.idmc_register_admitted(uuid,uuid,uuid,uuid),public.idmc_set_result_window(uuid,boolean,uuid) TO service_role;
COMMIT;
