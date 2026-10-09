ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS cross_cutting boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.courses.cross_cutting IS
  'When true, an open course offering may be selected by students in other programmes for the same academic year and semester.';
