BEGIN;

INSERT INTO public.roles (role_code, role_name, description, is_system_role, status)
VALUES
  ('PRINCIPAL', 'Principal', 'Institutional executive oversight and approval authority.', true, 'ACTIVE'),
  ('DEPUTY_PRINCIPAL', 'Deputy Principal', 'Deputy institutional oversight and delegated approval authority.', true, 'ACTIVE'),
  ('DIRECTOR', 'Director', 'Institutional executive oversight and approval authority.', true, 'ACTIVE')
ON CONFLICT (role_code) DO UPDATE
SET role_name = EXCLUDED.role_name,
    description = EXCLUDED.description,
    status = 'ACTIVE',
    updated_at = now();

INSERT INTO public.permissions (permission_code, permission_name, module_code, action_code, description, status)
VALUES
  ('leadership.portal.view', 'View Leadership Portal', 'MANAGEMENT', 'PORTAL_VIEW', 'Open the executive leadership workspace.', 'ACTIVE')
ON CONFLICT (permission_code) DO UPDATE
SET permission_name = EXCLUDED.permission_name,
    description = EXCLUDED.description,
    status = 'ACTIVE',
    updated_at = now();

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.role_code IN ('PRINCIPAL', 'DEPUTY_PRINCIPAL', 'DIRECTOR')
  AND p.permission_code IN ('leadership.portal.view', 'finance.portal.view', 'finance.expenses.approve', 'reports.view', 'admissions.view', 'students.view', 'staff.view', 'hr.view')
ON CONFLICT DO NOTHING;

COMMIT;
