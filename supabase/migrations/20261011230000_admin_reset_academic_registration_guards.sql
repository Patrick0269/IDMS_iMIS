BEGIN;

-- Keep locked attendance and registration protections for normal workflows;
-- allow deletion only inside the audited, service-role reset transaction.
CREATE OR REPLACE FUNCTION public.prevent_locked_attendance_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status varchar;
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('idmc.admin_data_reset', true) = 'on' THEN
    RETURN OLD;
  END IF;

  SELECT status
    INTO v_status
    FROM public.attendance_sessions
   WHERE id = COALESCE(NEW.attendance_session_id, OLD.attendance_session_id);

  IF v_status = 'LOCKED' THEN
    RAISE EXCEPTION 'Attendance session % is LOCKED and cannot be modified',
      COALESCE(NEW.attendance_session_id, OLD.attendance_session_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_locked_course_registration_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status varchar(40);
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('idmc.admin_data_reset', true) = 'on' THEN
    RETURN OLD;
  END IF;

  SELECT registration_status
    INTO v_status
    FROM public.student_registrations
   WHERE id = COALESCE(NEW.student_registration_id, OLD.student_registration_id);

  IF v_status = 'LOCKED' THEN
    RAISE EXCEPTION 'Cannot modify course registration for a locked student registration';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_add_drop_after_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status varchar(40);
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('idmc.admin_data_reset', true) = 'on' THEN
    RETURN OLD;
  END IF;

  SELECT registration_status
    INTO v_status
    FROM public.student_registrations
   WHERE id = COALESCE(NEW.student_registration_id, OLD.student_registration_id);

  IF v_status IN ('LOCKED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Add/Drop requests are not allowed for locked or cancelled registration';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Credit totals are derived from course registrations. During a full reset,
-- skip per-row recalculation because the parent registration is reset too.
CREATE OR REPLACE FUNCTION public.refresh_registration_credits()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_registration_id uuid;
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('idmc.admin_data_reset', true) = 'on' THEN
    RETURN OLD;
  END IF;

  v_registration_id := COALESCE(NEW.student_registration_id, OLD.student_registration_id);

  UPDATE public.student_registrations sr
     SET total_registered_credits = COALESCE(
       (
         SELECT SUM(cr.credits)
           FROM public.course_registrations cr
          WHERE cr.student_registration_id = sr.id
            AND cr.registration_status NOT IN ('DROPPED', 'REJECTED', 'CANCELLED')
       ),
       0
     ),
         updated_at = now()
   WHERE sr.id = v_registration_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMIT;
