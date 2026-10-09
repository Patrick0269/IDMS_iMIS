BEGIN;
CREATE OR REPLACE FUNCTION public.idmc_exam_bundle(p_data jsonb,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE pr public.examination_periods; o public.course_offerings; c public.courses; pol public.course_result_policies; x jsonb; roomid uuid; paperid uuid; dt date; st time; en time; dur integer; result jsonb:='[]'; roomtext text; seq integer:=0; capacity integer;
BEGIN
 SELECT * INTO pr FROM public.examination_periods WHERE id=(p_data->>'examinationPeriodId')::uuid FOR UPDATE;
 IF pr.id IS NULL OR pr.status NOT IN ('DRAFT','PLANNING','APPROVED') THEN RAISE EXCEPTION 'Select an editable examination period'; END IF;
 IF coalesce(jsonb_array_length(p_data->'courseOfferingIds'),0) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Select 1 to 100 courses'; END IF;
 dt:=(p_data->>'examinationDate')::date; st:=(p_data->>'startTime')::time; dur:=(p_data->>'durationMinutes')::integer; capacity:=(p_data->>'capacity')::integer; roomtext:=trim(p_data->>'roomName');
 IF dt NOT BETWEEN pr.start_date AND pr.end_date OR dur<=0 OR capacity<=0 OR coalesce(roomtext,'')='' THEN RAISE EXCEPTION 'Check date, duration, room and capacity'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended((p_data->>'campusId')||lower(roomtext),0));
 SELECT id INTO roomid FROM public.rooms WHERE campus_id=(p_data->>'campusId')::uuid AND lower(room_name)=lower(roomtext) AND status='ACTIVE' LIMIT 1;
 IF roomid IS NULL THEN INSERT INTO public.rooms(campus_id,room_code,room_name,room_type,capacity) VALUES((p_data->>'campusId')::uuid,'EX-'||left(gen_random_uuid()::text,12),roomtext,'HALL',capacity) RETURNING id INTO roomid; END IF;
 FOR x IN SELECT * FROM jsonb_array_elements(p_data->'courseOfferingIds') LOOP
 SELECT * INTO o FROM public.course_offerings WHERE id=(x#>>'{}')::uuid;
 IF o.id IS NULL OR o.academic_year_id<>pr.academic_year_id OR o.semester_id<>pr.semester_id THEN RAISE EXCEPTION 'Course must belong to the examination year and semester'; END IF;
 SELECT * INTO c FROM public.courses WHERE id=o.course_id;
 SELECT * INTO pol FROM public.course_result_policies WHERE course_offering_id=o.id AND status IN ('ACTIVE','LOCKED');
 IF pol.id IS NULL OR pol.examination_weight<=0 THEN RAISE EXCEPTION 'Configure an active examination policy for %',c.course_code; END IF;
 IF EXISTS(SELECT 1 FROM public.examination_papers WHERE examination_period_id=pr.id AND course_offering_id=o.id AND status<>'CANCELLED') THEN RAISE EXCEPTION 'Paper already exists for %; edit it instead of creating a duplicate',c.course_code; END IF;
 IF seq>0 AND st<=(p_data->>'startTime')::time THEN RAISE EXCEPTION 'Not enough hours in this date; split the schedule across dates'; END IF;
 en:=st+(dur||' minutes')::interval;
 IF en<=st THEN RAISE EXCEPTION 'Examination must finish on the same day'; END IF;
 INSERT INTO public.examination_papers(examination_period_id,course_offering_id,paper_code,paper_title,examination_type,maximum_marks,duration_minutes,status,created_by)
 VALUES(pr.id,o.id,left(c.course_code||'-'||pr.period_code,80),c.course_name,CASE WHEN pr.examination_type IN ('SUPPLEMENTARY','SPECIAL','RESIT','MAKEUP') THEN pr.examination_type ELSE 'FINAL' END,pol.examination_weight,dur,'SCHEDULED',p_actor) RETURNING id INTO paperid;
 INSERT INTO public.examination_sessions(examination_paper_id,campus_id,room_id,examination_date,start_time,end_time,session_code,capacity,status,created_by)
 VALUES(paperid,(p_data->>'campusId')::uuid,roomid,dt,st,en,'EXS-'||gen_random_uuid()::text,capacity,'SCHEDULED',p_actor);
 result:=result||jsonb_build_object('paperId',paperid,'course',c.course_name,'date',dt,'start',st,'end',en);
 st:=en+interval '30 minutes'; seq:=seq+1;
 END LOOP;
 INSERT INTO public.idmc_workflow_events(entity_id,action,actor_id,details) VALUES(pr.id,'EXAM_BUNDLE_CREATED',p_actor,result);
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.idmc_timetable_rows(p_timetable uuid,p_rows jsonb,p_actor uuid) RETURNS integer LANGUAGE plpgsql SET search_path=public AS $$
DECLARE tt public.timetables; x jsonb; o public.course_offerings; cls uuid; slot uuid; roomid uuid; n integer:=0; st time; en time; day integer;
BEGIN
 SELECT * INTO tt FROM public.timetables WHERE id=p_timetable FOR UPDATE;
 IF tt.id IS NULL OR tt.status IN ('PUBLISHED','LOCKED','CANCELLED') THEN RAISE EXCEPTION 'Choose an editable timetable'; END IF;
 IF coalesce(jsonb_array_length(p_rows),0) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Import 1 to 500 sessions'; END IF;
 FOR x IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
 SELECT * INTO o FROM public.course_offerings WHERE id=(x->>'courseOfferingId')::uuid;
 IF o.id IS NULL OR o.academic_year_id<>tt.academic_year_id OR o.semester_id<>tt.semester_id THEN RAISE EXCEPTION 'Course offering must match timetable year and semester'; END IF;
 st:=(x->>'startTime')::time; en:=(x->>'endTime')::time; day:=(x->>'dayOfWeek')::integer;
 IF day NOT BETWEEN 1 AND 7 OR en<=st THEN RAISE EXCEPTION 'Use day 1..7 and an end time after the start time'; END IF;
 SELECT id INTO roomid FROM public.rooms WHERE campus_id=tt.campus_id AND lower(room_code)=lower(trim(x->>'roomCode')) AND status='ACTIVE';
 IF roomid IS NULL THEN RAISE EXCEPTION 'Room code % not found on this campus',x->>'roomCode'; END IF;
 SELECT id INTO cls FROM public.classes WHERE course_offering_id=o.id AND status='ACTIVE' ORDER BY created_at LIMIT 1;
 IF cls IS NULL THEN INSERT INTO public.classes(course_offering_id,class_code,class_name,status,capacity) VALUES(o.id,'CLS-'||left(o.id::text,16),o.offering_code,'ACTIVE',greatest(o.capacity,1)) RETURNING id INTO cls; END IF;
 SELECT id INTO slot FROM public.timetable_slots WHERE day_of_week=day AND start_time=st AND end_time=en AND status='ACTIVE' LIMIT 1;
 IF slot IS NULL THEN INSERT INTO public.timetable_slots(slot_code,day_of_week,start_time,end_time,duration_minutes) VALUES('SLOT-'||left(gen_random_uuid()::text,16),day,st,en,extract(epoch FROM(en-st))/60) RETURNING id INTO slot; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.timetable_entries WHERE timetable_id=tt.id AND course_offering_id=o.id AND room_id=roomid AND timetable_slot_id=slot AND status<>'CANCELLED') THEN
 INSERT INTO public.timetable_entries(timetable_id,class_id,course_offering_id,room_id,timetable_slot_id,status,created_by) VALUES(tt.id,cls,o.id,roomid,slot,'CONFIRMED',p_actor); n:=n+1;
 END IF;
 END LOOP; RETURN n;
END $$;
CREATE OR REPLACE FUNCTION public.idmc_decide_withdrawal(p_id uuid,p_approve boolean,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE w public.idmc_student_withdrawals; snap jsonb;
BEGIN
 SELECT * INTO w FROM public.idmc_student_withdrawals WHERE id=p_id FOR UPDATE;
 IF w.id IS NULL OR w.status<>'PENDING' THEN RAISE EXCEPTION 'Only pending requests may be decided'; END IF;
 SELECT jsonb_build_object('student',to_jsonb(s),'profiles',(SELECT coalesce(jsonb_agg(p),'[]') FROM public.student_profiles p WHERE p.student_id=s.id),'registrations',(SELECT coalesce(jsonb_agg(r),'[]') FROM public.student_registrations r WHERE r.student_id=s.id),'course_registrations',(SELECT coalesce(jsonb_agg(r),'[]') FROM public.course_registrations r WHERE r.student_id=s.id),'invoices',(SELECT coalesce(jsonb_agg(i),'[]') FROM public.invoices i WHERE i.student_id=s.id),'payments',(SELECT coalesce(jsonb_agg(p),'[]') FROM public.payments p WHERE p.student_id=s.id),'charges',(SELECT coalesce(jsonb_agg(c),'[]') FROM public.student_charges c WHERE c.student_id=s.id),'transactions',(SELECT coalesce(jsonb_agg(t),'[]') FROM public.financial_transactions t WHERE t.student_id=s.id),'results',(SELECT coalesce(jsonb_agg(r),'[]') FROM public.course_results r WHERE r.student_id=s.id)) INTO snap FROM public.students s WHERE s.id=w.student_id;
 IF p_approve THEN UPDATE public.students SET student_status='WITHDRAWN',updated_at=now() WHERE id=w.student_id; END IF;
 UPDATE public.idmc_student_withdrawals SET status=CASE WHEN p_approve THEN 'APPROVED' ELSE 'REJECTED' END,decided_by=p_actor,decided_at=now(),record_snapshot=snap WHERE id=p_id RETURNING * INTO w;
 INSERT INTO public.idmc_workflow_events(entity_id,action,actor_id,details) VALUES(w.student_id,'WITHDRAWAL_'||w.status,p_actor,jsonb_build_object('request',w.id,'reason',w.reason));
 RETURN to_jsonb(w);
END $$;
CREATE OR REPLACE FUNCTION public.idmc_roll_academic_year() RETURNS uuid LANGUAGE plpgsql SET search_path=public AS $$
DECLARE y integer; outid uuid; today date:=(now() AT TIME ZONE 'Africa/Dar_es_Salaam')::date;
BEGIN
 y:=extract(year FROM today)::integer; IF extract(month FROM today)<10 THEN y:=y-1; END IF;
 -- Manual academic year records and statuses are retained. The annual record is created once.
 INSERT INTO public.academic_years(year_code,year_name,start_date,end_date,status) VALUES(y||'/'||(y+1),y||'/'||(y+1),make_date(y,10,1),make_date(y+1,9,30),'ACTIVE') ON CONFLICT(year_code) DO NOTHING;
 SELECT id INTO outid FROM public.academic_years WHERE year_code=y||'/'||(y+1); RETURN outid;
END $$;
REVOKE ALL ON FUNCTION public.idmc_exam_bundle(jsonb,uuid),public.idmc_timetable_rows(uuid,jsonb,uuid),public.idmc_decide_withdrawal(uuid,boolean,uuid),public.idmc_roll_academic_year() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.idmc_exam_bundle(jsonb,uuid),public.idmc_timetable_rows(uuid,jsonb,uuid),public.idmc_decide_withdrawal(uuid,boolean,uuid),public.idmc_roll_academic_year() TO service_role;
COMMIT;
