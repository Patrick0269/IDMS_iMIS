-- Supporting indexes for common operational queues and dashboard filters.
-- These are additive and safe to re-run; no records or workflow states change.

CREATE INDEX IF NOT EXISTS idx_student_service_requests_status_submitted
  ON public.student_service_requests (status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_student_deletion_requests_status_created
  ON public.student_deletion_requests (request_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_leave_requests_status_submitted
  ON public.staff_leave_requests (request_status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_procurement_requests_status_date
  ON public.procurement_requests (request_status, request_date DESC);
