import { binaryImport } from "./binary-import.js";
import { createHash, randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { getSupabase } from "../../config/database.js";
import { authenticate } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/rbac.js";
import { createAuditLog } from "../../services/audit.service.js";
import { parseSpreadsheet, type SpreadsheetRow } from "./spreadsheet.js";

type Row = Record<string, any>;
const router = Router();
router.use(authenticate);
const actor = (req: Request) => req.user!.id;
const text = (value: unknown) => String(value ?? "").trim();
const upper = (value: unknown) => text(value).toUpperCase();
const number = (value: unknown) => text(value) === "" ? null : Number(value);
const field = (row: SpreadsheetRow, ...names: string[]) => {
  const wanted = new Set(names.map((name) => name.replace(/[\s_-]/g, "").toLowerCase()));
  const entry = Object.entries(row).find(([name]) => wanted.has(name.replace(/[\s_-]/g, "").toLowerCase()));
  return text(entry?.[1]);
};
const resultTypes = new Set(["NORMAL","SUPPLEMENTARY","SPECIAL","RESIT","RETAKE","REPEAT","CARRY_FORWARD","MAKEUP"]);
const resultStatuses = new Set(["PUBLISHED","LOCKED"]);

async function allRows(table: string, columns: string) {
  const db = getSupabase(); const output: Row[] = []; const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await db.from(table).select(columns).range(from, from + size - 1);
    if (error) throw error; output.push(...(data ?? [])); if ((data?.length ?? 0) < size) break;
  }
  return output;
}

async function references() {
  const db = getSupabase();
  const [institutions, students, years, semesters, courses, curriculumCourses, scales, gradeDetails, attempts] = await Promise.all([
    db.from("institutions").select("id,institution_code").eq("institution_code","IDMS").maybeSingle(),
    allRows("students","id,student_number,programme_id,programme_version_id,curriculum_id,student_status"),
    db.from("academic_years").select("id,year_code,year_name,start_date,status"),
    db.from("semesters").select("id,academic_year_id,semester_code,semester_name,semester_number,start_date,status"),
    allRows("courses","id,course_code,course_name,credit_units,status"),
    allRows("curriculum_courses","id,curriculum_id,course_id,credit_units,year_number,semester_number"),
    db.from("grade_scales").select("id,scale_code").eq("is_default",true).eq("status","ACTIVE").limit(1),
    db.from("grade_scale_details").select("id,grade_scale_id,grade_code,minimum_mark,maximum_mark,grade_point,pass_status,status").eq("status","ACTIVE"),
    allRows("student_course_attempts","id,student_id,academic_year_id,semester_id,course_id,attempt_number,attempt_status"),
  ]);
  for (const item of [institutions, years, semesters, scales, gradeDetails]) if (item.error) throw item.error;
  if (!institutions.data) throw new Error("Official IDMS institution was not found.");
  const scale = scales.data?.[0]; if (!scale) throw new Error("No active default grading scale is configured.");
  return { institution: institutions.data, students, years: years.data ?? [], semesters: semesters.data ?? [], courses, curriculumCourses, grades: (gradeDetails.data ?? []).filter((g:Row)=>g.grade_scale_id===scale.id), attempts };
}

async function validateRows(input: SpreadsheetRow[]) {
  if (!Array.isArray(input) || !input.length) throw new Error("The academic import contains no rows.");
  if (input.length > 5000) throw new Error("One academic batch cannot exceed 5,000 rows.");
  const refs = await references(); const seen = new Set<string>();
  const existing = new Set(refs.attempts.map((a:Row)=>[a.student_id,a.academic_year_id,a.semester_id,a.course_id,a.attempt_number].join("|")));
  const rows = input.map((raw,index)=>{
    const errors:string[]=[];
    const studentNumber=upper(field(raw,"studentnumber","regno","registrationnumber"));
    const academicYearCode=field(raw,"academicyear","year");
    const semesterCode=upper(field(raw,"semester","semestercode","semesternumber"));
    const courseCode=upper(field(raw,"coursecode","course"));
    const attemptNumber=Number(field(raw,"attemptnumber","attempt")||"1");
    const resultType=upper(field(raw,"resulttype","attempttype")||"NORMAL");
    const resultStatus=upper(field(raw,"resultstatus","status")||"LOCKED");
    const coursework=number(field(raw,"courseworkmark","coursework","cw"));
    const examination=number(field(raw,"examinationmark","examination","exam"));
    const suppliedTotal=number(field(raw,"totalmark","total"));
    const total=suppliedTotal ?? ((coursework ?? 0)+(examination ?? 0));
    const student=refs.students.find((x:Row)=>upper(x.student_number)===studentNumber);
    const year=refs.years.find((x:Row)=>text(x.year_code)===academicYearCode);
    const semester=refs.semesters.find((x:Row)=>x.academic_year_id===year?.id && (upper(x.semester_code)===semesterCode || String(x.semester_number)===semesterCode));
    const course=refs.courses.find((x:Row)=>upper(x.course_code)===courseCode);
    const curriculumCourse=refs.curriculumCourses.find((x:Row)=>x.curriculum_id===student?.curriculum_id && x.course_id===course?.id);
    const credits=number(field(raw,"credits","creditunits")) ?? number(curriculumCourse?.credit_units) ?? number(course?.credit_units);
    const grade=refs.grades.find((x:Row)=>total>=Number(x.minimum_mark)&&total<=Number(x.maximum_mark));
    const suppliedGrade=upper(field(raw,"grade","gradecode"));
    if(!studentNumber)errors.push("STUDENT_NUMBER_REQUIRED"); if(!student)errors.push("UNKNOWN_STUDENT_NUMBER");
    if(student&&!student.programme_version_id)errors.push("STUDENT_PROGRAMME_VERSION_MISSING"); if(student&&!student.curriculum_id)errors.push("STUDENT_CURRICULUM_MISSING");
    if(!year)errors.push("UNKNOWN_ACADEMIC_YEAR"); if(!semester)errors.push("UNKNOWN_SEMESTER"); if(!course)errors.push("UNKNOWN_COURSE_CODE");
    if(student&&course&&!curriculumCourse)errors.push("COURSE_NOT_IN_STUDENT_CURRICULUM");
    if(!Number.isInteger(attemptNumber)||attemptNumber<1)errors.push("INVALID_ATTEMPT_NUMBER");
    if(!resultTypes.has(resultType))errors.push("INVALID_RESULT_TYPE"); if(!resultStatuses.has(resultStatus))errors.push("RESULT_MUST_BE_PUBLISHED_OR_LOCKED");
    for(const [label,value] of [["COURSEWORK",coursework],["EXAMINATION",examination],["TOTAL",total]] as const) if(value!==null&&(!Number.isFinite(value)||value<0||value>100))errors.push(`${label}_MARK_OUT_OF_RANGE`);
    if(coursework!==null&&examination!==null&&suppliedTotal!==null&&Math.abs(coursework+examination-suppliedTotal)>0.01)errors.push("TOTAL_DOES_NOT_EQUAL_COMPONENTS");
    if(!credits||credits<=0)errors.push("INVALID_CREDITS"); if(!grade)errors.push("GRADE_SCALE_RANGE_MISSING");
    if(suppliedGrade&&grade&&suppliedGrade!==upper(grade.grade_code))errors.push("GRADE_DOES_NOT_MATCH_TOTAL");
    const duplicateKey=[student?.id,year?.id,semester?.id,course?.id,attemptNumber].join("|");
    let validationStatus="VALID"; if(student&&year&&semester&&course&&(existing.has(duplicateKey)||seen.has(duplicateKey))){errors.push("DUPLICATE_COURSE_ATTEMPT");validationStatus="DUPLICATE";} seen.add(duplicateKey);
    if(errors.length&&validationStatus!=="DUPLICATE")validationStatus="INVALID";
    return {rowNumber:index+2,raw,validationStatus,errors,normalized:{institution_id:refs.institution.id,student_id:student?.id??null,student_number:studentNumber,programme_version_id:student?.programme_version_id??null,curriculum_id:student?.curriculum_id??null,academic_year_id:year?.id??null,academic_year_code:academicYearCode,semester_id:semester?.id??null,semester_code:semesterCode,course_id:course?.id??null,course_code:courseCode,course_name:course?.course_name??null,attempt_number:attemptNumber,attempt_date:field(raw,"attemptdate","date")||null,coursework_mark:coursework,examination_mark:examination,total_mark:total,grade_code:grade?.grade_code??null,grade_point:grade?Number(grade.grade_point):null,pass_status:grade?.pass_status??null,credits,result_type:resultType,attempt_status:resultStatus,remarks:field(raw,"remarks","notes")||null}};
  });
  return {rows,summary:{total:rows.length,valid:rows.filter(x=>x.validationStatus==="VALID").length,invalid:rows.filter(x=>x.validationStatus==="INVALID").length,duplicates:rows.filter(x=>x.validationStatus==="DUPLICATE").length}};
}

async function recalculateStudent(studentId:string) {
  const db=getSupabase(); const [attempts,years,semesters,student,previousHistoricalSummaries]=await Promise.all([
    db.from("student_course_attempts").select("*").eq("student_id",studentId).in("attempt_status",["PUBLISHED","LOCKED"]),
    db.from("academic_years").select("id,start_date"), db.from("semesters").select("id,academic_year_id,semester_number,start_date"),
    db.from("students").select("programme_version_id").eq("id",studentId).single(),
    db.from("student_semester_results").select("academic_year_id,semester_id").eq("student_id",studentId).eq("remarks","Centralized calculation from historical course attempts"),
  ]); for(const x of [attempts,years,semesters,student,previousHistoricalSummaries])if(x.error)throw x.error;
  const periods=new Map<string,Row[]>(); for(const a of attempts.data??[]){const k=`${a.academic_year_id}|${a.semester_id}`;periods.set(k,[...(periods.get(k)??[]),a]);}
  for(const previous of previousHistoricalSummaries.data??[]){const k=`${previous.academic_year_id}|${previous.semester_id}`;if(!periods.has(k))periods.set(k,[]);}
  const ordered=[...periods.entries()].sort(([a],[b])=>{const [ay,as]=a.split("|");const [by,bs]=b.split("|");const ad=String(years.data?.find((x:Row)=>x.id===ay)?.start_date??"")+String(semesters.data?.find((x:Row)=>x.id===as)?.semester_number??0).padStart(2,"0");const bd=String(years.data?.find((x:Row)=>x.id===by)?.start_date??"")+String(semesters.data?.find((x:Row)=>x.id===bs)?.semester_number??0).padStart(2,"0");return ad.localeCompare(bd);});
  let cumulativeCredits=0,cumulativeEarned=0,cumulativePoints=0;
  for(const [period,list] of ordered){const [yearId,semesterId]=period.split("|") as [string,string];const credits=list.reduce((s,x)=>s+Number(x.credits||0),0);const earned=list.filter(x=>x.pass_status==="PASS").reduce((s,x)=>s+Number(x.credits||0),0);const points=list.reduce((s,x)=>s+Number(x.grade_point||0)*Number(x.credits||0),0);const gpa=credits?Number((points/credits).toFixed(3)):0;cumulativeCredits+=credits;cumulativeEarned+=earned;cumulativePoints+=points;const cgpa=cumulativeCredits?Number((cumulativePoints/cumulativeCredits).toFixed(3)):0;const standing=cgpa>=2?"GOOD":cgpa>=1.5?"PROBATION":"ACADEMIC_REVIEW";
    const {data:semesterResult,error:semesterError}=await db.from("student_semester_results").upsert({student_id:studentId,academic_year_id:yearId,semester_id:semesterId,programme_version_id:student.data?.programme_version_id??null,total_registered_credits:credits,total_attempted_credits:credits,total_earned_credits:earned,total_quality_points:points,gpa,courses_attempted:list.length,courses_passed:list.filter(x=>x.pass_status==="PASS").length,courses_failed:list.filter(x=>x.pass_status==="FAIL").length,academic_standing:list.length?standing:"NO_ACTIVE_ATTEMPTS",result_status:list.length?"LOCKED":"WITHHELD",calculated_at:new Date().toISOString(),remarks:"Centralized calculation from historical course attempts"},{onConflict:"student_id,academic_year_id,semester_id"}).select("id").single();if(semesterError)throw semesterError;
    const {error:gpaError}=await db.from("student_gpa_records").upsert({student_id:studentId,academic_year_id:yearId,semester_id:semesterId,semester_result_id:semesterResult.id,gpa,total_credits:credits,total_quality_points:points,calculation_version:"HISTORICAL-1.0",calculated_at:new Date().toISOString()},{onConflict:"student_id,academic_year_id,semester_id"});if(gpaError)throw gpaError;
    const {error:cgpaError}=await db.from("student_cgpa_records").upsert({student_id:studentId,academic_year_id:yearId,semester_id:semesterId,cumulative_credits:cumulativeCredits,cumulative_earned_credits:cumulativeEarned,cumulative_quality_points:cumulativePoints,cgpa,calculation_version:"HISTORICAL-1.0",calculated_at:new Date().toISOString()},{onConflict:"student_id,academic_year_id,semester_id"});if(cgpaError)throw cgpaError;
  }
  return {periods:ordered.length};
}

async function createBatch(req: Request, fileName: string, format: string, fileBase64: string | null, rows: SpreadsheetRow[]) {
  const validation = await validateRows(rows);
  if (!validation.rows.length) throw new Error("The academic import file contains no data rows.");
  const batchNumber = `ACAD-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 6).toUpperCase()}`;
  const { data: batch, error } = await getSupabase().rpc("create_historical_academic_import_batch", {
    p_batch_payload: {
      batch_number: batchNumber,
      institution_id: validation.rows[0]!.normalized.institution_id,
      source_format: format,
      source_file_name: fileName,
      source_file_sha256: fileBase64 ? createHash("sha256").update(fileBase64).digest("hex") : null,
      total_rows: validation.summary.total,
      valid_rows: validation.summary.valid,
      invalid_rows: validation.summary.invalid,
      duplicate_rows: validation.summary.duplicates,
    },
    p_rows: validation.rows,
    p_actor_id: actor(req),
    p_request_id: req.requestId ?? null,
    p_ip_address: req.ip ?? null,
  });
  if (error) throw error;
  if (!batch) throw new Error("Unable to save the academic import batch.");
  return { batch, ...validation };
}

async function confirmBatch(req: Request, batchId: string) {
  const db = getSupabase();
  const currentActor = actor(req);
  const { data: started, error: startError } = await db.rpc("start_or_resume_historical_academic_import", {
    p_batch_id: batchId,
    p_actor_id: currentActor,
    p_request_id: req.requestId ?? null,
    p_ip_address: req.ip ?? null,
  });
  if (startError) throw startError;
  if (!started) throw new Error("Academic import could not be started or resumed.");
  if (["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(started.status)) {
    return { batch: started, completed: true, processedThisRequest: 0 };
  }

  const { data: rows, error: rowsError } = await db.from("historical_academic_import_rows")
    .select("id")
    .eq("batch_id", batchId)
    .eq("validation_status", "VALID")
    .order("row_number")
    .limit(50);
  if (rowsError) throw rowsError;

  let processedThisRequest = 0;
  for (const row of rows ?? []) {
    const { error } = await db.rpc("import_historical_academic_attempt", {
      p_batch_id: batchId,
      p_row_id: row.id,
      p_actor_id: currentActor,
    });
    if (error) {
      const { error: saveError } = await db.rpc("skip_historical_academic_import_row", {
        p_batch_id: batchId,
        p_row_id: row.id,
        p_actor_id: currentActor,
        p_failure: error.message || "IMPORT_FAILED",
      });
      if (saveError) throw saveError;
    }
    processedThisRequest += 1;
  }

  const { data: remainingRows, error: remainingError, count: pending } = await db.from("historical_academic_import_rows")
    .select("id", { count: "exact" })
    .eq("batch_id", batchId)
    .eq("validation_status", "VALID")
    .limit(1);
  if (remainingError) throw remainingError;
  if (remainingRows?.length || Number(pending ?? 0) > 0) {
    const { data: progressBatch, error: progressError } = await db.from("historical_academic_import_batches")
      .select("*").eq("id", batchId).single();
    if (progressError) throw progressError;
    return { batch: progressBatch, completed: false, processedThisRequest };
  }

  const { data: importedRows, error: importedError } = await db.from("historical_academic_import_rows")
    .select("course_attempt_id")
    .eq("batch_id", batchId)
    .eq("validation_status", "IMPORTED");
  if (importedError) throw importedError;
  const attemptIds = (importedRows ?? []).map((row: Row) => row.course_attempt_id).filter(Boolean);
  if (attemptIds.length) {
    const { data: attempts, error: attemptsError } = await db.from("student_course_attempts")
      .select("student_id").in("id", attemptIds);
    if (attemptsError) throw attemptsError;
    for (const studentId of new Set((attempts ?? []).map((row: Row) => row.student_id).filter(Boolean))) {
      await recalculateStudent(studentId);
    }
  }

  const { data: completedBatch, error: finishError } = await db.rpc("finish_historical_academic_import", {
    p_batch_id: batchId,
    p_actor_id: currentActor,
    p_request_id: req.requestId ?? null,
    p_ip_address: req.ip ?? null,
  });
  if (finishError) throw finishError;
  return { batch: completedBatch, completed: true, processedThisRequest };
}

async function planningContext(query: Record<string, unknown>) {
  const cohortYear = Number(query.cohortYear);
  const programmeVersionId = text(query.programmeVersionId);
  const academicYearId = text(query.academicYearId);
  const semesterId = text(query.semesterId);
  if (!Number.isInteger(cohortYear) || cohortYear < 2023 || cohortYear > 2026) throw new Error("Select a valid cohort from 2023 to 2026.");
  if (!programmeVersionId || !academicYearId || !semesterId) throw new Error("Programme version, academic year and semester are required.");
  const db = getSupabase();
  const [version, year, semester, curriculum, students] = await Promise.all([
    db.from("programme_versions").select("id,programme_id,version_code,version_name,programmes(programme_code,programme_name)").eq("id", programmeVersionId).maybeSingle(),
    db.from("academic_years").select("id,year_code,year_name").eq("id", academicYearId).maybeSingle(),
    db.from("semesters").select("id,academic_year_id,semester_code,semester_name,semester_number").eq("id", semesterId).maybeSingle(),
    db.from("curricula").select("id,curriculum_code,curriculum_name,status").eq("programme_version_id", programmeVersionId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("students").select("id,student_number,registration_number,first_name,middle_name,last_name,student_status,user_id").eq("admission_year", cohortYear).eq("programme_version_id", programmeVersionId).is("archived_at", null).order("student_number").limit(5000),
  ]);
  for (const item of [version, year, semester, curriculum, students]) if (item.error) throw item.error;
  if (!version.data) throw new Error("Programme version was not found.");
  if (!year.data || !semester.data || semester.data.academic_year_id !== year.data.id) throw new Error("Academic year and semester do not match.");
  if (!curriculum.data) throw new Error("The selected programme version has no curriculum.");
  const yearOfStudy = Number(String(year.data.year_code).split("/")[0]) - cohortYear + 1;
  if (yearOfStudy < 1) throw new Error("Academic year is before the selected cohort.");
  const { data: curriculumCourses, error: courseError } = await db.from("curriculum_courses")
    .select("id,course_id,credit_units,year_number,semester_number,is_compulsory,course_category,courses(id,course_code,course_name,credit_units,status)")
    .eq("curriculum_id", curriculum.data.id).eq("semester_number", semester.data.semester_number)
    .or(`year_number.eq.${yearOfStudy},year_number.is.null`).order("course_id");
  if (courseError) throw courseError;
  return { cohortYear, programmeVersion: version.data, academicYear: year.data, semester: semester.data, curriculum: curriculum.data, yearOfStudy, students: students.data ?? [], courses: curriculumCourses ?? [] };
}

router.get("/planning/reference-data",requirePermission("historical_academics.view"),async(_req,res,next)=>{try{const db=getSupabase();const [cohorts,programmes,versions,years,semesters]=await Promise.all([db.from("student_cohorts").select("id,cohort_code,cohort_name,entry_year,status").order("entry_year"),db.from("programmes").select("id,programme_code,programme_name,status").order("programme_code"),db.from("programme_versions").select("id,programme_id,version_code,version_name,status,effective_from,effective_to").order("version_code"),db.from("academic_years").select("id,year_code,year_name,status,start_date,end_date").order("start_date"),db.from("semesters").select("id,academic_year_id,semester_code,semester_name,semester_number,status,start_date,end_date").order("semester_number")]);for(const x of [cohorts,programmes,versions,years,semesters])if(x.error)throw x.error;res.json({success:true,data:{cohorts:cohorts.data??[],programmes:programmes.data??[],programmeVersions:versions.data??[],academicYears:years.data??[],semesters:semesters.data??[]}});}catch(e){next(e);}});
router.get("/planning/plan",requirePermission("historical_academics.view"),async(req,res,next)=>{try{const plan=await planningContext(req.query as Record<string,unknown>);res.json({success:true,data:{...plan,studentCount:plan.students.length,students:plan.students.slice(0,100)}});}catch(e){next(e);}});
router.post("/planning/provision",requirePermission("historical_academics.import"),async(req,res,next)=>{try{const plan=await planningContext(req.body??{});const {data,error}=await getSupabase().rpc("provision_historical_semester",{p_cohort_year:plan.cohortYear,p_programme_version_id:plan.programmeVersion.id,p_academic_year_id:plan.academicYear.id,p_semester_id:plan.semester.id,p_actor:actor(req)});if(error)throw error;await createAuditLog({actorUserId:actor(req),actionCode:"HISTORICAL_SEMESTER_PROVISION",moduleCode:"historical_academics",entityType:"student_registration",newValues:data,requestId:req.requestId,ipAddress:req.ip});res.json({success:true,data});}catch(e){next(e);}});
router.get("/planning/roster",requirePermission("historical_academics.view"),async(req,res,next)=>{try{const plan=await planningContext(req.query as Record<string,unknown>);const courseId=text(req.query.courseId);const mapped=plan.courses.find((x:Row)=>x.course_id===courseId);if(!mapped)throw new Error("Select a course mapped to this cohort semester curriculum.");const course=Array.isArray(mapped.courses)?mapped.courses[0]:mapped.courses;const rows=plan.students.map((s:Row)=>({studentNumber:s.student_number,registrationNumber:s.registration_number||"",studentName:[s.first_name,s.middle_name,s.last_name].filter(Boolean).join(" "),academicYear:plan.academicYear.year_code,semester:plan.semester.semester_code,courseCode:course?.course_code,courseName:course?.course_name,attemptNumber:1,resultType:"NORMAL",courseworkMark:"",examinationMark:"",totalMark:"",credits:mapped.credit_units??course?.credit_units??"",gradeCode:"",resultStatus:"LOCKED",attemptDate:"",remarks:"Historical official result"}));res.json({success:true,data:{fileName:`IDMC-${plan.cohortYear}-${plan.academicYear.year_code.replace('/','-')}-${plan.semester.semester_code}-${course?.course_code}-Marks.csv`,course,studentCount:rows.length,rows}});}catch(e){next(e);}});

router.get("/template",requirePermission("historical_academics.view"),(_req,res)=>res.json({success:true,data:{columns:["studentNumber","academicYear","semester","courseCode","attemptNumber","resultType","courseworkMark","examinationMark","totalMark","credits","gradeCode","resultStatus","attemptDate","remarks"]}}));
router.post("/validate",requirePermission("historical_academics.validate"), ...binaryImport,async(req,res,next)=>{try{const rows=(req.body?.fileBuffer||req.body?.fileBase64)?parseSpreadsheet(req.body.fileName,req.body.fileBuffer||req.body.fileBase64):req.body?.rows;res.json({success:true,data:await validateRows(rows)});}catch(e){next(e);}});
router.post("/imports",requirePermission("historical_academics.validate"), ...binaryImport,async(req,res,next)=>{try{const fileName=text(req.body?.fileName)||"manual-entry";const rows=(req.body?.fileBuffer||req.body?.fileBase64)?parseSpreadsheet(fileName,req.body.fileBuffer||req.body.fileBase64):req.body?.rows;const format=fileName.toLowerCase().endsWith(".xlsx")?"XLSX":(req.body?.fileBuffer||req.body?.fileBase64)?"CSV":"MANUAL";res.status(201).json({success:true,data:await createBatch(req,fileName,format,req.body?.fileBase64??(Buffer.isBuffer(req.body?.fileBuffer)?req.body.fileBuffer.toString("base64"):null),rows)});}catch(e){next(e);}});
router.get("/imports",requirePermission("historical_academics.view"),async(req,res,next)=>{try{const page=Math.max(1,Number(req.query.page??1)),limit=Math.min(100,Math.max(1,Number(req.query.limit??25))),from=(page-1)*limit;const{data,error,count}=await getSupabase().from("historical_academic_import_batches").select("*",{count:"exact"}).order("created_at",{ascending:false}).range(from,from+limit-1);if(error)throw error;res.json({success:true,data:{rows:data??[],page,limit,total:count??0}});}catch(e){next(e);}});
router.post("/imports/:id/confirm",requirePermission("historical_academics.import"),async(req,res,next)=>{try{res.json({success:true,data:await confirmBatch(req,String(req.params.id))});}catch(e){next(e);}});
router.post("/imports/:id/rollback",requirePermission("historical_academics.rollback"),async(req,res,next)=>{try{const reason=text(req.body?.reason);if(!reason)throw new Error("Rollback reason is required.");const {data,error}=await getSupabase().rpc("rollback_historical_academic_import",{p_batch_id:req.params.id,p_actor_id:actor(req),p_reason:reason,p_request_id:req.requestId??null,p_ip_address:req.ip??null});if(error)throw error;if(!data)throw new Error("Rollback completed without returning the updated batch.");res.json({success:true,data});}catch(e){next(e);}});
router.get("/lifecycle",requirePermission("student_lifecycle.view"),async(req,res,next)=>{try{const q=text(req.query.q);const page=Math.max(1,Number(req.query.page??1)),limit=Math.min(100,Math.max(1,Number(req.query.limit??25))),from=(page-1)*limit;let query=getSupabase().from("student_academic_lifecycle_v").select("*",{count:"exact"}).order("student_number").range(from,from+limit-1);if(q)query=query.or(`student_number.ilike.%${q.replace(/[,()]/g,"")}%,student_name.ilike.%${q.replace(/[,()]/g,"")}%`);const{data,error,count}=await query;if(error)throw error;res.json({success:true,data:{rows:data??[],page,limit,total:count??0}});}catch(e){next(e);}});
router.get("/lifecycle-detail",requirePermission("student_lifecycle.view"),async(req,res,next)=>{try{const studentNumber=upper(req.query.studentNumber);if(!studentNumber)return res.status(400).json({success:false,message:"Student Number is required."});const db=getSupabase();const{data:student,error}=await db.from("students").select("*").eq("student_number",studentNumber).maybeSingle();if(error)throw error;if(!student)return res.status(404).json({success:false,message:"Student Number was not found."});const [programmes,statuses,attempts,semesters,cgpa,graduation,alumni]=await Promise.all([db.from("student_programme_history").select("*,programmes(programme_code,programme_name),programme_versions(version_code,version_name)").eq("student_id",student.id).order("effective_from"),db.from("student_status_history").select("*").eq("student_id",student.id).order("changed_at"),db.from("student_course_attempts").select("*,courses(course_code,course_name),academic_years(year_code,year_name),semesters(semester_code,semester_name,semester_number)").eq("student_id",student.id).neq("attempt_status","CANCELLED").order("recorded_at"),db.from("student_semester_results").select("*,academic_years(year_code,year_name),semesters(semester_code,semester_name,semester_number)").eq("student_id",student.id),db.from("student_cgpa_records").select("*").eq("student_id",student.id).order("calculated_at"),db.from("graduation_candidates").select("*").eq("student_id",student.id),db.from("alumni_records").select("*").eq("student_id",student.id)]);for(const x of [programmes,statuses,attempts,semesters,cgpa,graduation,alumni])if(x.error)throw x.error;res.json({success:true,data:{student,programmeHistory:programmes.data??[],statusHistory:statuses.data??[],courseAttempts:attempts.data??[],semesterResults:semesters.data??[],cgpaHistory:cgpa.data??[],graduation:graduation.data??[],alumni:alumni.data??[]}});}catch(e){next(e);}});

export default router;
