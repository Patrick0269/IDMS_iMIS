-- IDMC Section 22 professional workflow enhancements
-- Additive only: no login/auth source changes, no destructive DDL.

INSERT INTO public.permissions(permission_code,permission_name,module_code,action_code,description,status) VALUES
 ('admissions.registration.manage','Manage admitted-student registration','ADMISSIONS','REGISTRATION_MANAGE','Create and manage registrations for admitted students','ACTIVE'),
 ('admissions.registration.export','Export admitted and registered students','ADMISSIONS','REGISTRATION_EXPORT','Download admitted/registered student data','ACTIVE'),
 ('hr.staff.export','Export and print staff profiles','HUMAN_RESOURCES','STAFF_EXPORT','Export or print complete staff profiles','ACTIVE'),
 ('results.window.manage','Open and close result entry window','RESULTS','WINDOW_MANAGE','Open/close lecturer result entry windows','ACTIVE'),
 ('timetable.import','Import timetable from spreadsheet','TIMETABLE','IMPORT','Import timetable entries from approved spreadsheet templates','ACTIVE')
ON CONFLICT (permission_code) DO UPDATE SET permission_name=EXCLUDED.permission_name, description=EXCLUDED.description, status='ACTIVE';

-- Admissions Officer becomes the operational registration owner. Registrar is intentionally not granted these new operational permissions.
INSERT INTO public.role_permissions(role_id,permission_id,granted)
SELECT r.id,p.id,true FROM public.roles r CROSS JOIN public.permissions p
WHERE r.role_code='ADMISSIONS_OFFICER' AND p.permission_code IN (
 'registration.view','registration.manage','registration.submit','registration.approve','registration.register','registration.lock',
 'admissions.registration.manage','admissions.registration.export')
ON CONFLICT (role_id,permission_id) DO UPDATE SET granted=true;

-- HR is the supervisory owner for staff information; staff creation remains ADMIN/SUPER_ADMIN via UI + existing RBAC.
INSERT INTO public.role_permissions(role_id,permission_id,granted)
SELECT r.id,p.id,true FROM public.roles r CROSS JOIN public.permissions p
WHERE r.role_code IN ('HUMAN_RESOURCES','HR','HR_OFFICER','HR_MANAGER') AND p.permission_code IN (
 'staff.view','staff.manage','staff.lifecycle.view','staff.lifecycle.manage','staff.attendance.view','staff.attendance.manage','hr.staff.export')
ON CONFLICT (role_id,permission_id) DO UPDATE SET granted=true;

-- Performance indexes for the high-frequency workspaces.
CREATE INDEX IF NOT EXISTS idx_students_status_programme ON public.students(student_status,programme_id);
CREATE INDEX IF NOT EXISTS idx_student_registrations_status_period ON public.student_registrations(registration_status,academic_year_id,semester_id);
CREATE INDEX IF NOT EXISTS idx_course_offerings_period_course ON public.course_offerings(academic_year_id,semester_id,course_id);
CREATE INDEX IF NOT EXISTS idx_course_registrations_offering_status ON public.course_registrations(course_offering_id,registration_status);
CREATE INDEX IF NOT EXISTS idx_invoices_student_date ON public.invoices(student_id,invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_student_date ON public.payments(student_id,payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_staff_status_department ON public.staff(employment_status,department_id);
