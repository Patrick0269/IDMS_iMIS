import { createOfferingBulk, validateOfferingSelection } from "./offering-bulk.js";
import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/rbac.js";
import { registerCrudResource } from "../../utils/resourceCrud.js";
import { getSupabase } from "../../config/database.js";
import { scopeRoleAssignments } from "../../utils/security.js";
import { createAuditLog } from "../../services/audit.service.js";

import { validateCourse, validateOffering } from "./academic-validation.js";
import academicWorkspaceRoutes from "./academic-workspace.routes.js";

const router = Router();
// Public version marker contains no user data; protected workspace remains authenticated.
router.get("/workspace/version", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ success: true, data: { module: "academic-workspace", patch: "20261006-v3" } });
});
router.use(authenticate);
router.use(academicWorkspaceRoutes);

const VIEW = "academics.view";
const MANAGE = "academics.manage";
const REG_VIEW = "registration.view";
const REG_MANAGE = "registration.manage";
const REG_APPROVE = "registration.approve";
const TT_VIEW = "timetable.view";
const TT_MANAGE = "timetable.manage";
const TT_PUBLISH = "timetable.publish";
const ADMISSION_QUALIFICATION_TYPES = new Set(["PRIMARY", "SECONDARY", "ADVANCED_LEVEL", "CERTIFICATE", "TECHNICIAN_CERTIFICATE", "DIPLOMA", "ADVANCED_DIPLOMA", "BACHELOR", "POSTGRADUATE_DIPLOMA", "MASTERS", "PHD", "PROFESSIONAL", "OTHER"]);

router.post("/cross-cutting/sync-roster", requirePermission(MANAGE), async (req, res, next) => {
  try {
    const courseId = String(req.body?.courseId ?? "").trim();
    const academicYearId = String(req.body?.academicYearId ?? "").trim();
    const semesterId = String(req.body?.semesterId ?? "").trim();
    if (!courseId || !academicYearId || !semesterId) return res.status(400).json({ success: false, message: "Course, academic year and semester are required." });
    const actorId = String(req.user?.id ?? "");
    const db = getSupabase();
    const result = await db.rpc("idmc_sync_cross_cutting_course_roster", {
      p_course_id: courseId, p_academic_year_id: academicYearId, p_semester_id: semesterId, p_actor_id: actorId,
    });
    if (result.error) throw result.error;
    try {
      await createAuditLog({ actorUserId: actorId, actionCode: "CROSS_CUTTING_ROSTER_SYNC", moduleCode: "ACADEMICS", entityType: "course_registrations", entityId: courseId, newValues: result.data });
    } catch (error) { console.warn("Cross-cutting roster audit logging failed", error); }
    res.json({ success: true, data: result.data });
  } catch (error) { next(error); }
});

async function ensureActiveLecturerAssignment(payload: Record<string, unknown>, current?: Record<string, unknown>) {
  const lecturerUserId = String(payload.lecturer_user_id ?? current?.lecturer_user_id ?? "").trim();
  if (!lecturerUserId) throw Object.assign(new Error("Choose a lecturer before assigning a course."), { statusCode: 400 });
  const result = await getSupabase().from("staff").select("id,employment_status").eq("user_id", lecturerUserId).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data || String(result.data.employment_status ?? "").toUpperCase() !== "ACTIVE") {
    throw Object.assign(new Error("This lecturer has no active staff record and cannot receive course assignments."), { statusCode: 409 });
  }
}

async function getHodAssignmentScope(req: import("express").Request) {
  const db = getSupabase(), actorId = String(req.user?.id ?? "");
  const [roleResult, staffResult] = await Promise.all([
    db.from("user_roles").select("role_id,assigned_at,status,expires_at,roles!inner(role_code,status)").eq("user_id", actorId).eq("status", "ACTIVE"),
    db.from("staff").select("department_id,employment_status").eq("user_id", actorId).maybeSingle(),
  ]);
  if (roleResult.error) throw roleResult.error;
  if (staffResult.error) throw staffResult.error;
  const now = Date.now();
  const scopedRoles = scopeRoleAssignments(roleResult.data, req.user?.activeRoleId);
  if (scopedRoles[0]?.role_id) req.user!.activeRoleId = scopedRoles[0].role_id;
  const codes = scopedRoles.filter((row: any) => row.roles?.status === "ACTIVE" && (!row.expires_at || new Date(row.expires_at).getTime() > now)).map((row: any) => String(row.roles.role_code).toUpperCase());
  const isAdmin = codes.some((code: string) => ["ADMIN", "SUPER_ADMIN", "SYSTEM_ADMIN"].includes(code));
  const staff = staffResult.data;
  if (!isAdmin && (!staff || String(staff.employment_status).toUpperCase() !== "ACTIVE" || !staff.department_id)) throw Object.assign(new Error("Link the HOD account to an active staff record and department first."), { statusCode: 403 });
  return { actorId, departmentId: isAdmin ? null : String(staff!.department_id), isAdmin };
}

router.get("/hod/course-allocation", requirePermission("lecturer.assignments.manage"), async (req, res, next) => {
  try {
    const db = getSupabase(), scope = await getHodAssignmentScope(req);
    let staffQuery = db.from("staff").select("id,user_id,employee_number,first_name,middle_name,last_name,job_title,department_id,employment_status").eq("employment_status", "ACTIVE").order("last_name");
    let coursesQuery = db.from("courses").select("id,course_code,course_name,department_id,credit_units,status").eq("status", "ACTIVE").order("course_code");
    if (scope.departmentId) { staffQuery = staffQuery.eq("department_id", scope.departmentId); coursesQuery = coursesQuery.eq("department_id", scope.departmentId); }
    const [staff, courses] = await Promise.all([staffQuery, coursesQuery]);
    if (staff.error) throw staff.error;
    if (courses.error) throw courses.error;
    const courseIds = (courses.data ?? []).map((row: any) => row.id);
    const offerings = courseIds.length ? await db.from("course_offerings").select("id,course_id,academic_year_id,semester_id,offering_code,section_name,status").in("course_id", courseIds).in("status", ["DRAFT", "OPEN", "CLOSED"]).order("created_at", { ascending: false }).limit(1000) : { data: [], error: null };
    if (offerings.error) throw offerings.error;
    const offeringIds = (offerings.data ?? []).map((row: any) => row.id);
    const assignments = offeringIds.length ? await db.from("lecturer_assignments").select("id,course_offering_id,lecturer_user_id,assignment_role,workload_hours,assignment_status,notes,assigned_at").in("course_offering_id", offeringIds).order("assigned_at", { ascending: false }).limit(2000) : { data: [], error: null };
    if (assignments.error) throw assignments.error;
    const users = (staff.data ?? []).length ? await db.from("users").select("id,display_name,email").in("id", (staff.data ?? []).map((row: any) => row.user_id).filter(Boolean)) : { data: [], error: null };
    if (users.error) throw users.error;
    const [years, semesters] = await Promise.all([db.from("academic_years").select("id,year_code,year_name"), db.from("semesters").select("id,semester_code,semester_name")]);
    if (years.error) throw years.error;
    if (semesters.error) throw semesters.error;
    res.json({ success: true, data: { departmentId: scope.departmentId, staff: staff.data ?? [], users: users.data ?? [], courses: courses.data ?? [], offerings: offerings.data ?? [], assignments: assignments.data ?? [], years: years.data ?? [], semesters: semesters.data ?? [] } });
  } catch (error) { next(error); }
});

router.post("/hod/course-allocation", requirePermission("lecturer.assignments.manage"), async (req, res, next) => {
  try {
    const db = getSupabase(), scope = await getHodAssignmentScope(req);
    const offeringId = String(req.body?.courseOfferingId ?? "").trim(), lecturerUserId = String(req.body?.lecturerUserId ?? "").trim();
    if (!offeringId || !lecturerUserId) return res.status(400).json({ success: false, message: "Choose a course offering and lecturer." });
    const [staff, offering] = await Promise.all([
      db.from("staff").select("id,user_id,department_id,employment_status").eq("user_id", lecturerUserId).maybeSingle(),
      db.from("course_offerings").select("id,course_id,status").eq("id", offeringId).maybeSingle(),
    ]);
    if (staff.error) throw staff.error;
    if (offering.error) throw offering.error;
    if (!staff.data || String(staff.data.employment_status).toUpperCase() !== "ACTIVE") return res.status(409).json({ success: false, message: "This lecturer has no active staff record." });
    if (!offering.data) return res.status(404).json({ success: false, message: "Course offering not found." });
    if (!["DRAFT", "OPEN", "CLOSED"].includes(String(offering.data.status).toUpperCase())) return res.status(409).json({ success: false, message: "This course offering is suspended, cancelled, or completed and cannot receive a new lecturer assignment." });
    const course = await db.from("courses").select("id,department_id").eq("id", offering.data.course_id).maybeSingle();
    if (course.error) throw course.error;
    if (!course.data || (!scope.isAdmin && (String(staff.data.department_id) !== scope.departmentId || String(course.data.department_id) !== scope.departmentId))) return res.status(403).json({ success: false, message: "HODs can assign only active lecturers and courses in their department." });
    const workload = Number(req.body?.workloadHours ?? 0);
    if (!Number.isFinite(workload) || workload < 0) return res.status(400).json({ success: false, message: "Workload hours cannot be negative." });
    const saved = await db.from("lecturer_assignments").insert({ course_offering_id: offeringId, lecturer_user_id: lecturerUserId, class_id: req.body?.classId || null, assignment_role: req.body?.assignmentRole || "LECTURER", workload_hours: workload, assignment_status: "ACTIVE", assigned_by: scope.actorId, notes: req.body?.notes ? String(req.body.notes).slice(0, 2000) : null }).select("*").single();
    if (saved.error) throw saved.error;
    try { await createAuditLog({ actorUserId: scope.actorId, actionCode: "LECTURER_COURSE_ASSIGNED", moduleCode: "ACADEMICS", entityType: "lecturer_assignments", entityId: saved.data.id, newValues: saved.data }); } catch (error) { console.warn("Course assignment audit logging failed", error); }
    res.status(201).json({ success: true, data: saved.data, message: "Lecturer assigned to course offering." });
  } catch (error) { next(error); }
});

// Shared, read-only labels used by authorised module forms. Authentication is
// still required by the router; this avoids forcing an Examination Officer to
// also hold the broader academics.view permission just to select a semester.
router.get("/reference-data", async (req, res, next) => {
  try {
    const resource = String(req.query.resource || "all");
    const tables: Record<string, string> = { years:"academic_years", semesters:"semesters", programmes:"programmes", courses:"courses", offerings:"course_offerings", campuses:"campuses", students:"students" };
    if (resource !== "all" && !tables[resource]) return res.status(400).json({ success:false, message:"Unsupported reference-data resource." });
    const db=getSupabase();
    if(resource !== "all") { const table=tables[resource]; if(!table)return res.status(400).json({success:false,message:"Unsupported reference-data resource."}); const result=await db.from(table).select("*").limit(2000); if(result.error)throw result.error; return res.json({success:true,data:result.data??[]}); }
    const entries=await Promise.all(Object.entries(tables).map(async ([key,table])=>{const result=await db.from(table).select("*").limit(2000);if(result.error)throw result.error;return [key,result.data??[]] as const;}));
    res.json({success:true,data:Object.fromEntries(entries)});
  } catch(error){ next(error); }
});

router.get("/admission-eligibility", requirePermission(VIEW), async (_req, res, next) => {
  try {
    const result = await getSupabase().from("idmc_programme_admission_rules")
      .select("id,programme_id,intake_id,accepted_qualification_types,minimum_qualification_level,require_verified_qualification,approved_by,reason,updated_at")
      .is("intake_id", null).order("updated_at", { ascending: false });
    if (result.error) throw result.error;
    res.json({ success: true, data: result.data ?? [] });
  } catch (error) { next(error); }
});

router.put("/programmes/:id/admission-eligibility", requirePermission(MANAGE), async (req, res, next) => {
  try {
    const programmeId = String(req.params.id ?? "").trim(), actorId = String(req.user?.id ?? "");
    const types = req.body?.acceptedQualificationTypes;
    const levelValue = req.body?.minimumQualificationLevel;
    const minimumLevel = levelValue == null || levelValue === "" ? null : Number(levelValue);
    const requireVerified = req.body?.requireVerifiedQualification;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 1000) : "";
    if (!/^[0-9a-f-]{36}$/i.test(programmeId)) return res.status(400).json({ success: false, message: "Choose a valid programme." });
    if (!Array.isArray(types) || !types.length || types.some((type: unknown) => typeof type !== "string" || !ADMISSION_QUALIFICATION_TYPES.has(type.toUpperCase()))) return res.status(400).json({ success: false, message: "Select one or more valid qualification types from the approved entry policy." });
    if (minimumLevel != null && (!Number.isInteger(minimumLevel) || minimumLevel < 1 || minimumLevel > 10)) return res.status(400).json({ success: false, message: "Minimum qualification level must be a whole number from 1 to 10, or left empty." });
    if (typeof requireVerified !== "boolean") return res.status(400).json({ success: false, message: "Specify whether the accepted qualification must be verified." });
    if (reason.length < 5) return res.status(400).json({ success: false, message: "Record the institutional approval or reference for this entry rule." });
    const db = getSupabase();
    const programme = await db.from("programmes").select("id").eq("id", programmeId).maybeSingle();
    if (programme.error) throw programme.error;
    if (!programme.data) return res.status(404).json({ success: false, message: "Programme not found." });
    const previous = await db.from("idmc_programme_admission_rules").select("*").eq("programme_id", programmeId).is("intake_id", null).maybeSingle();
    if (previous.error) throw previous.error;
    const payload = { programme_id: programmeId, intake_id: null, accepted_qualification_types: [...new Set((types as string[]).map((type) => type.toUpperCase()))], minimum_qualification_level: minimumLevel, require_verified_qualification: requireVerified, approved_by: actorId, reason, updated_at: new Date().toISOString() };
    const saved = previous.data
      ? await db.from("idmc_programme_admission_rules").update(payload).eq("id", previous.data.id).select("*").single()
      : await db.from("idmc_programme_admission_rules").insert(payload).select("*").single();
    if (saved.error) throw saved.error;
    try { await createAuditLog({ actorUserId: actorId, actionCode: "PROGRAMME_ADMISSION_ELIGIBILITY_UPDATE", moduleCode: "ACADEMICS", entityType: "idmc_programme_admission_rules", entityId: saved.data.id, oldValues: previous.data ?? null, newValues: saved.data }); }
    catch (error) { console.warn("Admission eligibility audit logging failed", error); }
    res.json({ success: true, data: saved.data, message: "Approved programme eligibility rule saved." });
  } catch (error) { next(error); }
});

registerCrudResource(router, { moduleCode:"ACADEMICS", entityType:"academic_years", table:"academic_years", permissionView:VIEW, permissionManage:MANAGE,
  searchFields:["year_code","year_name","status"], filterFields:["status"], defaultOrderField:"start_date",
  fields:{ yearCode:"year_code", yearName:"year_name", startDate:"start_date", endDate:"end_date", status:"status" } }, "/years");

registerCrudResource(router, { moduleCode:"ACADEMICS", entityType:"semesters", table:"semesters", permissionView:VIEW, permissionManage:MANAGE,
  searchFields:["semester_code","semester_name","status"], filterFields:["academic_year_id","semester_number","status"], defaultOrderField:"start_date",
  fields:{ academicYearId:"academic_year_id", semesterCode:"semester_code", semesterName:"semester_name", semesterNumber:"semester_number", startDate:"start_date", endDate:"end_date", status:"status" } }, "/semesters");

// Dedicated editor endpoint keeps admission requirements explicit and avoids
// accidental empty updates from generic programme forms.
router.patch("/programmes/:id/admission-requirements", requirePermission(MANAGE), async (req, res, next) => {
  try {
    const programmeId = String(req.params.id ?? "").trim();
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const payload: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(body, "specialization")) payload.specialization = body.specialization === "" ? null : body.specialization;
    if (Object.prototype.hasOwnProperty.call(body, "directEntryRequirements")) payload.direct_entry_requirements = body.directEntryRequirements === "" ? null : body.directEntryRequirements;
    if (!Object.keys(payload).length) return res.status(400).json({ success:false, message:"Enter a specialization or direct entry requirement before saving." });
    const db = getSupabase();
    const current = await db.from("programmes").select("id,specialization,direct_entry_requirements").eq("id", programmeId).maybeSingle();
    if (current.error) throw current.error;
    if (!current.data) return res.status(404).json({ success:false, message:"Programme not found." });
    const saved = await db.from("programmes").update({ ...payload, updated_at:new Date().toISOString() }).eq("id", programmeId).select("id,specialization,direct_entry_requirements").single();
    if (saved.error) throw saved.error;
    try { await createAuditLog({ actorUserId:req.user?.id ?? null, actionCode:"PROGRAMME_ADMISSION_REQUIREMENTS_UPDATE", moduleCode:"ACADEMICS", entityType:"programmes", entityId:programmeId, oldValues:current.data, newValues:saved.data }); } catch (error) { console.warn("Programme requirement audit logging failed", error); }
    return res.json({ success:true, data:saved.data, message:"Programme entry requirements saved." });
  } catch (error) { next(error); }
});

registerCrudResource(router, { moduleCode:"ACADEMICS", entityType:"programmes", table:"programmes", permissionView:VIEW, permissionManage:MANAGE,
  searchFields:["programme_code","programme_name","programme_type","award_level"], filterFields:["institution_id","school_id","department_id","programme_type","award_level","mode_of_study","status"], defaultOrderField:"created_at",
  fields:{ institutionId:"institution_id", schoolId:"school_id", departmentId:"department_id", programmeCode:"programme_code", programmeName:"programme_name", programmeType:"programme_type", awardLevel:"award_level", durationYears:"duration_years", modeOfStudy:"mode_of_study", description:"description", specialization:"specialization", directEntryRequirements:"direct_entry_requirements", status:"status" } }, "/programmes");

registerCrudResource(router, { moduleCode:"ACADEMICS", entityType:"programme_versions", table:"programme_versions", permissionView:VIEW, permissionManage:MANAGE,
  searchFields:["version_code","version_name","status"], filterFields:["programme_id","status"], defaultOrderField:"effective_from",
  fields:{ programmeId:"programme_id", versionCode:"version_code", versionName:"version_name", effectiveFrom:"effective_from", effectiveTo:"effective_to", totalCredits:"total_credits", status:"status" } }, "/programme-versions");

registerCrudResource(router, { moduleCode:"ACADEMICS", entityType:"courses", table:"courses", permissionView:VIEW, permissionManage:MANAGE, validatePayload:validateCourse,
  searchFields:["course_code","course_name","course_short_name"], filterFields:["institution_id","department_id","course_type","level","status"], defaultOrderField:"course_code",
  fields:{ institutionId:"institution_id", departmentId:"department_id", courseCode:"course_code", courseName:"course_name", courseShortName:"course_short_name", creditUnits:"credit_units", contactHours:"contact_hours", courseType:"course_type", level:"level", crossCutting:"cross_cutting", description:"description", status:"status" } }, "/courses");

registerCrudResource(router, { moduleCode:"ACADEMICS", entityType:"curricula", table:"curricula", permissionView:VIEW, permissionManage:MANAGE,
  searchFields:["curriculum_code","curriculum_name","status"], filterFields:["programme_version_id","status"], defaultOrderField:"effective_from",
  fields:{ programmeVersionId:"programme_version_id", curriculumCode:"curriculum_code", curriculumName:"curriculum_name", effectiveFrom:"effective_from", effectiveTo:"effective_to", totalCredits:"total_credits", status:"status" } }, "/curricula");

// A curriculum/course pair is unique. Saving an existing pair should update
// its class placement and approved credits instead of failing with a duplicate
// key error (which previously appeared to staff as an opaque 500 response).
router.post("/curriculum-courses", requirePermission(MANAGE), async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const curriculumId = String(body.curriculumId ?? body.curriculum_id ?? "").trim();
    const courseId = String(body.courseId ?? body.course_id ?? "").trim();
    const semesterNumber = Number(body.semesterNumber ?? body.semester_number);
    const yearRaw = body.yearNumber ?? body.year_number;
    const yearNumber = yearRaw == null || yearRaw === "" ? null : Number(yearRaw);
    const creditRaw = body.creditUnits ?? body.credit_units;
    const creditUnits = creditRaw == null || creditRaw === "" ? null : Number(creditRaw);
    if (!curriculumId || !courseId) return res.status(400).json({ success:false, message:"Choose both a curriculum and at least one course." });
    if (!Number.isInteger(semesterNumber) || semesterNumber < 1 || (yearNumber !== null && (!Number.isInteger(yearNumber) || yearNumber < 1))) return res.status(400).json({ success:false, message:"Year and semester must be positive whole numbers." });
    if (creditUnits !== null && (!Number.isFinite(creditUnits) || creditUnits < 0)) return res.status(400).json({ success:false, message:"Course credits must be zero or greater." });
    const db = getSupabase();
    const before = await db.from("curriculum_courses").select("id").eq("curriculum_id", curriculumId).eq("course_id", courseId).maybeSingle();
    if (before.error) throw before.error;
    const saved = await db.from("curriculum_courses").upsert({
      curriculum_id: curriculumId, course_id: courseId, year_number: yearNumber,
      semester_number: semesterNumber, course_category: String(body.courseCategory ?? body.course_category ?? "CORE"),
      is_compulsory: typeof (body.isCompulsory ?? body.is_compulsory) === "boolean" ? (body.isCompulsory ?? body.is_compulsory) : String(body.isCompulsory ?? body.is_compulsory ?? "true") === "true",
      credit_units: creditUnits,
    }, { onConflict:"curriculum_id,course_id" }).select("*").single();
    if (saved.error) throw saved.error;
    try { await createAuditLog({ actorUserId:req.user?.id ?? null, actionCode:before.data ? "CURRICULUM_COURSE_UPDATE" : "CURRICULUM_COURSE_CREATE", moduleCode:"ACADEMICS", entityType:"curriculum_courses", entityId:saved.data.id, oldValues:before.data ?? null, newValues:saved.data }); } catch (error) { console.warn("Curriculum course audit logging failed", error); }
    return res.status(before.data ? 200 : 201).json({ success:true, data:saved.data, message:before.data ? "Curriculum course and class credits updated." : "Course added to curriculum." });
  } catch (error) { next(error); }
});

registerCrudResource(router, { moduleCode:"ACADEMICS", entityType:"curriculum_courses", table:"curriculum_courses", permissionView:VIEW, permissionManage:MANAGE,
  searchFields:["course_category"], filterFields:["curriculum_id","course_id","semester_number","year_number","course_category","is_compulsory"], defaultOrderField:"semester_number",
  fields:{ curriculumId:"curriculum_id", courseId:"course_id", semesterNumber:"semester_number", yearNumber:"year_number", courseCategory:"course_category", isCompulsory:"is_compulsory", creditUnits:"credit_units" } }, "/curriculum-courses");

registerCrudResource(router, { moduleCode:"ACADEMICS", entityType:"course_prerequisites", table:"course_prerequisites", permissionView:VIEW, permissionManage:MANAGE,
  searchFields:["minimum_grade"], filterFields:["course_id","prerequisite_course_id"], defaultOrderField:"created_at", fields:{ courseId:"course_id", prerequisiteCourseId:"prerequisite_course_id", minimumGrade:"minimum_grade" } }, "/course-prerequisites");

router.post('/course-offerings/bulk', requirePermission(MANAGE), createOfferingBulk);
router.post('/course-offerings', requirePermission(MANAGE), async(req,_res,next)=>{try{if(req.body?.level!==undefined||req.body?.yearNumber!==undefined)await validateOfferingSelection(req.body);next();}catch(error){next(error);}});
router.patch('/course-offerings/:id', requirePermission(MANAGE), async(req,_res,next)=>{try{if(req.body?.level!==undefined||req.body?.yearNumber!==undefined)await validateOfferingSelection(req.body);next();}catch(error){next(error);}});

registerCrudResource(router, { moduleCode:"ACADEMICS", entityType:"course_offerings", table:"course_offerings", permissionView:VIEW, permissionManage:MANAGE, validatePayload:validateOffering,
  searchFields:["offering_code","section_name","delivery_mode","status"], filterFields:["academic_year_id","semester_id","programme_id","programme_version_id","course_id","status"], defaultOrderField:"created_at",
  fields:{ academicYearId:"academic_year_id", semesterId:"semester_id", programmeId:"programme_id", programmeVersionId:"programme_version_id", courseId:"course_id", offeringCode:"offering_code", sectionName:"section_name", capacity:"capacity", minimumStudents:"minimum_students", deliveryMode:"delivery_mode", status:"status", registrationOpenAt:"registration_open_at", registrationCloseAt:"registration_close_at", createdBy:"created_by", updatedBy:"updated_by" } }, "/course-offerings");

registerCrudResource(router, { moduleCode:"REGISTRATION", entityType:"student_registrations", table:"student_registrations", permissionView:REG_VIEW, permissionManage:REG_MANAGE, allowCreate:false, allowUpdate:false, allowDelete:false,
  searchFields:["registration_number","registration_status","academic_eligibility_status","finance_eligibility_status","document_eligibility_status"], filterFields:["student_id","academic_year_id","semester_id","programme_id","programme_version_id","registration_status"], defaultOrderField:"created_at",
  fields:{ studentId:"student_id", academicYearId:"academic_year_id", semesterId:"semester_id", programmeId:"programme_id", programmeVersionId:"programme_version_id", registrationNumber:"registration_number", registrationStatus:"registration_status", academicEligibilityStatus:"academic_eligibility_status", financeEligibilityStatus:"finance_eligibility_status", documentEligibilityStatus:"document_eligibility_status", totalRegisteredCredits:"total_registered_credits", minimumCredits:"minimum_credits", maximumCredits:"maximum_credits", submittedAt:"submitted_at", approvedAt:"approved_at", approvedBy:"approved_by", lockedAt:"locked_at", lockedBy:"locked_by", rejectionReason:"rejection_reason", notes:"notes", createdBy:"created_by", updatedBy:"updated_by" } }, "/registrations");

registerCrudResource(router, { moduleCode:"REGISTRATION", entityType:"registration_approvals", table:"registration_approvals", permissionView:REG_VIEW, permissionManage:REG_APPROVE, allowCreate:false, allowUpdate:false, allowDelete:false,
  searchFields:["approval_level","approval_role","approval_status","comments"], filterFields:["student_registration_id","approval_level","approval_role","approval_status"], defaultOrderField:"created_at",
  fields:{ studentRegistrationId:"student_registration_id", approvalLevel:"approval_level", approvalRole:"approval_role", approvalStatus:"approval_status", comments:"comments", approvedBy:"approved_by", approvedAt:"approved_at", rejectedAt:"rejected_at" } }, "/registration-approvals");

registerCrudResource(router, { moduleCode:"REGISTRATION", entityType:"course_registrations", table:"course_registrations", permissionView:REG_VIEW, permissionManage:REG_MANAGE,
  searchFields:["registration_type","registration_status","eligibility_status","prerequisite_status"], filterFields:["student_registration_id","student_id","course_id","course_offering_id","registration_type","registration_status"], defaultOrderField:"created_at",
  fields:{ studentRegistrationId:"student_registration_id", studentId:"student_id", courseId:"course_id", courseOfferingId:"course_offering_id", registrationType:"registration_type", registrationStatus:"registration_status", credits:"credits", attemptNumber:"attempt_number", isCore:"is_core", isElective:"is_elective", prerequisiteStatus:"prerequisite_status", eligibilityStatus:"eligibility_status", selectedAt:"selected_at", approvedAt:"approved_at", approvedBy:"approved_by", droppedAt:"dropped_at", dropReason:"drop_reason", notes:"notes", createdBy:"created_by", updatedBy:"updated_by" } }, "/course-registrations");

registerCrudResource(router, { moduleCode:"REGISTRATION", entityType:"course_add_drop_requests", table:"course_add_drop_requests", permissionView:REG_VIEW, permissionManage:REG_MANAGE,
  searchFields:["request_type","request_status","reason","decision_reason"], filterFields:["student_registration_id","student_id","course_id","course_offering_id","request_type","request_status"], defaultOrderField:"created_at",
  fields:{ studentRegistrationId:"student_registration_id", studentId:"student_id", courseId:"course_id", courseOfferingId:"course_offering_id", requestType:"request_type", requestStatus:"request_status", reason:"reason", decisionReason:"decision_reason", requestedBy:"requested_by", reviewedBy:"reviewed_by", requestedAt:"requested_at", reviewedAt:"reviewed_at" } }, "/add-drop-requests");

registerCrudResource(router, { moduleCode:"TIMETABLE", entityType:"timetables", table:"timetables", permissionView:TT_VIEW, permissionManage:TT_MANAGE,
  searchFields:["timetable_code","timetable_name","status"], filterFields:["academic_year_id","semester_id","campus_id","status"], defaultOrderField:"created_at",
  fields:{ academicYearId:"academic_year_id", semesterId:"semester_id", campusId:"campus_id", timetableCode:"timetable_code", timetableName:"timetable_name", status:"status", publishedAt:"published_at", publishedBy:"published_by", lockedAt:"locked_at", lockedBy:"locked_by", createdBy:"created_by", updatedBy:"updated_by" } }, "/timetables");

registerCrudResource(router, { moduleCode:"TIMETABLE", entityType:"timetable_slots", table:"timetable_slots", permissionView:TT_VIEW, permissionManage:TT_MANAGE,
  searchFields:["slot_code","day_of_week","status"], filterFields:["day_of_week","status"], defaultOrderField:"start_time",
  fields:{ slotCode:"slot_code", dayOfWeek:"day_of_week", startTime:"start_time", endTime:"end_time", durationMinutes:"duration_minutes", status:"status" } }, "/timetable-slots");

registerCrudResource(router, { moduleCode:"TIMETABLE", entityType:"timetable_entries", table:"timetable_entries", permissionView:TT_VIEW, permissionManage:TT_MANAGE,
  searchFields:["entry_type","status","notes"], filterFields:["timetable_id","class_id","course_offering_id","lecturer_assignment_id","room_id","timetable_slot_id","entry_date","status"], defaultOrderField:"created_at",
  fields:{ timetableId:"timetable_id", classId:"class_id", courseOfferingId:"course_offering_id", lecturerAssignmentId:"lecturer_assignment_id", roomId:"room_id", timetableSlotId:"timetable_slot_id", entryDate:"entry_date", entryType:"entry_type", status:"status", notes:"notes", createdBy:"created_by", updatedBy:"updated_by" } }, "/timetable-entries");

registerCrudResource(router, { moduleCode:"ACADEMICS", entityType:"classes", table:"classes", permissionView:VIEW, permissionManage:MANAGE,
  searchFields:["class_code","class_name","class_type","status"], filterFields:["course_offering_id","class_type","status"], defaultOrderField:"created_at",
  fields:{ courseOfferingId:"course_offering_id", classCode:"class_code", className:"class_name", classType:"class_type", capacity:"capacity", status:"status", createdBy:"created_by", updatedBy:"updated_by" } }, "/classes");

registerCrudResource(router, { moduleCode:"ACADEMICS", entityType:"lecturer_assignments", table:"lecturer_assignments", permissionView:VIEW, permissionManage:MANAGE,
  searchFields:["assignment_role","assignment_status","notes"], filterFields:["course_offering_id","class_id","lecturer_user_id","assignment_role","assignment_status"], defaultOrderField:"created_at",
  validatePayload: ensureActiveLecturerAssignment,
  fields:{ courseOfferingId:"course_offering_id", classId:"class_id", lecturerUserId:"lecturer_user_id", assignmentRole:"assignment_role", workloadHours:"workload_hours", assignmentStatus:"assignment_status", assignedAt:"assigned_at", assignedBy:"assigned_by", notes:"notes" } }, "/lecturer-assignments");

registerCrudResource(router, { moduleCode:"ACADEMICS", entityType:"class_students", table:"class_students", permissionView:VIEW, permissionManage:MANAGE,
  searchFields:["enrollment_status"], filterFields:["class_id","student_id","course_registration_id","enrollment_status"], defaultOrderField:"created_at",
  fields:{ classId:"class_id", studentId:"student_id", courseRegistrationId:"course_registration_id", enrollmentStatus:"enrollment_status", enrolledAt:"enrolled_at", withdrawnAt:"withdrawn_at" } }, "/class-students");

registerCrudResource(router, { moduleCode:"ACADEMICS", entityType:"joining_instructions", table:"joining_instructions", permissionView:VIEW, permissionManage:MANAGE,
  searchFields:["title","description","status"], filterFields:["academic_year_id","programme_id","status"], defaultOrderField:"created_at",
  fields:{ academicYearId:"academic_year_id", programmeId:"programme_id", title:"title", description:"description", documentUrl:"document_url", versionNumber:"version_number", status:"status", publishedAt:"published_at", publishedBy:"published_by" } }, "/joining-instructions");

export default router;
