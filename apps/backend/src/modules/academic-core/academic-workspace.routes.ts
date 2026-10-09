import { Router } from "express";
import { getSupabase } from "../../config/database.js";
import { requirePermission } from "../../middleware/rbac.js";

const router = Router();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function courseIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(x => typeof x !== "string" || !uuid.test(x))) {
    throw Object.assign(new Error("Select 1 to 100 valid course IDs."), { statusCode: 400 });
  }
  return [...new Set(value)];
}
function failure(error: any): Error {
  if (error?.code === "PGRST202" || error?.code === "42703") return Object.assign(new Error("Apply the latest Academic workspace SQL, including Database-Named-Academics.sql, before using this action."), { statusCode: 503 });
  return Object.assign(new Error(error?.message || "Academic workspace action failed."), { statusCode: error?.code === "23503" ? 409 : error?.code === "42501" ? 403 : 400 });
}
router.get("/workspace/context", requirePermission("academics.view"), async (_req, res, next) => {
  try {
    const db = getSupabase();
    const results = await Promise.all([db.from("institutions").select("*").limit(2), db.from("departments").select("*").order("department_name").limit(1001), db.from("schools").select("*").limit(1001)]);
    for (const r of results) if (r.error) throw r.error;
    if (results[0]!.data!.length !== 1) throw new Error("Academic setup requires one configured institution.");
    if (results.slice(1).some(x => x.data!.length > 1000)) throw new Error("Department/school context exceeds the supported limit.");
    const probe = await db.from("departments").select("academic_group").limit(1);
    if (probe.error) throw probe.error;
    res.json({ success: true, data: { institution: results[0]!.data![0], departments: results[1]!.data, schools: results[2]!.data } });
  } catch (error) { next(failure(error)); }
});
router.patch("/workspace/departments/:id/group", requirePermission("academics.manage"), async (req, res, next) => {
  try {
    const id = String(req.params.id), group = req.body?.group;
    if (!uuid.test(id) || !["SOCIAL", "PROJECT", null].includes(group)) return res.status(400).json({ success: false, message: "Choose a valid department and SOCIAL, PROJECT or unassigned group." });
    const saved = await getSupabase().rpc("idmc_academic_department_group", { p_department: id, p_group: group, p_actor: req.user!.id });
    if (saved.error) throw saved.error;
    return res.json({ success: true, data: saved.data });
  } catch (error) { return next(failure(error)); }
});
router.post("/workspace/courses/preview", requirePermission("academics.manage"), async (req, res, next) => {
  try {
    const result = await getSupabase().rpc("idmc_academic_course_cleanup_preview", { p_ids: courseIds(req.body?.ids) });
    if (result.error) throw result.error;
    res.json({ success: true, data: result.data });
  } catch (error) { next(failure(error)); }
});
router.post("/workspace/courses/action", requirePermission("academics.manage"), async (req, res, next) => {
  try {
    const action = String(req.body?.action || "");
    if (!["DELETE", "ARCHIVE", "UNUSE", "UNUSE_DELETE"].includes(action) || req.body?.confirmation !== `${action} SELECTED COURSES`) return res.status(400).json({ success: false, message: "Confirm the selected course action explicitly." });
    const result = await getSupabase().rpc(action.startsWith("UNUSE") ? "idmc_academic_course_cleanup" : "idmc_academic_course_action", { p_ids: courseIds(req.body?.ids), p_action: action, p_actor: req.user!.id });
    if (result.error) throw result.error;
    return res.json({ success: true, data: result.data });
  } catch (error) { return next(failure(error)); }
});
// Intercept the existing single delete before generic CRUD. Both deletion
// entry points now refuse every referenced course, including CASCADE links.
router.delete("/courses/:id", requirePermission("academics.manage"), async (req, res, next) => {
  try {
    const result = await getSupabase().rpc("idmc_academic_course_action", { p_ids: courseIds([req.params.id]), p_action: "DELETE", p_actor: req.user!.id });
    if (result.error) throw result.error;
    res.json({ success: true, data: result.data });
  } catch (error) { next(failure(error)); }
});
router.post("/workspace/mappings", requirePermission("academics.manage"), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 500) return res.status(400).json({ success: false, message: "Choose 1 to 500 course/curriculum pairs." });
    if (b.shared === true && (!uuid.test(b.academicYearId || "") || !uuid.test(b.semesterId || ""))) return res.status(400).json({ success: false, message: "Choose an academic year and its semester." });
    const result = await getSupabase().rpc("idmc_academic_save_mapping", { p_items: b.items, p_shared: b.shared === true, p_year: b.shared === true ? b.academicYearId : null, p_semester: b.shared === true ? b.semesterId : null, p_actor: req.user!.id });
    if (result.error) throw result.error;
    return res.json({ success: true, data: result.data });
  } catch (error) { return next(failure(error)); }
});
router.post("/workspace/curricula-with-courses", requirePermission("academics.manage"), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.curriculum || !Array.isArray(b.items) || b.items.length < 1 || b.items.length > 500) return res.status(400).json({ success: false, message: "Provide curriculum details and 1 to 500 course mappings." });
    const saved = await getSupabase().rpc("idmc_academic_create_curriculum", { p_curriculum: b.curriculum, p_items: b.items, p_actor: req.user!.id });
    if (saved.error) throw saved.error;
    return res.json({ success: true, data: saved.data });
  } catch (error) { return next(failure(error)); }
});
router.post("/workspace/courses/force-preview", requirePermission("academics.manage"), async (req, res, next) => {
  try {
    const saved = await getSupabase().rpc("idmc_course_force_preview", { p_ids: courseIds(req.body?.ids), p_actor: req.user!.id });
    if (saved.error) throw saved.error;
    return res.json({ success: true, data: saved.data });
  } catch (error) { return next(failure(error)); }
});
router.post("/workspace/courses/force-delete", requirePermission("academics.manage"), async (req, res, next) => {
  try {
    const jobId = String(req.body?.jobId || "");
    if (!uuid.test(jobId) || req.body?.confirmation !== "FORCE DELETE SELECTED COURSES") return res.status(400).json({ success: false, message: "Confirm the reviewed course deletion explicitly." });
    const saved = await getSupabase().rpc("idmc_course_force_delete", { p_job: jobId, p_actor: req.user!.id });
    if (saved.error) throw saved.error;
    return res.json({ success: true, data: saved.data });
  } catch (error) { return next(failure(error)); }
});
router.get("/workspace/courses/force-status/:id", requirePermission("academics.manage"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!uuid.test(id)) return res.status(400).json({ success: false, message: "Invalid deletion job ID." });
    const saved = await getSupabase().rpc("idmc_course_force_status", { p_job: id, p_actor: req.user!.id });
    if (saved.error) throw saved.error;
    return res.json({ success: true, data: saved.data });
  } catch (error) { return next(failure(error)); }
});
function normaliseCourseBody(body: unknown): Record<string, any> {
 if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Course details must be a JSON object");
 const result: Record<string, any> = { ...body };
 for (const key of ["institutionId","departmentId","courseCode","courseName","courseShortName","creditUnits","contactHours","courseType","crossCutting","autoMap","programmeId","curriculumId","yearNumber","semesterNumber","mappingCredits","courseCategory","isCompulsory","academicYearId","semesterId"]) {
  const snake = key.replace(/[A-Z]/g, c => "_" + c.toLowerCase());
  if (result[key] === undefined && result[snake] !== undefined) result[key] = result[snake];
 }
 return result;
}
router.post("/courses", requirePermission("academics.manage"), async (req,res,next)=>{
 try {const result=await getSupabase().rpc("idmc_academic_save_course",{p_course:normaliseCourseBody(req.body),p_id:null,p_actor:req.user!.id});if(result.error)throw result.error;return res.status(201).json({success:true,data:result.data});}catch(error){return next(failure(error));}
});
router.patch("/courses/:id", requirePermission("academics.manage"), async (req,res,next)=>{
 try {if(!uuid.test(String(req.params.id)))return res.status(400).json({success:false,message:"Invalid course reference"});const result=await getSupabase().rpc("idmc_academic_save_course",{p_course:normaliseCourseBody(req.body),p_id:req.params.id,p_actor:req.user!.id});if(result.error)throw result.error;return res.json({success:true,data:result.data});}catch(error){return next(failure(error));}
});
export default router;
