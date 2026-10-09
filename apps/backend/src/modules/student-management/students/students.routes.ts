import { Router } from "express";

import {
    authenticate,
} from "../../../middleware/auth.js";

import {
    requirePermission,
} from "../../../middleware/rbac.js";
import { getSupabase } from "../../../config/database.js";
import { createAuditLog } from "../../../services/audit.service.js";

import {
    createStudentController,
    getMyStudentController,
    getStudentController,
    listStudentsController,
    getStudentsSummaryController,
    updateStudentController,
} from "./students.controller.js";
import studentSelfServiceRoutes from "./student-self-service.routes.js";

const router =
    Router();

router.use(authenticate);

router.get(
    "/me",
    requirePermission("students.self.view"),
    getMyStudentController
);

router.use(
    "/me",
    studentSelfServiceRoutes
);

router.get(
    "/",
    requirePermission("students.view"),
    listStudentsController
);

router.get(
    "/summary",
    requirePermission("students.view"),
    getStudentsSummaryController
);

router.post("/bulk-status", requirePermission("students.activate"), async (req, res, next) => {
    try {
        const status = String(req.body?.status ?? "").toUpperCase();
        if (!["ACTIVE", "INACTIVE"].includes(status)) return res.status(400).json({ success: false, message: "Choose ACTIVE or INACTIVE." });
        if (status === "INACTIVE") return res.status(403).json({ success: false, message: "Use the controlled student status workflow to deactivate records." });
        const db = getSupabase(), now = new Date().toISOString();
        const changed = await db.from("students").update({ student_status: "ACTIVE", updated_at: now, updated_by: req.user?.id }).eq("student_status", "INACTIVE").is("archived_at", null).select("id,student_number");
        if (changed.error) throw changed.error;
        await createAuditLog({ actorUserId: req.user!.id, actionCode: "STUDENTS_BULK_ACTIVATE", moduleCode: "students", entityType: "student", oldValues: { student_status: "INACTIVE" }, newValues: { student_status: "ACTIVE", count: changed.data?.length ?? 0 }, requestId: req.requestId, ipAddress: req.ip });
        res.json({ success: true, data: { updated: changed.data?.length ?? 0 }, message: `${changed.data?.length ?? 0} inactive student(s) activated.` });
    } catch (error) { next(error); }
});

router.post("/:id/deletion-request", requirePermission("students.delete.request"), async (req, res, next) => {
    try {
        const reason = String(req.body?.reason ?? "").trim().slice(0, 2000);
        if (!reason) return res.status(400).json({ success: false, message: "A reason is required for the deletion request." });
        const db = getSupabase(), id = String(req.params.id);
        const student = await db.from("students").select("id,student_number,student_status,archived_at").eq("id", id).maybeSingle();
        if (student.error) throw student.error;
        if (!student.data || student.data.archived_at) return res.status(404).json({ success: false, message: "Active student record was not found." });
        const prior = await db.from("student_deletion_requests").select("id").eq("student_id", id).eq("request_status", "PENDING").maybeSingle();
        if (prior.error) throw prior.error;
        if (prior.data) return res.status(409).json({ success: false, message: "A deletion request is already awaiting Admin approval." });
        const created = await db.from("student_deletion_requests").insert({ student_id: id, requested_by: req.user!.id, request_reason: reason }).select("*").single();
        if (created.error) throw created.error;
        await createAuditLog({ actorUserId: req.user!.id, actionCode: "STUDENT_DELETE_REQUEST", moduleCode: "students", entityType: "student", entityId: id, oldValues: student.data, newValues: { request_id: created.data.id, reason }, requestId: req.requestId, ipAddress: req.ip });
        res.status(201).json({ success: true, data: created.data, message: `Deletion request for ${student.data.student_number} sent for Admin approval.` });
    } catch (error) { next(error); }
});

router.get("/deletion-requests", requirePermission("students.delete.approve"), async (_req, res, next) => {
    try {
        const result = await getSupabase().from("student_deletion_requests").select("*,students!inner(id,student_number,registration_number,first_name,middle_name,last_name,student_status)").eq("request_status", "PENDING").order("created_at", { ascending: true });
        if (result.error) throw result.error;
        res.json({ success: true, data: result.data ?? [] });
    } catch (error) { next(error); }
});

router.post("/deletion-requests/:id/approve", requirePermission("students.delete.approve"), async (req, res, next) => {
    try {
        const db = getSupabase(), id = String(req.params.id);
        const request = await db.from("student_deletion_requests").select("student_id,request_reason,requested_by").eq("id", id).maybeSingle();
        if (request.error) throw request.error;
        if (!request.data) return res.status(404).json({ success: false, message: "Deletion request was not found." });
        if (request.data.requested_by === req.user!.id) return res.status(403).json({ success: false, message: "The requester cannot approve their own deletion request." });
        const archived = await db.rpc("approve_student_deletion", { p_request_id: id, p_reviewer_id: req.user!.id });
        if (archived.error) throw archived.error;
        const student = archived.data?.[0];
        if (!student) return res.status(409).json({ success: false, message: "Student deletion approval did not complete." });
        await createAuditLog({ actorUserId: req.user!.id, actionCode: "STUDENT_DELETE_APPROVED", moduleCode: "students", entityType: "student", entityId: student.student_id, oldValues: { request_status: "PENDING" }, newValues: { archived: true, request_id: id, reason: request.data.request_reason }, requestId: req.requestId, ipAddress: req.ip });
        res.json({ success: true, message: `Student ${student.student_number} archived. Academic, finance and audit records were retained.` });
    } catch (error) { next(error); }
});

router.post("/deletion-requests/:id/reject", requirePermission("students.delete.approve"), async (req, res, next) => {
    try {
        const db = getSupabase(), id = String(req.params.id);
        const reason = String(req.body?.reason ?? "").trim().slice(0, 2000);
        if (!reason) return res.status(400).json({ success: false, message: "A reason is required when rejecting a deletion request." });
        const current = await db.from("student_deletion_requests").select("id,student_id,requested_by,request_reason,request_status").eq("id", id).maybeSingle();
        if (current.error) throw current.error;
        if (!current.data || current.data.request_status !== "PENDING") return res.status(409).json({ success: false, message: "This deletion request is no longer pending." });
        const updated = await db.from("student_deletion_requests").update({ request_status: "REJECTED", reviewed_by: req.user!.id, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id).eq("request_status", "PENDING").select("id").maybeSingle();
        if (updated.error) throw updated.error;
        if (!updated.data) return res.status(409).json({ success: false, message: "Another administrator already reviewed this request." });
        await createAuditLog({ actorUserId: req.user!.id, actionCode: "STUDENT_DELETE_REJECTED", moduleCode: "students", entityType: "student", entityId: current.data.student_id, oldValues: { request_status: "PENDING" }, newValues: { request_status: "REJECTED", reason, request_reason: current.data.request_reason }, requestId: req.requestId, ipAddress: req.ip });
        res.json({ success: true, message: "Student deletion request rejected. The student record remains unchanged." });
    } catch (error) { next(error); }
});

router.get(
    "/:id",
    requirePermission("students.view"),
    getStudentController
);

router.post(
    "/",
    requirePermission("students.manage"),
    createStudentController
);

router.patch(
    "/:id",
    requirePermission("students.manage"),
    updateStudentController
);

export default router;

