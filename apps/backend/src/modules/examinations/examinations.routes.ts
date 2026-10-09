import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/rbac.js";
import { getSupabase } from "../../config/database.js";
import { registerCrudResource } from "../../utils/resourceCrud.js";
import { createAuditLog } from "../../services/audit.service.js";
const router=Router(); router.use(authenticate);
const VIEW="examinations.view", MANAGE="examinations.manage", MARKS="examinations.marks.manage", CORRECT="examinations.corrections.manage";
const paperTypes = new Set(["FINAL","SUPPLEMENTARY","SPECIAL","RESIT","MAKEUP"]);
const mutablePeriodStatuses = ["DRAFT", "PLANNING", "APPROVED"];
function workflowConflict(message: string) { return Object.assign(new Error(message), { statusCode: 409 }); }
async function assertMutablePeriod(db: ReturnType<typeof getSupabase>, id: string) {
  const result = await db.from("examination_periods").select("id,status").eq("id", id).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw Object.assign(new Error("Examination period was not found."), { statusCode: 404 });
  if (!mutablePeriodStatuses.includes(String(result.data.status).toUpperCase())) throw workflowConflict(`This period is ${result.data.status}; its examination schedule is read-only.`);
}
async function assertMutablePaperPeriod(db: ReturnType<typeof getSupabase>, paperId: string) {
  const result = await db.from("examination_papers").select("examination_period_id").eq("id", paperId).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw Object.assign(new Error("Examination paper was not found."), { statusCode: 404 });
  await assertMutablePeriod(db, String(result.data.examination_period_id));
}

router.get("/papers/:id/mark-roster", requirePermission(VIEW), async (req,res,next)=>{
  try {
    const db=getSupabase(), paperId=String(req.params.id??"");
    const paper=await db.from("examination_papers").select("id,paper_code,paper_title,maximum_marks,status,course_offering_id").eq("id",paperId).maybeSingle();
    if(paper.error)throw paper.error;
    if(!paper.data)return res.status(404).json({success:false,message:"Examination paper was not found."});
    const candidates=await db.from("examination_candidates").select("id,candidate_number,student_id,course_registration_id,eligibility_status,candidate_status").eq("examination_paper_id",paperId).eq("eligibility_status","ELIGIBLE").eq("candidate_status","ACTIVE").order("candidate_number").limit(2000);
    if(candidates.error)throw candidates.error;
    const ids=(candidates.data??[]).map((row:any)=>row.id),studentIds=[...new Set((candidates.data??[]).map((row:any)=>row.student_id))];
    const [marks,students,profiles]=await Promise.all([
      ids.length?db.from("examination_marks").select("id,examination_candidate_id,marks,remarks,status,entered_by,entered_at").eq("examination_paper_id",paperId).in("examination_candidate_id",ids):Promise.resolve({data:[],error:null}),
      studentIds.length?db.from("students").select("id,student_number").in("id",studentIds):Promise.resolve({data:[],error:null}),
      studentIds.length?db.from("student_profiles").select("student_id,first_name,middle_name,last_name").in("student_id",studentIds):Promise.resolve({data:[],error:null}),
    ]);
    for(const result of [marks,students,profiles])if(result.error)throw result.error;
    const markMap=new Map((marks.data??[]).map((row:any)=>[row.examination_candidate_id,row]));
    const numberMap=new Map((students.data??[]).map((row:any)=>[row.id,row.student_number]));
    const profileMap=new Map((profiles.data??[]).map((row:any)=>[row.student_id,row]));
    const roster=(candidates.data??[]).map((row:any)=>{const p:any=profileMap.get(row.student_id)||{},m:any=markMap.get(row.id)||{};return {...row,student_number:numberMap.get(row.student_id)||"",student_name:[p.first_name,p.middle_name,p.last_name].filter(Boolean).join(" "),mark_id:m.id??null,marks:m.marks??null,remarks:m.remarks??"",mark_status:m.status??"NOT_ENTERED",entered_by:m.entered_by??null,entered_at:m.entered_at??null};});
    return res.json({success:true,data:{paper:paper.data,roster}});
  }catch(error){next(error);}
});

router.post("/marks/entry", requirePermission(MARKS), async (req,res,next)=>{
  try {
    const db=getSupabase(),actorId=req.user?.id,candidateId=String(req.body?.candidateId??"").trim(),rawMarks=req.body?.marks,remarks=String(req.body?.remarks??"").trim().slice(0,2000);
    if(!actorId)return res.status(401).json({success:false,message:"Authenticated user is required."});
    if(!candidateId)return res.status(400).json({success:false,message:"Examination candidate is required."});
    const mark=Number(rawMarks);
    if(rawMarks===null||rawMarks===""||!Number.isFinite(mark)||mark<0||!Number.isInteger(mark*100))return res.status(400).json({success:false,message:"Enter marks as a non-negative amount with at most two decimal places."});
    const candidate=await db.from("examination_candidates").select("id,examination_paper_id,student_id,course_registration_id,eligibility_status,candidate_status").eq("id",candidateId).maybeSingle();
    if(candidate.error)throw candidate.error;
    if(!candidate.data)return res.status(404).json({success:false,message:"Examination candidate was not found."});
    if(candidate.data.eligibility_status!=="ELIGIBLE"||candidate.data.candidate_status!=="ACTIVE")return res.status(409).json({success:false,message:"Marks can be entered only for an active eligible examination candidate."});
    const paper=await db.from("examination_papers").select("id,maximum_marks,examination_period_id").eq("id",candidate.data.examination_paper_id).maybeSingle();
    if(paper.error)throw paper.error;
    if(!paper.data)return res.status(404).json({success:false,message:"Examination paper was not found."});
    const period=await db.from("examination_periods").select("id,status").eq("id",paper.data.examination_period_id).maybeSingle();
    if(period.error)throw period.error;
    if(!period.data)return res.status(404).json({success:false,message:"Examination period was not found."});
    if(!["PUBLISHED","COMPLETED"].includes(String(period.data.status).toUpperCase()))return res.status(409).json({success:false,message:`Marks can be entered only after the examination period is published; this period is ${period.data.status}.`});
    if(mark>Number(paper.data.maximum_marks))return res.status(400).json({success:false,message:`Marks cannot exceed ${paper.data.maximum_marks}.`});
    const prior=await db.from("examination_marks").select("id,status,marks,remarks").eq("examination_paper_id",paper.data.id).eq("examination_candidate_id",candidateId).maybeSingle();
    if(prior.error)throw prior.error;
    if(prior.data&&prior.data.status!=="DRAFT")return res.status(409).json({success:false,message:`This mark is ${prior.data.status} and can no longer be edited here.`});
    const now=new Date().toISOString(),payload={marks:mark,remarks:remarks||null,entered_by:actorId,entered_at:now,updated_at:now};
    const saved=prior.data
      ?await db.from("examination_marks").update(payload).eq("id",prior.data.id).eq("status","DRAFT").select("id,examination_paper_id,examination_candidate_id,student_id,course_registration_id,marks,percentage,grade,remarks,status,entered_by,entered_at").maybeSingle()
      :await db.from("examination_marks").insert({examination_paper_id:paper.data.id,examination_candidate_id:candidateId,student_id:candidate.data.student_id,course_registration_id:candidate.data.course_registration_id,...payload,status:"DRAFT"}).select("id,examination_paper_id,examination_candidate_id,student_id,course_registration_id,marks,percentage,grade,remarks,status,entered_by,entered_at").maybeSingle();
    if(saved.error){if(saved.error.code==="23505")return res.status(409).json({success:false,message:"Another officer entered this mark at the same time; refresh the roster."});if(["23503","23514","23502","22P02"].includes(saved.error.code))return res.status(400).json({success:false,message:saved.error.message});throw saved.error;}
    if(!saved.data)return res.status(409).json({success:false,message:"Mark status changed; refresh the roster before trying again."});
    await createAuditLog({actorUserId:actorId,actionCode:prior.data?"EXAM_MARK_DRAFT_UPDATE":"EXAM_MARK_DRAFT_CREATE",moduleCode:"EXAMINATIONS",entityType:"examination_marks",entityId:saved.data.id,oldValues:prior.data??null,newValues:saved.data,ipAddress:req.ip,requestId:req.requestId});
    return res.status(prior.data?200:201).json({success:true,data:saved.data,message:"Draft examination mark saved."});
  }catch(error){next(error);}
});

router.post("/papers", requirePermission(MANAGE), async (req,res,next)=>{try{
  const db=getSupabase(), periodId=String(req.body?.examinationPeriodId??"").trim(), offeringId=String(req.body?.courseOfferingId??"").trim();
  if(!periodId||!offeringId)return res.status(400).json({success:false,message:"Examination Period and Course Offering are required."});
  const [period,offering]=await Promise.all([
    db.from("examination_periods").select("id,examination_type,status").eq("id",periodId).maybeSingle(),
    db.from("course_offerings").select("id,offering_code,course_id,status,courses(course_code,course_name)").eq("id",offeringId).maybeSingle()
  ]);
  if(period.error)throw period.error;if(offering.error)throw offering.error;
  if(!period.data)return res.status(404).json({success:false,message:"Selected Examination Period no longer exists."});
  if(!offering.data)return res.status(404).json({success:false,message:"Selected Course Offering no longer exists."});
  if(["PUBLISHED","COMPLETED","LOCKED","CANCELLED"].includes(period.data.status))return res.status(409).json({success:false,message:`Papers cannot be added while the period is ${period.data.status}.`});
  const requested=String(req.body?.examinationType??period.data.examination_type??"FINAL").toUpperCase();
  const examinationType=requested==="END_OF_SEMESTER"||requested==="MID_SEMESTER"?"FINAL":requested;
  if(!paperTypes.has(examinationType))return res.status(400).json({success:false,message:"Paper type must be FINAL, SUPPLEMENTARY, SPECIAL, RESIT or MAKEUP."});
  const course:any=Array.isArray(offering.data.courses)?offering.data.courses[0]:offering.data.courses;
  const paperCode=String(req.body?.paperCode??`${course?.course_code??offering.data.offering_code}-${examinationType}`).trim().slice(0,80);
  const maximumMarks=Number(req.body?.maximumMarks??100),durationMinutes=Number(req.body?.durationMinutes??180);
  if(!paperCode)return res.status(400).json({success:false,message:"Paper Code is required."});
  if(!(maximumMarks>0)||!(durationMinutes>0))return res.status(400).json({success:false,message:"Maximum Marks and Duration must be greater than zero."});
  const saved=await db.from("examination_papers").insert({examination_period_id:periodId,course_offering_id:offeringId,paper_code:paperCode,paper_title:String(req.body?.paperTitle??course?.course_name??paperCode).trim().slice(0,200),examination_type:examinationType,maximum_marks:maximumMarks,duration_minutes:durationMinutes,instructions:req.body?.instructions?String(req.body.instructions).trim():null,status:"DRAFT",created_by:req.user!.id,updated_by:req.user!.id}).select("*").single();
  if(saved.error){if(saved.error.code==="23505")return res.status(409).json({success:false,message:"This Paper Code already exists in the selected Examination Period."});throw saved.error;}
  return res.status(201).json({success:true,data:saved.data,message:"Examination paper created successfully."});
}catch(error){next(error);}});
router.post("/periods/:id/publish", requirePermission(MANAGE), async (req, res, next) => { try { const db=getSupabase(), id=String(req.params.id), period=await db.from("examination_periods").select("*").eq("id",id).maybeSingle(); if(period.error)throw period.error; if(!period.data)return res.status(404).json({success:false,message:"Examination period not found."}); if(!["DRAFT","PLANNING","APPROVED"].includes(period.data.status))return res.status(409).json({success:false,message:`Cannot publish a period in ${period.data.status} status.`}); const papers=await db.from("examination_papers").select("id").eq("examination_period_id",id); if(papers.error)throw papers.error; if(!(papers.data||[]).length)return res.status(409).json({success:false,message:"Add at least one examination paper before publishing."}); const paperIds=(papers.data||[]).map((p:any)=>p.id), scheduled=await db.from("examination_sessions").select("id").in("examination_paper_id",paperIds).limit(1); if(scheduled.error)throw scheduled.error; if(!(scheduled.data||[]).length)return res.status(409).json({success:false,message:"Schedule at least one examination session before publishing."}); const now=new Date().toISOString(), updated=await db.from("examination_periods").update({status:"PUBLISHED",published_by:req.user!.id,published_at:now,updated_by:req.user!.id,updated_at:now}).eq("id",id).in("status",["DRAFT","PLANNING","APPROVED"]).select("*").maybeSingle(); if(updated.error)throw updated.error; if(!updated.data)return res.status(409).json({success:false,message:"Examination period changed while publishing. Refresh and try again."}); await createAuditLog({actorUserId:req.user!.id,actionCode:"EXAMINATION_PERIOD_PUBLISH",moduleCode:"EXAMINATIONS",entityType:"examination_periods",entityId:id,oldValues:period.data,newValues:updated.data,ipAddress:req.ip,requestId:req.requestId}); res.json({success:true,data:updated.data,message:"Examination timetable published to eligible students."}); }catch(error){next(error);} });
registerCrudResource(router,{moduleCode:"EXAMINATIONS",entityType:"examination_periods",table:"examination_periods",permissionView:VIEW,permissionManage:MANAGE,searchFields:["period_code","period_name","examination_type","status"],filterFields:["academic_year_id","semester_id","examination_type","status"],defaultOrderField:"start_date",setCreatedBy:true,setUpdatedBy:true,validatePayload:async(_payload,current)=>{if(current&&!mutablePeriodStatuses.includes(String(current.status).toUpperCase()))throw workflowConflict(`This period is ${current.status}; update it through its lifecycle workflow.`);},validateDelete:async(current)=>{if(!mutablePeriodStatuses.includes(String(current.status).toUpperCase()))throw workflowConflict(`A ${current.status} examination period cannot be deleted.`);},fields:{academicYearId:"academic_year_id",semesterId:"semester_id",periodCode:"period_code",periodName:"period_name",examinationType:"examination_type",startDate:"start_date",endDate:"end_date",notes:"notes"}},"/periods");
registerCrudResource(router,{moduleCode:"EXAMINATIONS",entityType:"examination_papers",table:"examination_papers",permissionView:VIEW,permissionManage:MANAGE,searchFields:["paper_code","paper_title","examination_type","status"],filterFields:["examination_period_id","course_offering_id","examination_type","status"],defaultOrderField:"created_at",setCreatedBy:true,setUpdatedBy:true,validatePayload:async(_payload,current)=>{if(current){if(String(current.status).toUpperCase()!=="DRAFT")throw workflowConflict(`A ${current.status} examination paper cannot be edited.`);await assertMutablePeriod(getSupabase(),String(current.examination_period_id));}},validateDelete:async(current)=>{if(String(current.status).toUpperCase()!=="DRAFT")throw workflowConflict(`A ${current.status} examination paper cannot be deleted.`);await assertMutablePeriod(getSupabase(),String(current.examination_period_id));},fields:{examinationPeriodId:"examination_period_id",courseOfferingId:"course_offering_id",paperCode:"paper_code",paperTitle:"paper_title",examinationType:"examination_type",maximumMarks:"maximum_marks",durationMinutes:"duration_minutes",instructions:"instructions"}},"/papers");
registerCrudResource(router,{moduleCode:"EXAMINATIONS",entityType:"examination_sessions",table:"examination_sessions",permissionView:VIEW,permissionManage:MANAGE,searchFields:["session_code","status"],filterFields:["examination_paper_id","campus_id","room_id","examination_date","status"],defaultOrderField:"examination_date",setCreatedBy:true,setUpdatedBy:true,validatePayload:async(_payload,current)=>{if(current)await assertMutablePaperPeriod(getSupabase(),String(current.examination_paper_id));},validateDelete:async(current)=>{await assertMutablePaperPeriod(getSupabase(),String(current.examination_paper_id));},fields:{examinationPaperId:"examination_paper_id",campusId:"campus_id",roomId:"room_id",examinationDate:"examination_date",startTime:"start_time",endTime:"end_time",sessionCode:"session_code",capacity:"capacity"}},"/sessions");
registerCrudResource(router,{moduleCode:"EXAMINATIONS",entityType:"examination_candidates",table:"examination_candidates",permissionView:VIEW,permissionManage:MANAGE,searchFields:["candidate_number","eligibility_status","attendance_status","candidate_status"],filterFields:["examination_paper_id","student_id","course_registration_id","eligibility_status","candidate_status"],defaultOrderField:"created_at",allowUpdate:false,allowDelete:false,fields:{examinationPaperId:"examination_paper_id",studentId:"student_id",courseRegistrationId:"course_registration_id",candidateNumber:"candidate_number"}},"/candidates");
registerCrudResource(router,{moduleCode:"EXAMINATIONS",entityType:"examination_candidate_sessions",table:"examination_candidate_sessions",permissionView:VIEW,permissionManage:MANAGE,searchFields:["seat_number","assignment_status","notes"],filterFields:["examination_session_id","examination_candidate_id","assignment_status"],defaultOrderField:"created_at",fields:{examinationSessionId:"examination_session_id",examinationCandidateId:"examination_candidate_id",seatNumber:"seat_number",assignmentStatus:"assignment_status",assignedBy:"assigned_by",assignedAt:"assigned_at",notes:"notes"}},"/candidate-sessions");
registerCrudResource(router,{moduleCode:"EXAMINATIONS",entityType:"examination_attendance",table:"examination_attendance",permissionView:VIEW,permissionManage:MANAGE,searchFields:["attendance_status","seat_number","remarks"],filterFields:["examination_session_id","examination_candidate_id","attendance_status"],defaultOrderField:"marked_at",fields:{examinationSessionId:"examination_session_id",examinationCandidateId:"examination_candidate_id",attendanceStatus:"attendance_status",checkInTime:"check_in_time",seatNumber:"seat_number",identityVerified:"identity_verified",remarks:"remarks",markedBy:"marked_by",markedAt:"marked_at"}},"/attendance");
registerCrudResource(router,{moduleCode:"EXAMINATIONS",entityType:"examination_invigilators",table:"examination_invigilators",permissionView:VIEW,permissionManage:MANAGE,searchFields:["assignment_role","status","notes"],filterFields:["examination_session_id","user_id","assignment_role","status"],defaultOrderField:"created_at",fields:{examinationSessionId:"examination_session_id",userId:"user_id",assignmentRole:"assignment_role",status:"status",assignedBy:"assigned_by",assignedAt:"assigned_at",confirmedAt:"confirmed_at",notes:"notes"}},"/invigilators");
registerCrudResource(router,{moduleCode:"EXAMINATIONS",entityType:"examination_marks",table:"examination_marks",permissionView:VIEW,permissionManage:MARKS,searchFields:["grade","status","remarks"],filterFields:["examination_paper_id","examination_candidate_id","student_id","course_registration_id","status"],defaultOrderField:"created_at",allowCreate:false,allowUpdate:false,allowDelete:false,fields:{examinationPaperId:"examination_paper_id",examinationCandidateId:"examination_candidate_id",studentId:"student_id",courseRegistrationId:"course_registration_id",marks:"marks",percentage:"percentage",grade:"grade",remarks:"remarks",status:"status",enteredBy:"entered_by",enteredAt:"entered_at",submittedBy:"submitted_by",submittedAt:"submitted_at",approvedBy:"approved_by",approvedAt:"approved_at",lockedBy:"locked_by",lockedAt:"locked_at"}},"/marks");
registerCrudResource(router,{moduleCode:"EXAMINATIONS",entityType:"examination_mark_corrections",table:"examination_mark_corrections",permissionView:VIEW,permissionManage:CORRECT,searchFields:["reason","status","review_comment"],filterFields:["examination_mark_id","requested_by","status"],defaultOrderField:"requested_at",fields:{examinationMarkId:"examination_mark_id",requestedBy:"requested_by",requestedAt:"requested_at",oldMarks:"old_marks",newMarks:"new_marks",oldGrade:"old_grade",newGrade:"new_grade",reason:"reason",evidenceFileId:"evidence_file_id",status:"status",reviewedBy:"reviewed_by",reviewedAt:"reviewed_at",reviewComment:"review_comment"}},"/mark-corrections");
export default router;
