import {scope as courseworkScope} from "../assessment/coursework.routes.js";
import { Router, type NextFunction, type Request, type Response } from "express";
import { getSupabase } from "../../config/database.js";
import { authenticate } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/rbac.js";
import { createAuditLog } from "../../services/audit.service.js";
import { scopeRoleAssignments } from "../../utils/security.js";
import { queueRoleWorkflowNotification, queueStudentWorkflowNotification } from "../../services/workflow-notification.service.js";
import { linkStudentPortalAccount } from "../../services/student-portal-link.service.js";
import { logError } from "../../utils/logger.js";

import hodResultsRoutes from "./hod-results.routes.js";

const router = Router();
router.use(authenticate);
router.use(hodResultsRoutes);

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ success: false, message });
}

function actor(req: Request): string | null {
  return req.user?.id ?? null;
}

function requestId(req: Request): string | null {
  return req.requestId ?? null;
}

async function audit(req: Request, actionCode: string, entityType: string, entityId: string, oldValues: unknown, newValues: unknown): Promise<void> {
  try {
    await createAuditLog({
      actorUserId: actor(req),
      actionCode,
      moduleCode: "WORKFLOW",
      entityType,
      entityId,
      oldValues,
      newValues,
      ipAddress: req.ip,
      requestId: requestId(req),
    });
  } catch {
    // The workflow write is already committed; keep its response, but leave a
    // sanitized, searchable signal that the audit event may need reconciliation.
    logError("Workflow audit insert failed after the business write", {
      actionCode,
      moduleCode: "WORKFLOW",
      entityType,
      entityId,
      requestId: requestId(req),
    });
  }
}

function transition(current: string, allowed: string[], next: string, res: Response): boolean {
  if (!allowed.includes(current)) {
    fail(res, 409, `Invalid workflow transition: ${current} -> ${next}`);
    return false;
  }
  return true;
}

async function updateById(
  req: Request,
  res: Response,
  next: NextFunction,
  table: string,
  id: string,
  patch: Record<string, unknown>,
  permission: string,
  actionCode: string,
  entityType: string,
): Promise<void> {
  try {
    const supabase = getSupabase();
    const { data: before, error: readError } = await supabase.from(table).select("*").eq("id", id).maybeSingle();
    if (readError) return next(readError);
    if (!before) return fail(res, 404, `${entityType} not found`);

    const { data, error } = await supabase.from(table).update(patch).eq("id", id).select("*").single();
    if (error) return next(error);

    await audit(req, actionCode, entityType, id, before, data);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

// ---------------- Admissions ----------------
router.post("/applications/:id/submit", requirePermission("admissions.submit"), async (req, res, next) => {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("applications").select("*").eq("id", String(req.params.id)).maybeSingle();
  if (error) return next(error);
  if (!data) return fail(res, 404, "Application not found");
  if (!transition(data.status, ["DRAFT", "CORRECTION_REQUIRED"], "SUBMITTED", res)) return;
  if (data.completion_percentage < 100) return fail(res, 409, "Application is not complete");
  const { data: updated, error: updateError } = await supabase.from("applications").update({ status: "SUBMITTED", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", String(req.params.id)).select("*").single();
  if (updateError) return next(updateError);
  await audit(req, "APPLICATION_SUBMIT", "applications", String(req.params.id), data, updated);
  res.json({ success: true, data: updated });
});

router.post("/applications/:id/review", requirePermission("admissions.review"), async (req, res, next) => {
  return updateById(req, res, next, "applications", String(req.params.id), { status: "UNDER_REVIEW", reviewed_at: new Date().toISOString(), reviewed_by: actor(req) }, "admissions.review", "APPLICATION_REVIEW", "applications");
});

router.post("/applications/:id/verify", requirePermission("admissions.verify"), async (req, res, next) => {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("applications").select("*").eq("id", String(req.params.id)).maybeSingle();
  if (error) return next(error);
  if (!data) return fail(res, 404, "Application not found");
  if (!['UNDER_REVIEW', 'CORRECTION_REQUIRED'].includes(data.status)) return fail(res, 409, `Application cannot be verified from ${data.status}`);
  const { data: updated, error: updateError } = await supabase.from("applications").update({ verification_status: "VERIFIED", status: "VERIFIED", updated_at: new Date().toISOString() }).eq("id", String(req.params.id)).select("*").single();
  if (updateError) return next(updateError);
  await audit(req, "APPLICATION_VERIFY", "applications", String(req.params.id), data, updated);
  res.json({ success: true, data: updated });
});

router.post("/applications/:id/eligibility", requirePermission("admissions.eligibility"), async (req, res, next) => {
  const result = String(req.body?.status ?? "").toUpperCase();
  if (!["ELIGIBLE", "INELIGIBLE", "CONDITIONAL"].includes(result)) return fail(res, 400, "status must be ELIGIBLE, INELIGIBLE or CONDITIONAL");
  const supabase = getSupabase();
  const { data, error } = await supabase.from("applications").select("*").eq("id", String(req.params.id)).maybeSingle();
  if (error) return next(error);
  if (!data) return fail(res, 404, "Application not found");
  const status = result === "ELIGIBLE" ? "ELIGIBLE" : result === "INELIGIBLE" ? "INELIGIBLE" : "ELIGIBLE";
  const { data: updated, error: updateError } = await supabase.from("applications").update({ eligibility_status: result, status, updated_at: new Date().toISOString() }).eq("id", String(req.params.id)).select("*").single();
  if (updateError) return next(updateError);
  await audit(req, "APPLICATION_ELIGIBILITY", "applications", String(req.params.id), data, updated);
  res.json({ success: true, data: updated });
});

router.post("/admission-decisions/:id/decide", requirePermission("admissions.decide"), async (req, res, next) => {
  const decision = String(req.body?.decision ?? "").toUpperCase();
  if (!["APPROVED", "REJECTED", "CANCELLED"].includes(decision)) return fail(res, 400, "decision must be APPROVED, REJECTED or CANCELLED");
  const supabase = getSupabase();
  const { data, error } = await supabase.from("admission_decisions").select("*").eq("id", String(req.params.id)).maybeSingle();
  if (error) return next(error);
  if (!data) return fail(res, 404, "Admission decision not found");
  if (data.decision_status !== "PENDING") return fail(res, 409, `Decision is already ${data.decision_status}`);
  const patch = { decision_status: decision, decision_date: new Date().toISOString(), decision_reason: req.body?.reason ?? null, approved_by: actor(req), approved_at: decision === "APPROVED" ? new Date().toISOString() : null, updated_at: new Date().toISOString() };
  const { data: updated, error: updateError } = await supabase.from("admission_decisions").update(patch).eq("id", String(req.params.id)).select("*").single();
  if (updateError) return next(updateError);
  await audit(req, "ADMISSION_DECISION", "admission_decisions", String(req.params.id), data, updated);
  res.json({ success: true, data: updated });
});

router.post("/admission-offers/:id/issue", requirePermission("admissions.offer"), async (req, res, next) => {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("admission_offers").select("*").eq("id", String(req.params.id)).maybeSingle();
  if (error) return next(error);
  if (!data) return fail(res, 404, "Admission offer not found");
  if (data.offer_status !== "DRAFT") return fail(res, 409, `Offer cannot be issued from ${data.offer_status}`);
  if (data.decision_id) {
    const { data: decision, error: decisionError } = await supabase.from("admission_decisions").select("decision_status").eq("id", data.decision_id).maybeSingle();
    if (decisionError) return next(decisionError);
    if (!decision || decision.decision_status !== "APPROVED") return fail(res, 409, "Offer requires an approved admission decision");
  }
  const offerNumber = String(req.body?.offer_number ?? data.offer_number ?? "").trim();
  if (!offerNumber) return fail(res, 400, "offer_number is required");
  const { data: updated, error: updateError } = await supabase.from("admission_offers").update({ offer_number: offerNumber, offer_status: "ISSUED", issued_by: actor(req), issued_at: new Date().toISOString(), admission_letter_url: req.body?.admission_letter_url ?? data.admission_letter_url ?? null, joining_instructions_url: req.body?.joining_instructions_url ?? data.joining_instructions_url ?? null, updated_at: new Date().toISOString() }).eq("id", String(req.params.id)).select("*").single();
  if (updateError) return next(updateError);
  await audit(req, "ADMISSION_OFFER_ISSUE", "admission_offers", String(req.params.id), data, updated);
  res.json({ success: true, data: updated });
});

router.post("/admission-acceptances/:id/accept", requirePermission("admissions.accept"), async (req, res, next) => {
  try {
    const { data, error } = await getSupabase().rpc("transition_admission_acceptance_atomic", {
      p_acceptance_id: String(req.params.id), p_status: "ACCEPTED", p_actor_id: actor(req),
      p_reason: null, p_ip_address: req.ip ?? null,
      p_user_agent: String(req.headers["user-agent"] ?? "").slice(0, 1000), p_request_id: requestId(req),
    });
    if (error) return next(error);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.post("/admission-acceptances/:id/decline", requirePermission("admissions.accept"), async (req, res, next) => {
  try {
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) return fail(res, 400, "A decline reason is required.");
    const { data, error } = await getSupabase().rpc("transition_admission_acceptance_atomic", {
      p_acceptance_id: String(req.params.id), p_status: "DECLINED", p_actor_id: actor(req),
      p_reason: reason, p_ip_address: req.ip ?? null,
      p_user_agent: String(req.headers["user-agent"] ?? "").slice(0, 1000), p_request_id: requestId(req),
    });
    if (error) return next(error);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

// ---------------- Student activation ----------------
router.post("/students/:id/activate", requirePermission("students.activate"), async (req, res, next) => {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("students").select("*").eq("id", String(req.params.id)).maybeSingle();
  if (error) return next(error);
  if (!data) return fail(res, 404, "Student not found");
  if (data.student_status !== "PENDING_ACTIVATION") return fail(res, 409, `Student cannot be activated from ${data.student_status}`);
  const { data: updated, error: updateError } = await supabase.from("students").update({ student_status: "ACTIVE", enrollment_date: data.enrollment_date ?? new Date().toISOString().slice(0,10), activated_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", String(req.params.id)).select("*").single();
  if (updateError) return next(updateError);
  await audit(req, "STUDENT_ACTIVATE", "students", String(req.params.id), data, updated);
  res.json({ success: true, data: updated });
});

// ---------------- Registration ----------------
router.post("/registrations/:id/submit", requirePermission("registration.submit"), async (req, res, next) => {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("student_registrations").select("*").eq("id", String(req.params.id)).maybeSingle();
  if (error) return next(error);
  if (!data) return fail(res, 404, "Student registration not found");
  if (!transition(data.registration_status, ["DRAFT"], "SUBMITTED", res)) return;
  if (data.academic_eligibility_status !== "ELIGIBLE") return fail(res, 409, "Academic eligibility is not CLEARED/ELIGIBLE");
  if (!["CLEARED", "OVERRIDE"].includes(data.finance_eligibility_status)) return fail(res, 409, "Finance eligibility is not cleared");
  if (!["CLEARED", "OVERRIDE"].includes(data.document_eligibility_status)) return fail(res, 409, "Document eligibility is not cleared");
  const { data: updated, error: updateError } = await supabase.from("student_registrations").update({ registration_status: "SUBMITTED", submitted_at: new Date().toISOString(), updated_by: actor(req), updated_at: new Date().toISOString() }).eq("id", String(req.params.id)).select("*").single();
  if (updateError) return next(updateError);
  await audit(req, "REGISTRATION_SUBMIT", "student_registrations", String(req.params.id), data, updated);
  res.json({ success: true, data: updated });
});

router.post("/registrations/:id/approve", requirePermission("registration.approve"), async (req, res, next) => {
  try {
    const approvalLevel = Number(req.body?.approval_level ?? 1);
    const approvalRole = String(req.body?.approval_role ?? "ACADEMIC").trim();
    const comments = req.body?.comments == null ? null : String(req.body.comments);
    if (!Number.isInteger(approvalLevel) || approvalLevel < 1) return fail(res, 400, "approval_level must be a positive integer");
    if (!approvalRole || approvalRole.length > 80) return fail(res, 400, "approval_role is required and must be at most 80 characters");
    if (comments && comments.length > 2000) return fail(res, 400, "comments cannot exceed 2000 characters");
    const { data, error } = await getSupabase().rpc("approve_student_registration_atomic", {
      p_registration_id: String(req.params.id), p_actor_id: actor(req), p_approval_level: approvalLevel,
      p_approval_role: approvalRole, p_comments: comments, p_ip_address: req.ip ?? null, p_request_id: requestId(req),
    });
    if (error) return next(error);
    res.json({ success: true, data: data?.registration ?? data });
  } catch (error) { next(error); }
});

router.post("/registrations/:id/register", requirePermission("registration.register"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const { data, error } = await getSupabase().rpc("register_student_registration_atomic", {
      p_registration_id: id,
      p_actor_id: actor(req),
      p_ip_address: req.ip ?? null,
      p_request_id: requestId(req),
    });
    if (error) return next(error);
    const registration = data?.registration;
    const studentId = registration?.student_id;
    if (!studentId) return next(new Error("Registration finalization returned no student reference."));
    try {
      const portalAccount = await linkStudentPortalAccount(String(studentId), String(actor(req)));
      return res.json({ success: true, data: registration, portalLinked: true, portalAccount, message: "Student registered, account linked to the application email and Student role, and ready for the Student Portal." });
    } catch (error: any) {
      return res.status(200).json({ success: true, data: registration, portalLinked: false, message: `Registration is complete, but portal account linking needs review: ${error?.message || "unknown account error"}` });
    }
  } catch (error) { return next(error); }
});

router.post("/registrations/:id/lock", requirePermission("registration.lock"), async (req, res, next) => {
  return updateById(req, res, next, "student_registrations", String(req.params.id), { registration_status: "LOCKED", locked_by: actor(req), locked_at: new Date().toISOString(), updated_by: actor(req), updated_at: new Date().toISOString() }, "registration.lock", "REGISTRATION_LOCK", "student_registrations");
});

router.post("/add-drop/:id/decide", requirePermission("registration.add_drop.decide"), async (req, res, next) => {
  const decision = String(req.body?.decision ?? "").toUpperCase();
  if (!["APPROVED", "REJECTED"].includes(decision)) return fail(res, 400, "decision must be APPROVED or REJECTED");
  return updateById(req, res, next, "course_add_drop_requests", String(req.params.id), { request_status: decision, decision_reason: req.body?.reason ?? null, reviewed_by: actor(req), reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() }, "registration.add_drop.decide", "ADD_DROP_DECIDE", "course_add_drop_requests");
});

// ---------------- Timetable ----------------
router.post("/timetables/:id/review", requirePermission("timetable.review"), async (req, res, next) => updateById(req, res, next, "timetables", String(req.params.id), { status: "UNDER_REVIEW", updated_by: actor(req), updated_at: new Date().toISOString() }, "timetable.review", "TIMETABLE_REVIEW", "timetables"));
router.post("/timetables/:id/approve", requirePermission("timetable.approve"), async (req, res, next) => updateById(req, res, next, "timetables", String(req.params.id), { status: "APPROVED", updated_by: actor(req), updated_at: new Date().toISOString() }, "timetable.approve", "TIMETABLE_APPROVE", "timetables"));
router.post("/timetables/:id/publish", requirePermission("timetable.publish"), async (req, res, next) => updateById(req, res, next, "timetables", String(req.params.id), { status: "PUBLISHED", published_by: actor(req), published_at: new Date().toISOString(), updated_by: actor(req), updated_at: new Date().toISOString() }, "timetable.publish", "TIMETABLE_PUBLISH", "timetables"));
router.post("/timetables/:id/lock", requirePermission("timetable.lock"), async (req, res, next) => updateById(req, res, next, "timetables", String(req.params.id), { status: "LOCKED", locked_by: actor(req), locked_at: new Date().toISOString(), updated_by: actor(req), updated_at: new Date().toISOString() }, "timetable.lock", "TIMETABLE_LOCK", "timetables"));

// ---------------- Assessments ----------------
router.post("/assessments/:id/open", requirePermission("assessment.open"), async (req, res, next) => updateById(req, res, next, "assessments", String(req.params.id), { status: "OPEN", updated_by: actor(req), updated_at: new Date().toISOString() }, "assessment.open", "ASSESSMENT_OPEN", "assessments"));
router.post("/assessments/:id/submit", requirePermission("assessment.submit"), async (req, res, next) => updateById(req, res, next, "assessments", String(req.params.id), { status: "SUBMITTED", updated_by: actor(req), updated_at: new Date().toISOString() }, "assessment.submit", "ASSESSMENT_SUBMIT", "assessments"));
router.post("/assessments/:id/approve", requirePermission("assessment.approve"), async (req, res, next) => updateById(req, res, next, "assessments", String(req.params.id), { status: "APPROVED", approved_by: actor(req), approved_at: new Date().toISOString(), updated_by: actor(req), updated_at: new Date().toISOString() }, "assessment.approve", "ASSESSMENT_APPROVE", "assessments"));
router.post("/assessments/:id/lock", requirePermission("assessment.lock"), async (req, res, next) => updateById(req, res, next, "assessments", String(req.params.id), { status: "LOCKED", locked_by: actor(req), locked_at: new Date().toISOString(), updated_by: actor(req), updated_at: new Date().toISOString() }, "assessment.lock", "ASSESSMENT_LOCK", "assessments"));

router.post("/assessment-marks/:id/submit", requirePermission("assessment.marks.submit"), async (req, res, next) => updateById(req, res, next, "assessment_marks", String(req.params.id), { status: "SUBMITTED", submitted_by: actor(req), submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() }, "assessment.marks.submit", "ASSESSMENT_MARK_SUBMIT", "assessment_marks"));
router.post("/assessment-marks/:id/approve", requirePermission("assessment.marks.approve"), async (req, res, next) => updateById(req, res, next, "assessment_marks", String(req.params.id), { status: "APPROVED", approved_by: actor(req), approved_at: new Date().toISOString(), updated_at: new Date().toISOString() }, "assessment.marks.approve", "ASSESSMENT_MARK_APPROVE", "assessment_marks"));
router.post("/assessment-marks/:id/lock", requirePermission("assessment.marks.lock"), async (req, res, next) => updateById(req, res, next, "assessment_marks", String(req.params.id), { status: "LOCKED", updated_at: new Date().toISOString() }, "assessment.marks.lock", "ASSESSMENT_MARK_LOCK", "assessment_marks"));

router.post("/assessment-corrections/:id/decide", requirePermission("assessment.correction.decide"), async (req, res, next) => {
  const decision = String(req.body?.decision ?? "").toUpperCase();
  if (!["APPROVED", "REJECTED", "CANCELLED"].includes(decision)) return fail(res, 400, "decision must be APPROVED, REJECTED or CANCELLED");
  const reason = req.body?.reason == null ? null : String(req.body.reason);
  if (reason && reason.length > 2000) return fail(res, 400, "reason cannot exceed 2000 characters");
  try {
    const { data, error } = await getSupabase().rpc("decide_assessment_mark_correction_atomic", {
      p_correction_id: String(req.params.id),
      p_decision: decision,
      p_actor_id: actor(req),
      p_review_comment: reason,
      p_ip_address: req.ip ?? null,
      p_request_id: requestId(req),
    });
    if (error) return next(error);
    res.json({ success: true, data: data?.correction ?? data });
  } catch (error) { next(error); }
});

// ---------------- Examinations ----------------
router.post("/examination-candidates/:id/eligibility", requirePermission("examination.eligibility"), async (req, res, next) => {
  const status = String(req.body?.status ?? "").toUpperCase();
  if (!["ELIGIBLE", "INELIGIBLE", "WITHHELD"].includes(status)) return fail(res, 400, "status must be ELIGIBLE, INELIGIBLE or WITHHELD");
  return updateById(req, res, next, "examination_candidates", String(req.params.id), { eligibility_status: status, eligibility_reason: req.body?.reason ?? null, updated_at: new Date().toISOString() }, "examination.eligibility", "EXAM_ELIGIBILITY", "examination_candidates");
});
async function transitionExaminationMark(req: Request, res: Response, next: NextFunction, from: string[], to: string, permission: string, action: string, actorField: string, timeField: string) {
  try {
    const db=getSupabase(), id=String(req.params.id??""), actorId=actor(req);
    const current=await db.from("examination_marks").select("id,status,entered_by,submitted_by,approved_by").eq("id",id).maybeSingle();
    if(current.error)return next(current.error);
    if(!current.data)return fail(res,404,"examination_marks not found");
    if(!from.includes(String(current.data.status)))return fail(res,409,`Examination mark cannot move from ${current.data.status} to ${to}.`);
    if(to==="APPROVED"&&(!current.data.entered_by||current.data.entered_by===actorId))return fail(res,403,"The mark entrant cannot approve their own examination mark.");
    const now=new Date().toISOString(),patch:Record<string,unknown>={status:to,updated_at:now,[actorField]:actorId,[timeField]:now};
    const saved=await db.from("examination_marks").update(patch).eq("id",id).in("status",from).select("*").maybeSingle();
    if(saved.error)return next(saved.error);
    if(!saved.data)return fail(res,409,"Examination mark changed; reload and try again.");
    await audit(req,action,"examination_marks",id,current.data,saved.data);
    return res.json({success:true,data:saved.data});
  }catch(error){return next(error);}
}
router.post("/examination-marks/:id/submit", requirePermission("examination.marks.submit"), async (req,res,next)=>transitionExaminationMark(req,res,next,["DRAFT"],"SUBMITTED","examination.marks.submit","EXAM_MARK_SUBMIT","submitted_by","submitted_at"));
router.post("/examination-marks/:id/approve", requirePermission("examination.marks.approve"), async (req,res,next)=>transitionExaminationMark(req,res,next,["SUBMITTED"],"APPROVED","examination.marks.approve","EXAM_MARK_APPROVE","approved_by","approved_at"));
router.post("/examination-marks/:id/lock", requirePermission("examination.marks.lock"), async (req,res,next)=>transitionExaminationMark(req,res,next,["APPROVED"],"LOCKED","examination.marks.lock","EXAM_MARK_LOCK","locked_by","locked_at"));

// ---------------- Results ----------------
router.post("/course-results/:id/calculate", requirePermission("results.calculate"), async (req, res, next) => {
  try {
    const supabase = getSupabase();
    const { data: before, error: readError } = await supabase.from("course_results").select("*").eq("id", String(req.params.id)).maybeSingle();
    if (readError) return next(readError);
    if (!before) return fail(res, 404, "Course result not found");
    const { data: calculated, error } = await supabase.rpc("calculate_course_result", { p_course_result_id: String(req.params.id) });
    if (error) return next(error);
    await audit(req, "RESULT_CALCULATE", "course_results", String(req.params.id), before, calculated);
    res.json({ success: true, data: calculated });
  } catch (error) { next(error); }
});
async function notifyResultReviewers(result: Record<string, any>, targetStatus: string, excludeUserId: string | null): Promise<void> {
  const db = getSupabase();
  const step: Record<string, { roles: string[]; label: string }> = {
    SUBMITTED: { roles: ["HOD"], label: "HOD publication" },
    HOD_VERIFIED: { roles: ["HOD"], label: "HOD publication" },
    EXAMINATION_REVIEWED: { roles: ["HOD"], label: "HOD publication" },
    DEPUTY_REVIEWED: { roles: ["HOD"], label: "HOD publication" },
    PRINCIPAL_APPROVED: { roles: ["HOD"], label: "HOD publication" },
  };
  const next = step[targetStatus];
  const metadata = { entityType: "course_results", entityId: result.id, resultStatus: targetStatus };
  if (next) {
    let departmentId: string | null = null;
    if (result.course_offering_id) {
      const offering = await db.from("course_offerings").select("courses(department_id)").eq("id", result.course_offering_id).maybeSingle();
      const nested: any = offering.data?.courses;
      departmentId = Array.isArray(nested) ? nested[0]?.department_id ?? null : nested?.department_id ?? null;
    }
    await queueRoleWorkflowNotification(db, next.roles, {
      excludeUserId,
      departmentId,
      type: "RESULT_REVIEW",
      title: `Course result awaiting ${next.label}`,
      body: `A course result has reached ${targetStatus.replaceAll("_", " ")} and is waiting for ${next.label} review.`,
      metadata,
    });
  } else if (targetStatus === "PUBLISHED" && result.student_id) {
    await queueStudentWorkflowNotification(db, result.student_id, {
      type: "RESULT_PUBLISHED",
      title: "Results published",
      body: "Your academic result is now available in the student portal.",
      metadata,
    });
  }
}

router.post("/course-results/:id/submit", requirePermission("results.submit"), async (req, res, next) => {
  try {
    const db = getSupabase(), id = String(req.params.id), now = new Date().toISOString();
    const { data: before, error } = await db.from("course_results").select("*").eq("id", id).maybeSingle();
    if (error) return next(error);
    if (!before) return fail(res, 404, "Course result not found");
    if (before.result_status !== "CALCULATED") return fail(res, 409, `Result must be CALCULATED before submission; current status is ${before.result_status}.`);
    await courseworkScope(req,String(before.course_offering_id),"teach");
    const readiness=await db.rpc("idmc_cw_score",{p_student:before.student_id,p_offering:before.course_offering_id});
    if(readiness.error)return next(readiness.error);
    if(!readiness.data?.complete)return fail(res,409,readiness.data?.reason||"Submit all four coursework components before submitting the final result. Academic must configure the policy and map historical assessments first.");
    const saved = await db.from("course_results").update({ result_status: "SUBMITTED", submitted_by: actor(req), submitted_at: now, updated_at: now }).eq("id", id).eq("result_status", "CALCULATED").select("*").maybeSingle();
    if (saved.error) return next(saved.error);
    if (!saved.data) return fail(res, 409, "Another user changed this result. Reload and submit it again.");
    await audit(req, "RESULT_SUBMIT", "course_results", id, before, saved.data);
    await notifyResultReviewers(saved.data, "SUBMITTED", actor(req));
    return res.json({ success: true, data: saved.data });
  } catch (error) { return next(error); }
});
async function advanceCourseResult(req: Request, res: Response, next: NextFunction, expected: string, target: string, actorColumn: string, timeColumn: string, actionCode: string) {
  try {
    const db = getSupabase(), id = String(req.params.id), now = new Date().toISOString();
    const before = await db.from("course_results").select("id,result_status").eq("id", id).maybeSingle();
    if (before.error) return next(before.error);
    if (!before.data) return fail(res, 404, "Course result not found.");
    if (before.data.result_status !== expected) return fail(res, 409, `Result must be ${expected} before this action.`);
    if (expected === "SUBMITTED") {
      const [roles, scopes, staff, offering] = await Promise.all([
        db.from("user_roles").select("role_id,assigned_at,status,expires_at,roles!inner(role_code,status)").eq("user_id", actor(req)).eq("status", "ACTIVE"),
        db.from("user_scopes").select("department_id").eq("user_id", actor(req)).eq("scope_type", "DEPARTMENT").limit(1).maybeSingle(),
        db.from("staff").select("department_id,employment_status").eq("user_id", actor(req)).maybeSingle(),
        db.from("course_results").select("course_offering_id").eq("id", id).single(),
      ]);
      for (const query of [roles, scopes, staff, offering]) if (query.error) return next(query.error);
      if (!offering.data) return fail(res, 404, "Course offering was not found for this result.");
      const activeRoles = scopeRoleAssignments(roles.data, req.user!.activeRoleId);
      if (activeRoles[0]?.role_id) req.user!.activeRoleId = activeRoles[0].role_id;
      const roleCodes = activeRoles.map((row: any) => row.roles?.role_code).filter(Boolean);
      const departmentId = scopes.data?.department_id ?? (staff.data?.employment_status === "ACTIVE" ? staff.data.department_id : null);
      if (roleCodes.some((code: string) => ["HOD", "DEPUTY_HOD"].includes(code)) && !roleCodes.some((code: string) => ["ADMIN", "SUPER_ADMIN", "SYSTEM_ADMIN"].includes(code))) {
        if (!departmentId) return fail(res, 403, "Link this HOD account to an active department before reviewing results.");
        const { data: course, error: courseError } = await db.from("course_offerings").select("courses!inner(department_id)").eq("id", offering.data.course_offering_id).maybeSingle();
        if (courseError) return next(courseError);
        const nested: any = (course as any)?.courses;
        const courseDepartment = Array.isArray(nested) ? nested[0]?.department_id : nested?.department_id;
        if (courseDepartment !== departmentId) return fail(res, 403, "This result belongs to another department.");
      }
    }
    const patch: Record<string, unknown> = { result_status: target, updated_at: now, [actorColumn]: actor(req), [timeColumn]: now };
    if (typeof req.body?.comment === "string") patch.workflow_comment = req.body.comment.trim().slice(0, 2000) || null;
    const saved = await db.from("course_results").update(patch).eq("id", id).eq("result_status", expected).select("*").maybeSingle();
    if (saved.error) return next(saved.error);
    if (!saved.data) return fail(res, 409, "Another reviewer changed this result. Reload and review it again.");
    await audit(req, actionCode, "course_results", id, before.data, saved.data);
    await notifyResultReviewers(saved.data, target, actor(req));
    res.json({ success: true, data: saved.data });
  } catch (error) { next(error); }
}
router.post("/course-results/:id/hod-verify", requirePermission("results.hod.verify"), (req, res, next) => advanceCourseResult(req,res,next,"SUBMITTED","HOD_VERIFIED","hod_verified_by","hod_verified_at","RESULT_HOD_VERIFY"));
router.post("/course-results/:id/examination-review", requirePermission("results.examination.review"), (req, res, next) => advanceCourseResult(req,res,next,"HOD_VERIFIED","EXAMINATION_REVIEWED","examination_reviewed_by","examination_reviewed_at","RESULT_EXAMINATION_REVIEW"));
router.post("/course-results/:id/deputy-review", requirePermission("results.deputy.review"), (req, res, next) => advanceCourseResult(req,res,next,"EXAMINATION_REVIEWED","DEPUTY_REVIEWED","deputy_reviewed_by","deputy_reviewed_at","RESULT_DEPUTY_REVIEW"));
router.post("/course-results/:id/principal-approve", (_req, res) => fail(res, 410, "HOD publishes directly. Principal may comment on published results."));
router.post("/course-results/:id/registrar-publish", (_req, res) => fail(res, 410, "Use the department HOD publication workspace."));
router.get("/course-results/leadership-queue", requirePermission("leadership.dashboard.view"), async (_req, res, next) => {
  try {
    const result = await getSupabase().from("course_results").select("id,student_id,course_offering_id,academic_year_id,semester_id,result_status,updated_at,hod_verified_at,examination_reviewed_at,deputy_reviewed_at,principal_approved_at").in("result_status", ["SUBMITTED","HOD_VERIFIED","EXAMINATION_REVIEWED","DEPUTY_REVIEWED","PRINCIPAL_APPROVED"]).order("updated_at", { ascending: true }).limit(200);
    if (result.error) return next(result.error);
    const rows: any[] = result.data ?? [];
    const ids = (field: string) => [...new Set(rows.map(row => row[field]).filter(Boolean))];
    const [profiles, years, semesters, offerings] = await Promise.all([
      ids("student_id").length ? getSupabase().from("students").select("id,student_number,first_name,middle_name,last_name").in("id", ids("student_id")) : Promise.resolve({ data: [], error: null }),
      ids("academic_year_id").length ? getSupabase().from("academic_years").select("id,year_name,year_code").in("id", ids("academic_year_id")) : Promise.resolve({ data: [], error: null }),
      ids("semester_id").length ? getSupabase().from("semesters").select("id,semester_name,semester_code").in("id", ids("semester_id")) : Promise.resolve({ data: [], error: null }),
      ids("course_offering_id").length ? getSupabase().from("course_offerings").select("id,course_id").in("id", ids("course_offering_id")) : Promise.resolve({ data: [], error: null }),
    ]);
    for (const value of [profiles, years, semesters, offerings]) if (value.error) return next(value.error);
    const courseIds = [...new Set((offerings.data ?? []).map((item: any) => item.course_id).filter(Boolean))];
    const courses = courseIds.length ? await getSupabase().from("courses").select("id,course_code,course_name").in("id", courseIds) : { data: [], error: null };
    if (courses.error) return next(courses.error);
    const makeMap = (data: any[]) => new Map(data.map((item: any) => [item.id, item]));
    const studentMap = makeMap(profiles.data ?? []), yearMap = makeMap(years.data ?? []), semesterMap = makeMap(semesters.data ?? []), offeringMap = makeMap(offerings.data ?? []), courseMap = makeMap(courses.data ?? []);
    res.json({ success: true, data: rows.map(row => { const student: any = studentMap.get(row.student_id) ?? {}, year: any = yearMap.get(row.academic_year_id) ?? {}, semester: any = semesterMap.get(row.semester_id) ?? {}, offering: any = offeringMap.get(row.course_offering_id) ?? {}, course: any = courseMap.get(offering.course_id) ?? {}; return { ...row, student_number: student.student_number ?? "", student_name: [student.first_name,student.middle_name,student.last_name].filter(Boolean).join(" "), academic_year: year.year_name || year.year_code || "", semester_name: semester.semester_name || semester.semester_code || "", course_label: [course.course_code,course.course_name].filter(Boolean).join(" · ") }; }) });
  } catch (error) { next(error); }
});
// Prevent older generic routes from skipping one or more required reviewers.
router.post("/course-results/:id/review", (_req, res) => fail(res, 410, "Use the assigned HOD verification or examination review step."));
router.post("/course-results/:id/approve", (_req, res) => fail(res, 410, "HOD publishes directly; Principal comments on published results."));
router.post("/course-results/:id/publish", (_req, res) => fail(res, 410, "Use the department HOD publication workspace."));
router.post("/course-results/:id/lock", requirePermission("results.lock"), async (req, res, next) => updateById(req, res, next, "course_results", String(req.params.id), { result_status: "LOCKED", locked_by: actor(req), locked_at: new Date().toISOString(), updated_at: new Date().toISOString() }, "results.lock", "RESULT_LOCK", "course_results"));

// ---------------- Transcripts ----------------
router.post("/transcripts/:id/generate", requirePermission("transcript.generate"), async (req, res, next) => {
  const supabase = getSupabase();
  const { data: snapshot, error: snapshotError } = await supabase.rpc("generate_student_transcript_snapshot_atomic", {
    p_transcript_id: String(req.params.id),
    p_actor_id: actor(req),
    p_ip_address: req.ip ?? null,
    p_request_id: req.requestId ?? null,
  });
  if (snapshotError) return next(snapshotError);
  res.json({ success: true, data: snapshot });
});
async function transitionTranscript(req: Request, res: Response, next: NextFunction, action: "REVIEW" | "APPROVE" | "ISSUE" | "REVOKE"): Promise<void> {
  try {
    const { data, error } = await getSupabase().rpc("transition_student_transcript_atomic", {
      p_transcript_id: String(req.params.id), p_actor_id: actor(req), p_action: action,
      p_reason: action === "REVOKE" ? String(req.body?.reason ?? "").trim() : null,
      p_ip_address: req.ip ?? null, p_request_id: requestId(req),
    });
    if (error) return next(error);
    res.json({ success: true, data });
  } catch (error) { next(error); }
}
router.post("/transcripts/:id/review", requirePermission("transcript.review"), async (req, res, next) => transitionTranscript(req, res, next, "REVIEW"));
router.post("/transcripts/:id/approve", requirePermission("transcript.approve"), async (req, res, next) => transitionTranscript(req, res, next, "APPROVE"));
router.post("/transcripts/:id/issue", requirePermission("transcript.issue"), async (req, res, next) => transitionTranscript(req, res, next, "ISSUE"));
router.post("/transcripts/:id/revoke", requirePermission("transcript.revoke"), async (req, res, next) => transitionTranscript(req, res, next, "REVOKE"));

// ---------------- Graduation / Certificates / Alumni ----------------
router.post("/graduation-clearances/:id/clear", requirePermission("graduation.clearance"), async (req, res, next) => updateById(req, res, next, "graduation_clearances", String(req.params.id), { status: "CLEARED", cleared_by: actor(req), cleared_at: new Date().toISOString(), remarks: req.body?.remarks ?? null, updated_at: new Date().toISOString() }, "graduation.clearance", "GRADUATION_CLEARANCE", "graduation_clearances"));
router.post("/graduation-candidates/:id/eligibility", requirePermission("graduation.eligibility"), async (req, res, next) => {
  const eligibility = String(req.body?.status ?? "").toUpperCase();
  if (!["ELIGIBLE", "INELIGIBLE", "REVIEW"].includes(eligibility)) return fail(res, 400, "status must be ELIGIBLE, INELIGIBLE or REVIEW");
  return updateById(req, res, next, "graduation_candidates", String(req.params.id), { eligibility_status: eligibility, academic_completion_status: eligibility === "ELIGIBLE" ? "COMPLETE" : req.body?.academic_completion_status ?? "PENDING", eligible_at: eligibility === "ELIGIBLE" ? new Date().toISOString() : null, updated_at: new Date().toISOString() }, "graduation.eligibility", "GRADUATION_ELIGIBILITY", "graduation_candidates");
});
router.post("/graduation-candidates/:id/approve", requirePermission("graduation.approve"), async (req, res, next) => {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("graduation_candidates").select("*").eq("id", String(req.params.id)).maybeSingle();
  if (error) return next(error);
  if (!data) return fail(res, 404, "Graduation candidate not found");
  if (data.eligibility_status !== "ELIGIBLE" || data.academic_completion_status !== "COMPLETE") return fail(res, 409, "Candidate must be eligible and academically complete");
  const { data: clearances, error: clearanceError } = await supabase.from("graduation_clearances").select("status").eq("graduation_candidate_id", String(req.params.id));
  if (clearanceError) return next(clearanceError);
  if ((clearances ?? []).length < 1 || (clearances ?? []).some((c) => !["CLEARED", "WAIVED"].includes(c.status))) return fail(res, 409, "All graduation clearances must be CLEARED or WAIVED");
  const { data: updated, error: updateError } = await supabase.from("graduation_candidates").update({ candidate_status: "APPROVED", approved_by: actor(req), approved_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", String(req.params.id)).select("*").single();
  if (updateError) return next(updateError);
  const { error: approvalError } = await supabase.from("graduation_approvals").upsert({ graduation_candidate_id: String(req.params.id), approval_stage: String(req.body?.approval_stage ?? "ACADEMIC"), decision: "APPROVED", comments: req.body?.comments ?? null, approved_by: actor(req), approved_at: new Date().toISOString() }, { onConflict: "graduation_candidate_id,approval_stage" });
  if (approvalError) return next(approvalError);
  await audit(req, "GRADUATION_APPROVE", "graduation_candidates", String(req.params.id), data, updated);
  res.json({ success: true, data: updated });
});
router.post("/graduation-candidates/:id/graduate", requirePermission("graduation.graduate"), async (req, res, next) => {
  return updateById(req, res, next, "graduation_candidates", String(req.params.id), { candidate_status: "GRADUATED", updated_at: new Date().toISOString() }, "graduation.graduate", "GRADUATION_COMPLETE", "graduation_candidates");
});
router.post("/certificates/:id/issue", requirePermission("certificate.issue"), async (req, res, next) => updateById(req, res, next, "certificates", String(req.params.id), { status: "ISSUED", issued_by: actor(req), issue_date: new Date().toISOString().slice(0,10), issued_at: new Date().toISOString(), updated_at: new Date().toISOString() }, "certificate.issue", "CERTIFICATE_ISSUE", "certificates"));
router.post("/certificates/:id/revoke", requirePermission("certificate.revoke"), async (req, res, next) => {
  const reason = String(req.body?.reason ?? "").trim();
  if (!reason) return fail(res, 400, "reason is required");
  return updateById(req, res, next, "certificates", String(req.params.id), { status: "REVOKED", revoked_by: actor(req), revoked_at: new Date().toISOString(), revocation_reason: reason, updated_at: new Date().toISOString() }, "certificate.revoke", "CERTIFICATE_REVOKE", "certificates");
});
router.post("/alumni/:id/activate", requirePermission("alumni.activate"), async (req, res, next) => updateById(req, res, next, "alumni_records", String(req.params.id), { status: "ACTIVE", updated_at: new Date().toISOString() }, "alumni.activate", "ALUMNI_ACTIVATE", "alumni_records"));


/* ============================================================
 * SECTION 11
 * ACCEPTED APPLICATION -> STUDENT
 *
 * Database function:
 * public.convert_accepted_application_to_student(uuid)
 *
 * Idempotency:
 * source_application_id is UNIQUE.
 * Existing student is returned instead of duplicated.
 * ============================================================ */

router.post(
  "/admission-applications/:id/convert-to-student",
  requirePermission("admissions.manage"),
  async (req, res, next) => {
    try {
      const supabase = getSupabase();

      const applicationId = String(req.params.id || "").trim();

      if (!applicationId) {
        return res.status(400).json({
          success: false,
          message: "Application ID is required",
        });
      }

      // --------------------------------------------------------
      // 1. Existing student check
      // --------------------------------------------------------

      const {
        data: existingStudent,
        error: existingStudentError,
      } = await supabase
        .from("students")
        .select("*")
        .eq("source_application_id", applicationId)
        .maybeSingle();

      if (existingStudentError) {
        throw existingStudentError;
      }

      if (existingStudent) {
        return res.status(200).json({
          success: true,
          created: false,
          message: "Application already converted to student",
          data: existingStudent,
        });
      }

      // --------------------------------------------------------
      // 2. Verify application
      // --------------------------------------------------------

      const {
        data: application,
        error: applicationError,
      } = await supabase
        .from("applications")
        .select("*")
        .eq("id", applicationId)
        .maybeSingle();

      if (applicationError) {
        throw applicationError;
      }

      if (!application) {
        return res.status(404).json({
          success: false,
          message: "Application not found",
        });
      }

      if (application.status !== "ACCEPTED") {
        return res.status(409).json({
          success: false,
          message:
            `Application cannot be converted from status ${application.status}; expected ACCEPTED`,
        });
      }

      // --------------------------------------------------------
      // 3. Execute canonical database conversion
      // --------------------------------------------------------

      const {
        data: studentId,
        error: conversionError,
      } = await supabase.rpc(
        "convert_accepted_application_to_student",
        {
          p_application_id: applicationId,
        }
      );

      if (conversionError) {
        throw conversionError;
      }

      if (!studentId) {
        throw new Error(
          "Student conversion completed without returning a student ID"
        );
      }

      // --------------------------------------------------------
      // 4. Read final student
      // --------------------------------------------------------

      const {
        data: student,
        error: studentError,
      } = await supabase
        .from("students")
        .select("*")
        .eq("id", studentId)
        .single();

      if (studentError) {
        throw studentError;
      }

      return res.status(201).json({
        success: true,
        created: true,
        message: "Applicant converted to student successfully",
        data: student,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

