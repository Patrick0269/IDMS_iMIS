-- Additive dashboard aggregation. The API retains its existing query fallback
-- until this migration is applied to the target Supabase project.
CREATE OR REPLACE FUNCTION public.idmc_leadership_dashboard_snapshot(
  p_month_start timestamptz,
  p_delayed_before timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
SELECT jsonb_build_object(
  'students', jsonb_build_object(
    'total', (SELECT count(*) FROM public.students),
    'active', (SELECT count(*) FROM public.students WHERE student_status = 'ACTIVE'),
    'newPendingActivation', (SELECT count(*) FROM public.students WHERE student_status = 'PENDING_ACTIVATION'),
    'withdrawn', (SELECT count(*) FROM public.students WHERE student_status = 'WITHDRAWN'),
    'suspended', (SELECT count(*) FROM public.students WHERE student_status = 'SUSPENDED')
  ),
  'finance', jsonb_build_object(
    'monthRevenue', COALESCE((
      SELECT sum(credit_amount) FROM public.financial_transactions
      WHERE status = 'POSTED' AND transaction_type = 'PAYMENT' AND transaction_date >= p_month_start
    ), 0),
    'monthExpenditure', COALESCE((
      SELECT sum(amount) FROM public.finance_expense_requests
      WHERE status = 'PAID' AND paid_at >= p_month_start
    ), 0),
    'monthNet', COALESCE((
      SELECT sum(credit_amount) FROM public.financial_transactions
      WHERE status = 'POSTED' AND transaction_type = 'PAYMENT' AND transaction_date >= p_month_start
    ), 0) - COALESCE((
      SELECT sum(amount) FROM public.finance_expense_requests
      WHERE status = 'PAID' AND paid_at >= p_month_start
    ), 0),
    'outstandingFees', COALESCE((
      SELECT sum(balance_amount) FROM public.invoices
      WHERE status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')
    ), 0)
  ),
  'studentDistribution', jsonb_build_object(
    'byProgramme', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('programme', programme, 'total', total) ORDER BY total DESC)
      FROM (
        SELECT COALESCE(NULLIF(trim(concat_ws(' ', p.programme_code, p.programme_name)), ''), 'Unassigned') AS programme,
          count(*) AS total
        FROM public.students s
        LEFT JOIN public.programmes p ON p.id = s.programme_id
        GROUP BY p.programme_code, p.programme_name
      ) distribution
    ), '[]'::jsonb),
    'byAdmissionYear', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('year', year, 'total', total) ORDER BY year DESC)
      FROM (
        SELECT COALESCE(to_char(admission_date, 'YYYY'), 'Unknown') AS year, count(*) AS total
        FROM public.students GROUP BY COALESCE(to_char(admission_date, 'YYYY'), 'Unknown')
      ) years
    ), '[]'::jsonb)
  ),
  'attendance', jsonb_build_object(
    'studentRecordsThisPeriod', (SELECT count(*) FROM public.attendance_records ar
      JOIN public.attendance_sessions ats ON ats.id = ar.attendance_session_id
      WHERE ats.session_date >= p_month_start::date
        AND ats.session_date < (p_month_start + interval '1 month')::date),
    'staffRecordsThisPeriod', (SELECT count(*) FROM public.staff_attendance
      WHERE attendance_date >= p_month_start::date
        AND attendance_date < (p_month_start + interval '1 month')::date)
  ),
  'results', jsonb_build_object(
    'waitingHod', (SELECT count(*) FROM public.course_results WHERE result_status = 'SUBMITTED'),
    'waitingExamination', (SELECT count(*) FROM public.course_results WHERE result_status = 'HOD_VERIFIED'),
    'waitingDeputy', (SELECT count(*) FROM public.course_results WHERE result_status = 'EXAMINATION_REVIEWED'),
    'waitingPrincipal', (SELECT count(*) FROM public.course_results WHERE result_status = 'DEPUTY_REVIEWED'),
    'waitingRegistrar', (SELECT count(*) FROM public.course_results WHERE result_status = 'PRINCIPAL_APPROVED'),
    'delayedOver14Days', (SELECT count(*) FROM public.course_results
      WHERE result_status IN ('SUBMITTED', 'HOD_VERIFIED', 'EXAMINATION_REVIEWED', 'DEPUTY_REVIEWED')
        AND updated_at < p_delayed_before)
  ),
  'approvals', jsonb_build_object(
    'expenses', (SELECT count(*) FROM public.finance_expense_requests WHERE status = 'FINANCE_REVIEWED'),
    'payroll', (SELECT count(*) FROM public.payroll_periods WHERE status = 'CALCULATED'),
    'refunds', (SELECT count(*) FROM public.refunds WHERE status = 'REQUESTED')
  ),
  'notes', jsonb_build_object(
    'monthPeriod', to_char(p_month_start AT TIME ZONE 'UTC', 'YYYY-MM'),
    'attendanceCountsAreForMonthPeriod', true,
    'outstandingFeesRequireFinanceAccountScope', true
  )
);
$function$;

REVOKE ALL ON FUNCTION public.idmc_leadership_dashboard_snapshot(timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.idmc_leadership_dashboard_snapshot(timestamptz, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_leadership_dashboard_snapshot(timestamptz, timestamptz) TO service_role;

CREATE INDEX IF NOT EXISTS idx_leadership_transactions_posted_period
  ON public.financial_transactions (status, transaction_type, transaction_date)
  INCLUDE (credit_amount);
CREATE INDEX IF NOT EXISTS idx_leadership_paid_expenses_period
  ON public.finance_expense_requests (status, paid_at)
  INCLUDE (amount);
CREATE INDEX IF NOT EXISTS idx_leadership_invoice_balance_status
  ON public.invoices (status)
  INCLUDE (balance_amount);
CREATE INDEX IF NOT EXISTS idx_leadership_results_status_updated
  ON public.course_results (result_status, updated_at);
CREATE INDEX IF NOT EXISTS idx_leadership_attendance_session_date
  ON public.attendance_sessions (session_date, id);
CREATE INDEX IF NOT EXISTS idx_leadership_staff_attendance_date
  ON public.staff_attendance (attendance_date);
CREATE INDEX IF NOT EXISTS idx_leadership_students_programme_year
  ON public.students (programme_id, admission_date);
