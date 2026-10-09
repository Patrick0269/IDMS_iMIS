import { Router } from "express";
import { getSupabase } from "../../config/database.js";
import { requirePermission } from "../../middleware/rbac.js";
import { queueStudentWorkflowNotification } from "../../services/workflow-notification.service.js";
const router = Router();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function failure(error: any): Error {
  return Object.assign(new Error(error?.message || "Results action failed."), { statusCode: error?.code === "42501" ? 403 : error?.code === "PGRST202" ? 503 : 400 });
}
router.post("/course-results/:id/hod-review-calculated",requirePermission("results.hod.publish"),async(req,res,next)=>{try{const id=String(req.params.id);if(!uuid.test(id))return res.status(400).json({success:false,message:"Invalid result ID."});const result=await getSupabase().rpc("idmc_hod_review_calculated",{p_result:id,p_actor:req.user!.id});if(result.error)throw result.error;return res.json({success:true,data:result.data});}catch(e){return next(failure(e));}});
for (const mode of ["HOD", "PRINCIPAL"] as const) {
  router.get(`/course-results/${mode.toLowerCase()}-workspace`, requirePermission(mode === "HOD" ? "results.hod.publish" : "results.principal.comment"), async (req, res, next) => {
    try {
      const offset = Number(req.query.offset || 0), limit = Number(req.query.limit || 50);
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) return res.status(400).json({ success: false, message: "Invalid results page." });
      const result = await getSupabase().rpc("idmc_result_workspace", { p_actor: req.user!.id, p_mode: mode, p_offset: offset, p_limit: limit });
      if (result.error) throw result.error;
      return res.json({ success: true, data: result.data });
    } catch (error) { return next(failure(error)); }
  });
}
router.post("/course-results/:id/hod-publish", requirePermission("results.hod.publish"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!uuid.test(id)) return res.status(400).json({ success: false, message: "Invalid result ID." });
    const db = getSupabase();
    const result = await db.rpc("idmc_hod_publish", { p_result: id, p_actor: req.user!.id });
    if (result.error) throw result.error;
    if (!result.data.alreadyPublished) await queueStudentWorkflowNotification(db, String(result.data.studentId), { type: "RESULT_PUBLISHED", title: "Results published", body: "Your department HOD has published your course result. Open the student results page.", metadata: { resultId: id } });
    return res.json({ success: true, data: result.data });
  } catch (error) { return next(failure(error)); }
});
router.post("/course-results/:id/principal-comment", requirePermission("results.principal.comment"), async (req, res, next) => {
  try {
    const id = String(req.params.id), b = req.body || {};
    if (!uuid.test(id) || !uuid.test(b.commentId || "") || typeof b.comment !== "string" || !b.comment.trim() || b.comment.trim().length > 2000) return res.status(400).json({ success: false, message: "Enter a comment of 1 to 2000 characters and a valid request ID." });
    const result = await getSupabase().rpc("idmc_principal_result_comment", { p_result: id, p_comment_id: b.commentId, p_comment: b.comment.trim(), p_actor: req.user!.id });
    if (result.error) throw result.error;
    return res.json({ success: true, data: result.data });
  } catch (error) { return next(failure(error)); }
});
export default router;
