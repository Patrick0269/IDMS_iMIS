BEGIN;

ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS updated_by uuid;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.students'::regclass
      AND conname = 'fk_students_updated_by_users'
  ) THEN
    ALTER TABLE public.students
      ADD CONSTRAINT fk_students_updated_by_users
      FOREIGN KEY (updated_by)
      REFERENCES public.users(id)
      ON DELETE SET NULL;
  END IF;
END
$migration$;

COMMENT ON COLUMN public.students.updated_by IS
  'Last IDMS user who changed the student record; nullable for imported historical data.';

NOTIFY pgrst, 'reload schema';

COMMIT;
