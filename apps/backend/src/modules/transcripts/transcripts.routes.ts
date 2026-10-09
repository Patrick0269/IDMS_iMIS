import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/rbac.js";
import { getSupabase } from "../../config/database.js";
import { registerCrudResource } from "../../utils/resourceCrud.js";

const router = Router();

router.use(authenticate);

const VIEW = "transcripts.view";
const MANAGE = "transcripts.manage";

router.get("/reference-data/students", requirePermission(VIEW), async (req, res, next) => {
  try {
    const search = String(req.query.search ?? "").replace(/[^A-Za-z0-9 .-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    if (search.length < 2) return res.json({ success: true, data: [] });
    const escaped = search.replace(/[%_,()]/g, " ").replace(/\s+/g, " ").trim();
    if (escaped.length < 2) return res.json({ success: true, data: [] });
    const result = await getSupabase().from("students")
      .select("id,student_number,first_name,middle_name,last_name,student_status")
      .is("archived_at", null)
      .or(`student_number.ilike.%${escaped}%,first_name.ilike.%${escaped}%,middle_name.ilike.%${escaped}%,last_name.ilike.%${escaped}%`)
      .order("student_number")
      .limit(50);
    if (result.error) throw result.error;
    res.json({ success: true, data: result.data ?? [] });
  } catch (error) { next(error); }
});

router.get("/:id/snapshot", requirePermission(VIEW), async (req, res, next) => {
  try {
    const db = getSupabase(), id = String(req.params.id ?? "").trim();
    const header = await db.from("student_transcripts").select("*").eq("id", id).maybeSingle();
    if (header.error) throw header.error;
    if (!header.data) return res.status(404).json({ success: false, message: "Transcript not found." });
    const [semesters, courses] = await Promise.all([
      db.from("student_transcript_semesters").select("*").eq("transcript_id", id).order("sequence_no"),
      db.from("student_transcript_courses").select("*").eq("transcript_id", id).order("display_sequence"),
    ]);
    if (semesters.error) throw semesters.error;
    if (courses.error) throw courses.error;
    res.json({ success: true, data: { transcript: header.data, semesters: semesters.data ?? [], courses: courses.data ?? [] } });
  } catch (error) { next(error); }
});

registerCrudResource(
  router,
  {
    moduleCode: "TRANSCRIPTS",
    entityType: "student_transcripts",
    table: "student_transcripts",
    permissionView: VIEW,
    permissionManage: MANAGE,

    searchFields: [
      "transcript_number",
      "transcript_type",
      "issue_reason",
      "final_academic_standing",
      "transcript_status",
      "verification_code",
      "remarks"
    ],

    filterFields: [
      "student_id",
      "programme_version_id",
      "transcript_type",
      "transcript_status",
      "replacement_of"
    ],

    defaultOrderField: "created_at",

    allowUpdate: false,
    allowDelete: false,
    listFields: ["transcript_number", "cumulative_earned_credits", "cgpa", "final_academic_standing", "transcript_status", "generated_at", "generated_by", "approved_at", "approved_by", "issued_at", "issued_by", "verification_code"],
    fields: {
      studentId: "student_id",
      programmeVersionId: "programme_version_id",
      transcriptType: "transcript_type",
      issueReason: "issue_reason",
      replacementOf: "replacement_of",
      remarks: "remarks"
    }
  },
  "/"
);

registerCrudResource(
  router,
  {
    moduleCode: "TRANSCRIPTS",
    entityType: "student_transcript_semesters",
    table: "student_transcript_semesters",
    permissionView: VIEW,
    permissionManage: MANAGE,

    searchFields: [],

    filterFields: [
      "transcript_id",
      "academic_year_id",
      "semester_id",
      "semester_result_id"
    ],

    defaultOrderField: "created_at",
    allowCreate: false,
    allowUpdate: false,
    allowDelete: false,
    listFields: ["gpa", "registered_credits", "attempted_credits", "earned_credits", "academic_standing", "sequence_no"],

    fields: {
      transcriptId: "transcript_id",
      academicYearId: "academic_year_id",
      semesterId: "semester_id",
      semesterResultId: "semester_result_id"
    }
  },
  "/semesters"
);

registerCrudResource(
  router,
  {
    moduleCode: "TRANSCRIPTS",
    entityType: "student_transcript_courses",
    table: "student_transcript_courses",
    permissionView: VIEW,
    permissionManage: MANAGE,

    searchFields: ["course_code", "course_name", "grade_code"],

    filterFields: [
      "transcript_id",
      "transcript_semester_id"
    ],

    defaultOrderField: "created_at",
    allowCreate: false,
    allowUpdate: false,
    allowDelete: false,
    listFields: ["course_code", "course_name", "credits", "grade_code", "grade_point", "total_mark", "pass_status", "display_sequence"],

    fields: {
      transcriptId: "transcript_id",
      transcriptSemesterId: "transcript_semester_id",
      courseCode: "course_code",
      courseName: "course_name",
      credits: "credits",
      gradeCode: "grade_code",
      gradePoint: "grade_point",
      totalMark: "total_mark",
      passStatus: "pass_status"
    }
  },
  "/courses"
);

export default router;
