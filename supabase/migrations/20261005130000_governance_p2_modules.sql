-- P2 institutional governance modules. This migration only adds new structures,
-- permissions and roles; existing records and workflows are not rewritten.

CREATE TABLE IF NOT EXISTS public.discipline_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE RESTRICT,
  case_number varchar(80) NOT NULL UNIQUE,
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE RESTRICT,
  department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  case_type varchar(60) NOT NULL,
  incident_date date NOT NULL,
  description text NOT NULL,
  confidentiality varchar(20) NOT NULL DEFAULT 'RESTRICTED' CHECK (confidentiality IN ('CONFIDENTIAL','RESTRICTED')),
  assigned_to uuid REFERENCES public.users(id) ON DELETE SET NULL,
  status varchar(30) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','INVESTIGATION','HEARING','DECIDED','APPEAL','CLOSED')),
  decision text,
  sanction text,
  appeal_due_date date,
  closed_at timestamptz,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.discipline_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.discipline_cases(id) ON DELETE RESTRICT,
  event_type varchar(40) NOT NULL CHECK (event_type IN ('INVESTIGATION','EVIDENCE','HEARING','DECISION','SANCTION','APPEAL','NOTE')),
  event_date timestamptz NOT NULL DEFAULT now(),
  details text NOT NULL,
  document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.student_welfare_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE RESTRICT,
  case_number varchar(80) NOT NULL UNIQUE,
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE RESTRICT,
  case_type varchar(30) NOT NULL CHECK (case_type IN ('COUNSELLING','WELFARE','REFERRAL')),
  priority varchar(15) NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  summary text NOT NULL,
  confidential_notes text,
  assigned_to uuid REFERENCES public.users(id) ON DELETE SET NULL,
  follow_up_at timestamptz,
  status varchar(25) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','REFERRED','FOLLOW_UP','RESOLVED','CLOSED')),
  closed_at timestamptz,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.student_welfare_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.student_welfare_cases(id) ON DELETE RESTRICT,
  follow_up_at timestamptz NOT NULL DEFAULT now(),
  note text NOT NULL,
  next_follow_up_at timestamptz,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.institutional_grievances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE RESTRICT,
  case_number varchar(80) NOT NULL UNIQUE,
  complainant_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  complainant_student_id uuid REFERENCES public.students(id) ON DELETE RESTRICT,
  subject varchar(200) NOT NULL,
  description text NOT NULL,
  confidentiality varchar(20) NOT NULL DEFAULT 'CONFIDENTIAL' CHECK (confidentiality IN ('CONFIDENTIAL','RESTRICTED')),
  investigator_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  status varchar(25) NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','UNDER_REVIEW','INVESTIGATION','RESPONSE_DUE','RESOLVED','APPEAL','CLOSED')),
  response text,
  resolution text,
  appeal_due_date date,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (complainant_user_id IS NOT NULL OR complainant_student_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.grievance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grievance_id uuid NOT NULL REFERENCES public.institutional_grievances(id) ON DELETE RESTRICT,
  event_type varchar(30) NOT NULL CHECK (event_type IN ('ASSIGNMENT','INVESTIGATION','EVIDENCE','RESPONSE','RESOLUTION','APPEAL','NOTE')),
  details text NOT NULL,
  document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.transport_vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE RESTRICT,
  asset_id uuid REFERENCES public.assets(id) ON DELETE SET NULL,
  registration_number varchar(40) NOT NULL UNIQUE,
  vehicle_type varchar(40) NOT NULL,
  make_model varchar(120),
  capacity integer NOT NULL CHECK (capacity > 0),
  assigned_driver_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  insurance_expiry date,
  inspection_due date,
  status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','MAINTENANCE','INACTIVE','RETIRED')),
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.transport_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE RESTRICT,
  route_code varchar(50) NOT NULL UNIQUE,
  route_name varchar(150) NOT NULL,
  origin text NOT NULL,
  destination text NOT NULL,
  distance_km numeric(10,2) CHECK (distance_km IS NULL OR distance_km >= 0),
  status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.transport_trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_number varchar(80) NOT NULL UNIQUE,
  vehicle_id uuid NOT NULL REFERENCES public.transport_vehicles(id) ON DELETE RESTRICT,
  route_id uuid REFERENCES public.transport_routes(id) ON DELETE SET NULL,
  driver_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  departure_at timestamptz NOT NULL,
  return_at timestamptz,
  purpose text NOT NULL,
  passenger_count integer NOT NULL DEFAULT 0 CHECK (passenger_count >= 0),
  status varchar(20) NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','APPROVED','IN_PROGRESS','COMPLETED','CANCELLED')),
  approved_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (return_at IS NULL OR return_at >= departure_at)
);

CREATE TABLE IF NOT EXISTS public.transport_maintenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES public.transport_vehicles(id) ON DELETE RESTRICT,
  maintenance_type varchar(50) NOT NULL,
  description text NOT NULL,
  service_provider varchar(150),
  service_date date NOT NULL,
  next_due_date date,
  cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  status varchar(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','COMPLETED','CANCELLED')),
  finance_reference varchar(100),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.institutional_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE RESTRICT,
  department_id uuid REFERENCES public.departments(id) ON DELETE RESTRICT,
  budget_code varchar(60) NOT NULL UNIQUE,
  fiscal_year varchar(20) NOT NULL,
  title varchar(200) NOT NULL,
  proposed_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (proposed_amount >= 0),
  approved_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (approved_amount >= 0),
  currency_code varchar(10) NOT NULL DEFAULT 'TZS',
  status varchar(30) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','FINANCE_REVIEW','PRINCIPAL_REVIEW','DIRECTOR_REVIEW','APPROVED','REJECTED','LOCKED')),
  submitted_at timestamptz,
  approved_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  comment text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.budget_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id uuid NOT NULL REFERENCES public.institutional_budgets(id) ON DELETE RESTRICT,
  line_code varchar(60) NOT NULL,
  description text NOT NULL,
  category varchar(80) NOT NULL,
  proposed_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (proposed_amount >= 0),
  approved_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (approved_amount >= 0),
  spent_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (spent_amount >= 0),
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (budget_id, line_code)
);

CREATE TABLE IF NOT EXISTS public.institutional_risks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE RESTRICT,
  risk_code varchar(60) NOT NULL UNIQUE,
  title varchar(200) NOT NULL,
  category varchar(80) NOT NULL,
  description text NOT NULL,
  probability smallint NOT NULL CHECK (probability BETWEEN 1 AND 5),
  impact smallint NOT NULL CHECK (impact BETWEEN 1 AND 5),
  risk_score integer GENERATED ALWAYS AS (probability * impact) STORED,
  owner_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  mitigation text,
  review_date date,
  status varchar(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','MITIGATING','ACCEPTED','CLOSED')),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.strategic_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE RESTRICT,
  goal_code varchar(60) NOT NULL UNIQUE,
  title varchar(200) NOT NULL,
  description text,
  owner_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  start_date date,
  target_date date,
  status varchar(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','AT_RISK','COMPLETED','CANCELLED')),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.strategic_kpis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id uuid NOT NULL REFERENCES public.strategic_goals(id) ON DELETE RESTRICT,
  kpi_code varchar(60) NOT NULL,
  title varchar(200) NOT NULL,
  unit varchar(40) NOT NULL,
  baseline numeric(18,4),
  target numeric(18,4) NOT NULL,
  actual numeric(18,4),
  measurement_date date,
  owner_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (goal_id, kpi_code)
);

CREATE TABLE IF NOT EXISTS public.management_meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE RESTRICT,
  meeting_number varchar(60) NOT NULL UNIQUE,
  title varchar(200) NOT NULL,
  meeting_type varchar(40) NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  venue text,
  chair_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  minutes text,
  status varchar(20) NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','HELD','MINUTES_DRAFT','MINUTES_APPROVED','CANCELLED')),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);

CREATE TABLE IF NOT EXISTS public.meeting_agenda_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES public.management_meetings(id) ON DELETE RESTRICT,
  item_number integer NOT NULL CHECK (item_number > 0),
  title varchar(200) NOT NULL,
  presenter_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  discussion_notes text,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, item_number)
);

CREATE TABLE IF NOT EXISTS public.meeting_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES public.management_meetings(id) ON DELETE RESTRICT,
  agenda_item_id uuid REFERENCES public.meeting_agenda_items(id) ON DELETE RESTRICT,
  action_number varchar(80) NOT NULL UNIQUE,
  action_text text NOT NULL,
  owner_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  due_date date,
  status varchar(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','COMPLETED','OVERDUE','CANCELLED')),
  completion_note text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.accreditation_standards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE RESTRICT,
  standard_code varchar(80) NOT NULL UNIQUE,
  regulator varchar(120) NOT NULL,
  title varchar(200) NOT NULL,
  requirement text NOT NULL,
  owner_department_id uuid REFERENCES public.departments(id) ON DELETE SET NULL,
  review_due_date date,
  status varchar(25) NOT NULL DEFAULT 'NOT_ASSESSED' CHECK (status IN ('NOT_ASSESSED','COMPLIANT','PARTIALLY_COMPLIANT','NON_COMPLIANT','REVIEW_DUE')),
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.accreditation_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  standard_id uuid NOT NULL REFERENCES public.accreditation_standards(id) ON DELETE RESTRICT,
  evidence_title varchar(200) NOT NULL,
  evidence_type varchar(50) NOT NULL,
  storage_path text,
  document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  verified_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  verified_at timestamptz,
  expiry_date date,
  status varchar(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','REJECTED','EXPIRED')),
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discipline_cases_student_status ON public.discipline_cases(student_id,status);
CREATE INDEX IF NOT EXISTS idx_discipline_events_case_date ON public.discipline_case_events(case_id,event_date DESC);
CREATE INDEX IF NOT EXISTS idx_welfare_cases_assignee_status ON public.student_welfare_cases(assigned_to,status);
CREATE INDEX IF NOT EXISTS idx_grievances_investigator_status ON public.institutional_grievances(investigator_user_id,status);
CREATE INDEX IF NOT EXISTS idx_transport_trips_vehicle_departure ON public.transport_trips(vehicle_id,departure_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_department_year ON public.institutional_budgets(department_id,fiscal_year,status);
CREATE INDEX IF NOT EXISTS idx_risks_score_review ON public.institutional_risks(risk_score DESC,review_date);
CREATE INDEX IF NOT EXISTS idx_strategic_kpis_goal_date ON public.strategic_kpis(goal_id,measurement_date DESC);
CREATE INDEX IF NOT EXISTS idx_meeting_actions_owner_status ON public.meeting_actions(owner_user_id,status,due_date);
CREATE INDEX IF NOT EXISTS idx_accreditation_review_due ON public.accreditation_standards(review_due_date,status);

-- These tables are accessed through the authenticated API, where RBAC is
-- enforced. Direct client access remains denied by RLS (service_role bypasses it).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'discipline_cases','discipline_case_events','student_welfare_cases','student_welfare_followups',
    'institutional_grievances','grievance_events','transport_vehicles','transport_routes',
    'transport_trips','transport_maintenance','institutional_budgets','budget_lines',
    'institutional_risks','strategic_goals','strategic_kpis','management_meetings',
    'meeting_agenda_items','meeting_actions','accreditation_standards','accreditation_evidence'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'discipline_cases','student_welfare_cases','institutional_grievances',
    'transport_vehicles','transport_routes','transport_trips','institutional_budgets',
    'institutional_risks','strategic_goals','strategic_kpis','management_meetings',
    'meeting_actions','accreditation_standards'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t, t);
  END LOOP;
END $$;

INSERT INTO public.roles(role_code,role_name,description,is_system_role) VALUES
 ('DISCIPLINE_OFFICER','Discipline Officer','Manages confidential student discipline cases.',true),
 ('COUNSELLOR','Student Counsellor','Manages confidential counselling and welfare cases.',true),
 ('WELFARE_OFFICER','Student Welfare Officer','Coordinates restricted student welfare cases.',true),
 ('TRANSPORT_OFFICER','Transport Officer','Manages institutional transport and vehicle records.',true),
 ('BUDGET_OFFICER','Budget Officer','Coordinates institutional budget preparation and reporting.',true),
 ('RISK_OFFICER','Risk Officer','Maintains institutional risk records and mitigation.',true),
 ('PLANNING_OFFICER','Strategic Planning Officer','Coordinates institutional goals, objectives and KPIs.',true),
 ('BOARD_SECRETARY','Board Secretary','Maintains controlled management and board meeting records.',true),
 ('GRIEVANCE_OFFICER','Grievance Officer','Investigates confidential institutional grievances.',true),
 ('ACCREDITATION_OFFICER','Accreditation Officer','Maintains standards, reviews and evidence.',true)
ON CONFLICT(role_code) DO NOTHING;

INSERT INTO public.permissions(permission_code,permission_name,module_code,action_code,description,status) VALUES
 ('discipline.view','View discipline cases','DISCIPLINE','VIEW','View confidential student discipline cases.','ACTIVE'),
 ('discipline.manage','Manage discipline cases','DISCIPLINE','MANAGE','Create and update discipline cases and events.','ACTIVE'),
 ('welfare.view','View confidential welfare cases','STUDENT_WELFARE','VIEW','View restricted counselling and welfare case records.','ACTIVE'),
 ('welfare.manage','Manage confidential welfare cases','STUDENT_WELFARE','MANAGE','Create and update restricted counselling and welfare cases.','ACTIVE'),
 ('grievances.view','View confidential grievances','GRIEVANCES','VIEW','View restricted institutional grievance records.','ACTIVE'),
 ('grievances.manage','Manage confidential grievances','GRIEVANCES','MANAGE','Create and update confidential grievance records.','ACTIVE'),
 ('transport.view','View transport records','TRANSPORT','VIEW','View institutional transport records.','ACTIVE'),
 ('transport.manage','Manage transport records','TRANSPORT','MANAGE','Create and update transport records.','ACTIVE'),
 ('budget.view','View institutional budgets','BUDGET','VIEW','View budget plans, lines and allocations.','ACTIVE'),
 ('budget.manage','Manage institutional budgets','BUDGET','MANAGE','Prepare and update budget plans and allocations.','ACTIVE'),
 ('budget.approve','Approve institutional budgets','BUDGET','APPROVE','Approve submitted institutional budgets.','ACTIVE'),
 ('risk.view','View institutional risk register','RISK','VIEW','View institutional risks and mitigations.','ACTIVE'),
 ('risk.manage','Manage institutional risk register','RISK','MANAGE','Create and update institutional risks and mitigations.','ACTIVE'),
 ('strategy.view','View strategic goals and KPIs','STRATEGY','VIEW','View strategic plans and performance measures.','ACTIVE'),
 ('strategy.manage','Manage strategic goals and KPIs','STRATEGY','MANAGE','Create and update institutional plans and KPIs.','ACTIVE'),
 ('meetings.view','View management meetings','MEETINGS','VIEW','View controlled meeting, agenda and action records.','ACTIVE'),
 ('meetings.manage','Manage management meetings','MEETINGS','MANAGE','Create and update meeting, agenda and action records.','ACTIVE'),
 ('accreditation.view','View accreditation records','ACCREDITATION','VIEW','View accreditation standards and evidence records.','ACTIVE'),
 ('accreditation.manage','Manage accreditation records','ACCREDITATION','MANAGE','Create and update accreditation standards and evidence.','ACTIVE')
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM public.roles r JOIN public.permissions p ON p.permission_code = ANY(CASE r.role_code
  WHEN 'DISCIPLINE_OFFICER' THEN ARRAY['discipline.view','discipline.manage']
  WHEN 'COUNSELLOR' THEN ARRAY['welfare.view','welfare.manage']
  WHEN 'WELFARE_OFFICER' THEN ARRAY['welfare.view','welfare.manage']
  WHEN 'TRANSPORT_OFFICER' THEN ARRAY['transport.view','transport.manage']
  WHEN 'BUDGET_OFFICER' THEN ARRAY['budget.view','budget.manage']
  WHEN 'RISK_OFFICER' THEN ARRAY['risk.view','risk.manage']
  WHEN 'PLANNING_OFFICER' THEN ARRAY['strategy.view','strategy.manage']
  WHEN 'BOARD_SECRETARY' THEN ARRAY['meetings.view','meetings.manage']
  WHEN 'GRIEVANCE_OFFICER' THEN ARRAY['grievances.view','grievances.manage']
  WHEN 'ACCREDITATION_OFFICER' THEN ARRAY['accreditation.view','accreditation.manage']
  WHEN 'PRINCIPAL' THEN ARRAY['discipline.view','grievances.view','budget.view','budget.approve','risk.view','strategy.view','meetings.view','accreditation.view']
  WHEN 'DIRECTOR' THEN ARRAY['budget.view','budget.approve','risk.view','strategy.view','meetings.view','accreditation.view']
  WHEN 'DEPUTY_PRINCIPAL' THEN ARRAY['discipline.view','grievances.view','accreditation.view']
  WHEN 'ADMIN' THEN ARRAY['discipline.view','discipline.manage','welfare.view','welfare.manage','grievances.view','grievances.manage','transport.view','transport.manage','budget.view','budget.manage','budget.approve','risk.view','risk.manage','strategy.view','strategy.manage','meetings.view','meetings.manage','accreditation.view','accreditation.manage']
  WHEN 'SUPER_ADMIN' THEN ARRAY['discipline.view','discipline.manage','welfare.view','welfare.manage','grievances.view','grievances.manage','transport.view','transport.manage','budget.view','budget.manage','budget.approve','risk.view','risk.manage','strategy.view','strategy.manage','meetings.view','meetings.manage','accreditation.view','accreditation.manage']
  ELSE ARRAY[]::text[] END)
ON CONFLICT(role_id,permission_id) DO NOTHING;
