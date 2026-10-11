BEGIN;

-- Limit successful admissions-window openings to three per institution-local
-- calendar day. Re-saving a window that is already open does not consume a slot.
CREATE OR REPLACE FUNCTION public.idmc_intake_manage(p_data jsonb, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  x public.idmc_intakes;
  v_year uuid;
  v_code text;
  v_state text;
  v_opens_at timestamptz;
  v_closes_at timestamptz;
  v_day_start timestamptz;
  v_open_count integer;
  v_is_new_open boolean;
BEGIN
  IF NOT public.idmc_ap_role(p_actor, ARRAY['ADMISSIONS_OFFICER']) THEN
    RAISE EXCEPTION 'Only Admissions may manage intake application windows' USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_year := (p_data->>'yearId')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Choose a valid academic year.' USING ERRCODE = '22023';
  END;

  v_code := upper(trim(coalesce(p_data->>'code', '')));
  v_state := upper(trim(coalesce(p_data->>'state', '')));
  IF v_code NOT IN ('MARCH', 'SEPTEMBER') THEN
    RAISE EXCEPTION 'Choose March or September intake.' USING ERRCODE = '22023';
  END IF;
  IF v_state NOT IN ('DRAFT', 'SCHEDULED', 'OPEN', 'CLOSED') THEN
    RAISE EXCEPTION 'Choose a valid intake-window state.' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_opens_at := nullif(p_data->>'opensAt', '')::timestamptz;
    v_closes_at := nullif(p_data->>'closesAt', '')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Enter valid opening and closing dates and times.' USING ERRCODE = '22023';
  END;

  IF v_state IN ('SCHEDULED', 'OPEN') AND (v_opens_at IS NULL OR v_closes_at IS NULL) THEN
    RAISE EXCEPTION 'Opening and closing dates are required for a scheduled or open window.' USING ERRCODE = '22023';
  END IF;
  IF v_opens_at IS NOT NULL AND v_closes_at IS NOT NULL AND v_closes_at <= v_opens_at THEN
    RAISE EXCEPTION 'Closing date and time must be later than opening date and time.' USING ERRCODE = '22023';
  END IF;

  -- Serialize openings for the current local day before checking the limit.
  v_day_start := (date_trunc('day', now() AT TIME ZONE 'Africa/Dar_es_Salaam')) AT TIME ZONE 'Africa/Dar_es_Salaam';
  PERFORM pg_advisory_xact_lock(hashtextextended('idmc-intake-opening-limit:' || v_day_start::text, 0));

  SELECT * INTO x
    FROM public.idmc_intakes
   WHERE academic_year_id = v_year AND code = v_code
   FOR UPDATE;

  v_is_new_open := v_state = 'OPEN' AND (x.id IS NULL OR x.state <> 'OPEN');
  IF v_is_new_open THEN
    SELECT count(*)::integer INTO v_open_count
      FROM public.idmc_progression_events
     WHERE action = 'INTAKE_WINDOW_OPENED'
       AND created_at >= v_day_start
       AND created_at < v_day_start + interval '1 day';
    IF v_open_count >= 3 THEN
      RAISE EXCEPTION 'Daily limit reached: Admissions can open at most three application windows per day.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.idmc_intakes(academic_year_id, code, state, opens_at, closes_at, changed_by, reason)
  VALUES (v_year, v_code, v_state, v_opens_at, v_closes_at, p_actor, nullif(trim(coalesce(p_data->>'reason', '')), ''))
  ON CONFLICT (academic_year_id, code) DO UPDATE
    SET state = excluded.state,
        opens_at = excluded.opens_at,
        closes_at = excluded.closes_at,
        changed_by = p_actor,
        changed_at = now(),
        reason = excluded.reason
  RETURNING * INTO x;

  INSERT INTO public.idmc_progression_events(actor_id, action, entity_id, details)
  VALUES (p_actor, CASE WHEN v_is_new_open THEN 'INTAKE_WINDOW_OPENED' ELSE 'INTAKE_WINDOW_CHANGED' END, x.id, to_jsonb(x));

  RETURN to_jsonb(x);
END;
$$;

COMMIT;
