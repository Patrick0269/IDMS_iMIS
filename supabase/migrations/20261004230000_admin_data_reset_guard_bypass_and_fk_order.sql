BEGIN;
-- Preserve each delete guard for ordinary calls; allow the audited reset only.
CREATE OR REPLACE FUNCTION public.prevent_course_result_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF current_setting('idmc.admin_data_reset',true)='on' THEN RETURN OLD; END IF;
IF OLD.result_status IN ('PUBLISHED','LOCKED') THEN RAISE EXCEPTION 'Published or locked course result cannot be deleted.'; END IF; RETURN OLD; END; $$;
CREATE OR REPLACE FUNCTION public.prevent_financial_transaction_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF current_setting('idmc.admin_data_reset',true)='on' THEN RETURN OLD; END IF; RAISE EXCEPTION 'Financial transactions cannot be hard deleted. Use reversal/adjustment workflow.'; END; $$;
CREATE OR REPLACE FUNCTION public.prevent_financial_history_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF current_setting('idmc.admin_data_reset',true)='on' THEN RETURN OLD; END IF; RAISE EXCEPTION 'Financial records cannot be hard deleted. Use reversal, cancellation, refund, or adjustment workflow.'; END; $$;
CREATE OR REPLACE FUNCTION public.prevent_examination_mark_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF current_setting('idmc.admin_data_reset',true)='on' THEN RETURN OLD; END IF; RAISE EXCEPTION 'Examination marks cannot be deleted. Use the formal correction workflow.'; END; $$;
CREATE OR REPLACE FUNCTION public.prevent_assessment_mark_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status varchar(30); BEGIN
IF current_setting('idmc.admin_data_reset',true)='on' THEN RETURN OLD; END IF;
SELECT status INTO v_status FROM public.assessments WHERE id=OLD.assessment_id;
IF v_status IN ('APPROVED','LOCKED') THEN RAISE EXCEPTION 'Approved or locked assessment marks cannot be deleted.'; END IF;
RAISE EXCEPTION 'Assessment marks cannot be deleted. Use the correction workflow.'; END; $$;
CREATE OR REPLACE FUNCTION public.prevent_alumni_hard_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF current_setting('idmc.admin_data_reset',true)='on' THEN RETURN OLD; END IF; RAISE EXCEPTION 'Alumni records cannot be physically deleted. Change status instead.'; END; $$;
CREATE OR REPLACE FUNCTION public.prevent_notification_history_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF current_setting('idmc.admin_data_reset',true)='on' THEN RETURN OLD; END IF; RAISE EXCEPTION 'Notification history cannot be physically deleted. Use status changes instead.'; END; $$;
CREATE OR REPLACE FUNCTION public.prevent_locked_timetable_change() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE v_status varchar(30); BEGIN
IF current_setting('idmc.admin_data_reset',true)='on' AND TG_OP='DELETE' THEN RETURN OLD; END IF;
SELECT status INTO v_status FROM public.timetables WHERE id=COALESCE(NEW.timetable_id,OLD.timetable_id);
IF v_status='LOCKED' THEN RAISE EXCEPTION 'Locked timetable cannot be modified'; END IF; RETURN COALESCE(NEW,OLD); END; $$;

-- Wrap the existing, service-role-only reset function. Its safety checks and
-- protected admin/student logic stay intact; the bypass ends with this transaction.
ALTER FUNCTION public.admin_data_reset_execute(text[],text,uuid) RENAME TO admin_data_reset_execute_base;
REVOKE ALL ON FUNCTION public.admin_data_reset_execute_base(text[],text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_data_reset_execute_base(text[],text,uuid) TO service_role;
-- Include rows held in table partitions when topologically ordering FK deletes.
DO $$
DECLARE ddl text; old_fragment text:='child.relname=ANY(remaining)'; new_fragment text:=
  '(child.relname=ANY(remaining) OR EXISTS (WITH RECURSIVE parents(relid) AS ('||
  'SELECT child.oid UNION ALL SELECT i.inhparent FROM pg_inherits i JOIN parents p ON i.inhrelid=p.relid) '||
  'SELECT 1 FROM parents p JOIN pg_class ancestor ON ancestor.oid=p.relid '||
  'WHERE ancestor.relnamespace=''public''::regnamespace AND ancestor.relname=ANY(remaining) AND ancestor.relname<>parent.relname))';
BEGIN
  ddl:=pg_get_functiondef('public.admin_data_reset_execute_base(text[],text,uuid)'::regprocedure);
  IF position(old_fragment in ddl)=0 THEN
    RAISE EXCEPTION 'Could not locate the reset FK-ordering clause; migration stopped without changing data.';
  END IF;
  ddl:=replace(ddl,old_fragment,new_fragment);
  EXECUTE ddl;
END; $$;
CREATE FUNCTION public.admin_data_reset_execute(p_categories text[],p_project_reference text,p_actor_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM set_config('idmc.admin_data_reset','on',true);
  RETURN public.admin_data_reset_execute_base(p_categories,p_project_reference,p_actor_user_id);
END; $$;
REVOKE ALL ON FUNCTION public.admin_data_reset_execute(text[],text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_data_reset_execute(text[],text,uuid) TO service_role;
COMMIT;
