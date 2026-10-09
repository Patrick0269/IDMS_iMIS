BEGIN;

CREATE TABLE IF NOT EXISTS public.student_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE RESTRICT,
  requested_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  request_reason text NOT NULL CHECK (length(trim(request_reason)) > 0),
  request_status varchar(20) NOT NULL DEFAULT 'PENDING'
    CHECK (request_status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_student_deletion_review_pair CHECK (
    (request_status = 'PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (request_status <> 'PENDING' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_student_deletion_pending
  ON public.student_deletion_requests(student_id) WHERE request_status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_student_deletion_requests_status
  ON public.student_deletion_requests(request_status, created_at);
ALTER TABLE public.student_deletion_requests ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.approve_student_deletion(p_request_id uuid, p_reviewer_id uuid)
RETURNS TABLE(student_id uuid, student_number varchar)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request public.student_deletion_requests%ROWTYPE;
  v_student public.students%ROWTYPE;
BEGIN
  SELECT * INTO v_request FROM public.student_deletion_requests
  WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_request.request_status <> 'PENDING' THEN
    RAISE EXCEPTION 'Pending deletion request was not found';
  END IF;
  IF v_request.requested_by = p_reviewer_id THEN
    RAISE EXCEPTION 'The requester cannot approve their own deletion request';
  END IF;
  SELECT * INTO v_student FROM public.students
  WHERE id = v_request.student_id AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Student is already archived or missing'; END IF;

  UPDATE public.students SET archived_at=now(), archived_by=p_reviewer_id,
    student_status='INACTIVE', updated_at=now(), updated_by=p_reviewer_id
  WHERE id=v_student.id;
  IF v_student.user_id IS NOT NULL THEN
    UPDATE public.users SET status='INACTIVE', updated_at=now() WHERE id=v_student.user_id;
    UPDATE public.user_roles SET status='INACTIVE'
      WHERE user_id=v_student.user_id AND status='ACTIVE';
  END IF;
  UPDATE public.student_deletion_requests SET request_status='APPROVED',
    reviewed_by=p_reviewer_id, reviewed_at=now(), updated_at=now()
  WHERE id=v_request.id;
  RETURN QUERY SELECT v_student.id, v_student.student_number;
END;
$$;
REVOKE ALL ON FUNCTION public.approve_student_deletion(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_student_deletion(uuid, uuid) TO service_role;

INSERT INTO public.permissions(permission_code, permission_name, module_code, action_code, description, status)
VALUES
 ('students.delete.request','Request student deletion','STUDENTS','DELETE_REQUEST','Request archival of a student; requires separate Admin approval.','ACTIVE'),
 ('students.delete.approve','Approve student deletion','STUDENTS','DELETE_APPROVE','Approve soft archival while retaining academic, finance and audit evidence.','ACTIVE')
ON CONFLICT (permission_code) DO UPDATE SET permission_name=EXCLUDED.permission_name,description=EXCLUDED.description,status='ACTIVE';

INSERT INTO public.role_permissions(role_id, permission_id)
SELECT r.id,p.id FROM public.roles r CROSS JOIN public.permissions p
WHERE r.role_code IN ('REGISTRAR','ACADEMIC_OFFICER','ADMISSIONS_OFFICER')
  AND p.permission_code='students.delete.request'
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions(role_id, permission_id)
SELECT r.id,p.id FROM public.roles r CROSS JOIN public.permissions p
WHERE r.role_code IN ('SUPER_ADMIN','ADMIN')
  AND p.permission_code='students.delete.approve'
ON CONFLICT DO NOTHING;

COMMIT;
