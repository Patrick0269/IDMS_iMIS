import { randomBytes } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { getSupabase } from "../../config/database.js";
import { authenticate } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/rbac.js";
import { createAuditLog } from "../../services/audit.service.js";

type Row = Record<string, any>;
const router = Router();
router.use(authenticate);
const actor = (req: Request) => req.user!.id;
const clearancePermissions: Record<string,string> = {
  ACADEMIC:"graduation.clearance.academic", FINANCE:"graduation.clearance.finance",
  LIBRARY:"graduation.clearance.library", HOSTEL:"graduation.clearance.hostel",
  DEPARTMENT:"graduation.clearance.department", EXAMINATION:"graduation.clearance.examination",
  DOCUMENTS:"graduation.clearance.documents", DISCIPLINE:"graduation.clearance.discipline"
};
const requiredClearances = Object.keys(clearancePermissions);
const requiredApprovals = ["DEPARTMENT","HOD","ACADEMIC","EXAMINATION","REGISTRAR","MANAGEMENT"];

const dynamicClearancePermission = (req:Request,res:Response,next:NextFunction) => {
  const permission=clearancePermissions[String(req.params.type??"").toUpperCase()];
  if(!permission){res.status(400).json({success:false,message:"Unknown clearance office."});return;}
  void requirePermission(permission)(req,res,next);
};

async function queryOrEmpty(table:string,columns:string,configure:(q:any)=>any){
  const query=configure(getSupabase().from(table).select(columns)); const {data,error}=await query;
  if(error){if(String(error.message??"").includes("does not exist"))return [];throw error;} return data??[];
}

async function evaluate(student:Row,candidate:Row,userId:string){
  const db=getSupabase();
  const curriculum = student.curriculum_id ? await queryOrEmpty("curriculum_courses","course_id,credit_units",q=>q.eq("curriculum_id",student.curriculum_id)) : [];
  const attempts = await queryOrEmpty("student_course_attempts","course_id,credits,pass_status,attempt_number,attempt_status,total_mark",q=>q.eq("student_id",student.id).in("attempt_status",["PUBLISHED","LOCKED"]));
  const passedByCourse=new Map<string,Row>();
  for(const a of attempts) if(a.pass_status==="PASS"&&!passedByCourse.has(a.course_id))passedByCourse.set(a.course_id,a);
  const requiredIds=new Set<string>(curriculum.map((x:Row)=>String(x.course_id)));
  const failedIds=new Set(attempts.filter((x:Row)=>x.pass_status==="FAIL"&&!passedByCourse.has(x.course_id)).map((x:Row)=>x.course_id));
  const requiredCredits=curriculum.reduce((s:number,x:Row)=>s+Number(x.credit_units||0),0);
  const earnedCredits=[...passedByCourse.values()].filter(x=>!requiredIds.size||requiredIds.has(x.course_id)).reduce((s,x)=>s+Number(x.credits||0),0);
  const cgpaRows=await queryOrEmpty("student_cgpa_records","cgpa,calculated_at",q=>q.eq("student_id",student.id).order("calculated_at",{ascending:false}).limit(1));
  const invoices=await queryOrEmpty("invoices","balance_amount,status",q=>q.eq("student_id",student.id).not("status","in",'(CANCELLED,VOID)'));
  const members=await queryOrEmpty("library_members","id",q=>q.eq("student_id",student.id));
  const memberIds=members.map((x:Row)=>x.id); const loans=memberIds.length?await queryOrEmpty("library_loans","id,loan_status",q=>q.in("library_member_id",memberIds).in("loan_status",["ACTIVE","OVERDUE","LOST"])):[];
  const hostel=await queryOrEmpty("hostel_allocations","id,allocation_status",q=>q.eq("student_id",student.id).in("allocation_status",["ACTIVE","ALLOCATED","CHECKED_IN"]));
  const documents=await queryOrEmpty("student_documents","id,verification_status",q=>q.eq("student_id",student.id).in("verification_status",["REJECTED","EXPIRED"]));
  const outstandingCourses=Math.max(0,requiredIds.size-[...requiredIds].filter(id=>passedByCourse.has(id)).length);
  const balance=invoices.reduce((s:number,x:Row)=>s+Number(x.balance_amount||0),0);
  const reasons:string[]=[];
  if(!requiredIds.size)reasons.push("CURRICULUM_COURSES_NOT_CONFIGURED");
  if(outstandingCourses)reasons.push(`${outstandingCourses}_OUTSTANDING_COURSES`);
  if(balance>0)reasons.push("OUTSTANDING_FINANCE_BALANCE"); if(loans.length)reasons.push("ACTIVE_LIBRARY_ITEMS");
  if(hostel.length)reasons.push("ACTIVE_HOSTEL_ALLOCATION"); if(documents.length)reasons.push("UNVERIFIED_DOCUMENTS");
  const academicClear=requiredIds.size>0&&outstandingCourses===0;
  const snapshot={graduation_candidate_id:candidate.id,student_id:student.id,required_courses:requiredIds.size,passed_courses:[...requiredIds].filter(id=>passedByCourse.has(id)).length,failed_courses:failedIds.size,outstanding_courses:outstandingCourses,required_credits:requiredCredits,earned_credits:earnedCredits,final_cgpa:cgpaRows[0]?.cgpa??null,outstanding_balance:balance,active_library_items:loans.length,unpaid_library_fines:0,active_hostel_allocations:hostel.length,unverified_documents:documents.length,eligible:academicClear&&balance===0&&!loans.length&&!hostel.length&&!documents.length,reasons,checked_by:userId};
  const {data:check,error:checkError}=await db.from("graduation_eligibility_checks").insert(snapshot).select("*").single();if(checkError)throw checkError;
  const automatic:Record<string,{clear:boolean,remarks:string,amount:number}>={ACADEMIC:{clear:academicClear,remarks:academicClear?"All configured curriculum courses passed.":"Outstanding curriculum requirements.",amount:0},FINANCE:{clear:balance===0,remarks:balance===0?"No outstanding invoice balance.":"Outstanding invoice balance exists.",amount:balance},LIBRARY:{clear:loans.length===0,remarks:loans.length?"Active, overdue or lost library items exist.":"No blocking library loans.",amount:0},HOSTEL:{clear:hostel.length===0,remarks:hostel.length?"Active hostel allocation exists.":"No active hostel allocation.",amount:0},DOCUMENTS:{clear:documents.length===0,remarks:documents.length?"Rejected or expired student documents exist.":"No blocking document issue.",amount:0}};
  for(const [type,value] of Object.entries(automatic))await db.from("graduation_clearances").upsert({graduation_candidate_id:candidate.id,clearance_type:type,status:value.clear?"CLEARED":"NOT_CLEARED",amount_due:value.amount,amount_cleared:value.clear?value.amount:0,remarks:value.remarks,cleared_by:userId,cleared_at:new Date().toISOString()},{onConflict:"graduation_candidate_id,clearance_type"});
  await db.from("graduation_candidates").update({eligibility_status:snapshot.eligible?"ELIGIBLE":academicClear?"REVIEW":"INELIGIBLE",academic_completion_status:academicClear?"COMPLETE":"INCOMPLETE",final_cgpa:snapshot.final_cgpa,eligible_at:snapshot.eligible?new Date().toISOString():null,remarks:reasons.join(", ")||"Eligible for office clearances."}).eq("id",candidate.id);
  return check;
}

router.get("/dashboard",requirePermission("lifecycle_completion.view"),async(_req,res,next)=>{try{const db=getSupabase();const [candidates,checks,alumni,certificates]=await Promise.all([db.from("graduation_candidates").select("id,candidate_status,eligibility_status"),db.from("graduation_eligibility_checks").select("eligible"),db.from("alumni_records").select("id",{count:"exact",head:true}),db.from("certificates").select("id",{count:"exact",head:true})]);for(const x of [candidates,checks,alumni,certificates])if(x.error)throw x.error;res.json({success:true,data:{candidates:candidates.data??[],latestChecks:checks.data??[],alumni:alumni.count??0,certificates:certificates.count??0,workflow:{clearances:requiredClearances,approvals:requiredApprovals}}});}catch(e){next(e);}});

router.get("/candidates",requirePermission("lifecycle_completion.view"),async(req,res,next)=>{try{const db=getSupabase();let q=db.from("graduation_candidates").select("*,students(student_number,first_name,middle_name,last_name,student_status),programmes(programme_code,programme_name),graduation_periods(graduation_number,graduation_name,graduation_date),graduation_clearances(*),graduation_approvals(*)").order("created_at",{ascending:false}).limit(Math.min(Number(req.query.limit)||100,500));if(req.query.status)q=q.eq("candidate_status",String(req.query.status));const {data,error}=await q;if(error)throw error;res.json({success:true,data});}catch(e){next(e);}});

router.post("/students/:studentNumber/evaluate",requirePermission("lifecycle_completion.evaluate"),async(req,res,next)=>{try{const db=getSupabase();const {data:student,error}=await db.from("students").select("*").eq("student_number",String(req.params.studentNumber).toUpperCase()).maybeSingle();if(error)throw error;if(!student){res.status(404).json({success:false,message:"Student Number was not found."});return;}let periodId=String(req.body?.graduationPeriodId??"");if(!periodId){const period=await db.from("graduation_periods").select("id").in("status",["OPEN","APPROVED"]).order("graduation_date",{ascending:true}).limit(1).maybeSingle();if(period.error)throw period.error;periodId=period.data?.id??"";}if(!periodId){res.status(409).json({success:false,message:"Configure an OPEN or APPROVED graduation period first."});return;}const {data:candidate,error:candidateError}=await db.from("graduation_candidates").upsert({graduation_period_id:periodId,student_id:student.id,programme_id:student.programme_id,programme_version_id:student.programme_version_id},{onConflict:"graduation_period_id,student_id",ignoreDuplicates:true}).select("*").maybeSingle();if(candidateError)throw candidateError;const found=candidate??(await db.from("graduation_candidates").select("*").eq("graduation_period_id",periodId).eq("student_id",student.id).single()).data;const check=await evaluate(student,found,actor(req));await createAuditLog({actorUserId:actor(req),actionCode:"GRADUATION_ELIGIBILITY_EVALUATED",moduleCode:"lifecycle_completion",entityType:"graduation_candidate",entityId:found.id,newValues:check,requestId:req.requestId,ipAddress:req.ip});res.json({success:true,message:"Eligibility and automatic office checks completed.",data:check});}catch(e){next(e);}});

router.patch("/candidates/:id/clearances/:type",dynamicClearancePermission,async(req,res,next)=>{try{const db=getSupabase();const type=String(req.params.type).toUpperCase(),status=String(req.body?.status??"").toUpperCase();if(!["CLEARED","NOT_CLEARED","WAIVED"].includes(status)){res.status(400).json({success:false,message:"Status must be CLEARED, NOT_CLEARED or WAIVED."});return;}if(status==="WAIVED"&&!String(req.body?.comments??"").trim()){res.status(400).json({success:false,message:"A waiver requires an official reason."});return;}const current=await db.from("graduation_clearances").select("*").eq("graduation_candidate_id",req.params.id).eq("clearance_type",type).single();if(current.error)throw current.error;const now=new Date().toISOString();const updated=await db.from("graduation_clearances").update({status,remarks:req.body?.comments??null,cleared_by:actor(req),cleared_at:now}).eq("id",current.data.id).select("*").single();if(updated.error)throw updated.error;await db.from("graduation_clearance_history").insert({graduation_clearance_id:current.data.id,previous_status:current.data.status,new_status:status,decision_by:actor(req),comments:req.body?.comments??null});res.json({success:true,message:`${type} clearance recorded.`,data:updated.data});}catch(e){next(e);}});

router.post("/candidates/:id/approvals",requirePermission("lifecycle_completion.manage"),async(req,res,next)=>{try{const db=getSupabase();const stage=String(req.body?.stage??"").toUpperCase(),decision=String(req.body?.decision??"").toUpperCase();if(!requiredApprovals.includes(stage)||!["APPROVED","REJECTED","RETURNED"].includes(decision)){res.status(400).json({success:false,message:"Invalid approval stage or decision."});return;}const existing=await db.from("graduation_approvals").select("approved_by").eq("graduation_candidate_id",req.params.id).eq("approval_stage",stage).maybeSingle();if(existing.error)throw existing.error;if(existing.data?.approved_by===actor(req)){res.status(409).json({success:false,message:"Four-eyes control: another authorized officer must replace an existing decision."});return;}const result=await db.from("graduation_approvals").upsert({graduation_candidate_id:req.params.id,approval_stage:stage,decision,comments:req.body?.comments??null,approved_by:actor(req),approved_at:new Date().toISOString()},{onConflict:"graduation_candidate_id,approval_stage"}).select("*").single();if(result.error)throw result.error;res.json({success:true,message:`${stage} decision recorded.`,data:result.data});}catch(e){next(e);}});

router.post("/candidates/:id/finalize",requirePermission("lifecycle_completion.finalize"),async(req,res,next)=>{
  try {
    const code=randomBytes(12).toString("hex").toUpperCase();
    const alumniSuffix=String(randomBytes(4).readUInt32BE(0)%1000000).padStart(6,"0");
    const notificationNumber="GRAD-"+randomBytes(6).toString("hex").toUpperCase()+"-"+String(req.params.id).slice(0,6);
    const {data,error}=await getSupabase().rpc("finalize_graduation_atomic",{
      p_candidate_id:String(req.params.id),p_actor_id:actor(req),p_verification_code:code,
      p_alumni_suffix:alumniSuffix,p_notification_number:notificationNumber,
      p_ip_address:req.ip??null,p_request_id:req.requestId??null
    });
    if(error)throw error;
    res.json({success:true,message:"Graduation finalized; certificate and alumni record created.",data:{candidateId:data?.candidate?.id,certificateNumber:data?.certificate?.certificate_number,alumniNumber:data?.alumni?.alumni_number}});
  } catch(e) { next(e); }
});

export default router;
