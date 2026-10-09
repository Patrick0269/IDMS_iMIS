BEGIN;

INSERT INTO public.permissions
  (permission_code, permission_name, module_code, action_code, description, status)
VALUES
  ('lecturer.assignments.manage', 'Manage department lecturer course assignments', 'ACADEMICS', 'ASSIGN_LECTURER', 'View and assign active lecturers to course offerings within the assigned department.', 'ACTIVE')
ON CONFLICT (permission_code) DO UPDATE
SET permission_name = EXCLUDED.permission_name,
    module_code = EXCLUDED.module_code,
    action_code = EXCLUDED.action_code,
    description = EXCLUDED.description,
    status = 'ACTIVE',
    updated_at = now();

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.role_code IN ('HOD', 'DEPUTY_HOD', 'ADMIN', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  AND r.status = 'ACTIVE'
  AND p.permission_code = 'lecturer.assignments.manage'
  AND p.status = 'ACTIVE'
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
