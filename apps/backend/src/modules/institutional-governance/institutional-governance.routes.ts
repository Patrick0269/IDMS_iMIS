import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/rbac.js";
import { getSupabase } from "../../config/database.js";
import { createAuditLog } from "../../services/audit.service.js";
import { registerCrudResource } from "../../utils/resourceCrud.js";

const router = Router();
router.use(authenticate);

router.post("/budgets/:id/submit", requirePermission("budget.manage"), async (req, res, next) => {
  try {
    const db = getSupabase();
    const { data: current, error: readError } = await db.from("institutional_budgets").select("id,status").eq("id", req.params.id).maybeSingle();
    if (readError) throw readError;
    if (!current) return res.status(404).json({ success:false, message:"Budget not found." });
    if (current.status !== "DRAFT" && current.status !== "REJECTED") return res.status(409).json({ success:false, message:"Only a draft or returned budget can be submitted." });
    const { data, error } = await db.from("institutional_budgets").update({ status:"SUBMITTED", submitted_at:new Date().toISOString(), approved_by:null, approved_at:null }).eq("id", req.params.id).select("*").single();
    if (error) throw error;
    await createAuditLog({ actorUserId:req.user?.id ?? null, actionCode:"BUDGET_SUBMIT", moduleCode:"BUDGET", entityType:"institutional_budgets", entityId:data.id, oldValues:current, newValues:data, ipAddress:req.ip ?? null, requestId:req.requestId ?? null }).catch(error => console.warn("Budget submission audit failed", error));
    return res.json({ success:true, data, message:"Budget sent for approval." });
  } catch (error) { next(error); }
});

router.post("/budgets/:id/decision", requirePermission("budget.approve"), async (req, res, next) => {
  try {
    const decision = String(req.body?.decision ?? "").toUpperCase();
    if (!["APPROVE","RETURN"].includes(decision)) return res.status(400).json({ success:false, message:"Decision must be APPROVE or RETURN." });
    const db = getSupabase();
    const { data: current, error: readError } = await db.from("institutional_budgets").select("id,status,proposed_amount").eq("id", req.params.id).maybeSingle();
    if (readError) throw readError;
    if (!current) return res.status(404).json({ success:false, message:"Budget not found." });
    if (!["SUBMITTED","FINANCE_REVIEW","PRINCIPAL_REVIEW","DIRECTOR_REVIEW"].includes(current.status)) return res.status(409).json({ success:false, message:"This budget is not awaiting approval." });
    const update = decision === "APPROVE"
      ? { status:"APPROVED", approved_amount:current.proposed_amount, approved_by:req.user?.id ?? null, approved_at:new Date().toISOString(), comment:typeof req.body?.comment === "string" ? req.body.comment : null }
      : { status:"REJECTED", approved_by:req.user?.id ?? null, approved_at:new Date().toISOString(), comment:typeof req.body?.comment === "string" ? req.body.comment : null };
    const { data, error } = await db.from("institutional_budgets").update(update).eq("id", req.params.id).select("*").single();
    if (error) throw error;
    await createAuditLog({ actorUserId:req.user?.id ?? null, actionCode:`BUDGET_${decision}`, moduleCode:"BUDGET", entityType:"institutional_budgets", entityId:data.id, oldValues:current, newValues:data, ipAddress:req.ip ?? null, requestId:req.requestId ?? null }).catch(error => console.warn("Budget decision audit failed", error));
    return res.json({ success:true, data, message:decision === "APPROVE" ? "Budget approved." : "Budget returned." });
  } catch (error) { next(error); }
});

const resource = (table: string, path: string, permission: string, fields: Record<string, string>, searchFields: string[], filterFields: string[] = [], setCreatedBy = true) => {
  registerCrudResource(router, {
    moduleCode: "GOVERNANCE",
    entityType: table,
    table,
    permissionView: `${permission}.view`,
    permissionManage: `${permission}.manage`,
    fields,
    searchFields,
    filterFields,
    allowDelete: false,
    setCreatedBy,
  }, path);
};

resource("discipline_cases", "/discipline/cases", "discipline", { institutionId:"institution_id", caseNumber:"case_number", studentId:"student_id", departmentId:"department_id", caseType:"case_type", incidentDate:"incident_date", description:"description", confidentiality:"confidentiality", assignedTo:"assigned_to", status:"status", decision:"decision", sanction:"sanction", appealDueDate:"appeal_due_date" }, ["case_number","case_type","description","status"], ["institution_id","student_id","department_id","status"]);
resource("discipline_case_events", "/discipline/events", "discipline", { caseId:"case_id", eventType:"event_type", eventDate:"event_date", details:"details", documentId:"document_id" }, ["event_type","details"], ["case_id"]);
resource("student_welfare_cases", "/welfare/cases", "welfare", { institutionId:"institution_id", caseNumber:"case_number", studentId:"student_id", caseType:"case_type", priority:"priority", summary:"summary", confidentialNotes:"confidential_notes", assignedTo:"assigned_to", followUpAt:"follow_up_at", status:"status" }, ["case_number","summary","status"], ["institution_id","student_id","assigned_to","status"]);
resource("student_welfare_followups", "/welfare/followups", "welfare", { caseId:"case_id", followUpAt:"follow_up_at", note:"note", nextFollowUpAt:"next_follow_up_at" }, ["note"], ["case_id"]);
resource("institutional_grievances", "/grievances", "grievances", { institutionId:"institution_id", caseNumber:"case_number", complainantUserId:"complainant_user_id", complainantStudentId:"complainant_student_id", subject:"subject", description:"description", confidentiality:"confidentiality", investigatorUserId:"investigator_user_id", status:"status", response:"response", resolution:"resolution", appealDueDate:"appeal_due_date" }, ["case_number","subject","description","status"], ["institution_id","status","investigator_user_id"]);
resource("grievance_events", "/grievance-events", "grievances", { grievanceId:"grievance_id", eventType:"event_type", details:"details", documentId:"document_id" }, ["event_type","details"], ["grievance_id"]);
resource("transport_vehicles", "/transport/vehicles", "transport", { institutionId:"institution_id", assetId:"asset_id", registrationNumber:"registration_number", vehicleType:"vehicle_type", makeModel:"make_model", capacity:"capacity", assignedDriverStaffId:"assigned_driver_staff_id", insuranceExpiry:"insurance_expiry", inspectionDue:"inspection_due", status:"status", notes:"notes" }, ["registration_number","vehicle_type","make_model","status"], ["institution_id","status"]);
resource("transport_routes", "/transport/routes", "transport", { institutionId:"institution_id", routeCode:"route_code", routeName:"route_name", origin:"origin", destination:"destination", distanceKm:"distance_km", status:"status", notes:"notes" }, ["route_code","route_name","origin","destination"], ["institution_id","status"]);
resource("transport_trips", "/transport/trips", "transport", { tripNumber:"trip_number", vehicleId:"vehicle_id", routeId:"route_id", driverStaffId:"driver_staff_id", departureAt:"departure_at", returnAt:"return_at", purpose:"purpose", passengerCount:"passenger_count", status:"status", approvedBy:"approved_by", notes:"notes" }, ["trip_number","purpose","status"], ["vehicle_id","route_id","status"]);
resource("transport_maintenance", "/transport/maintenance", "transport", { vehicleId:"vehicle_id", maintenanceType:"maintenance_type", description:"description", serviceProvider:"service_provider", serviceDate:"service_date", nextDueDate:"next_due_date", cost:"cost", status:"status", financeReference:"finance_reference" }, ["maintenance_type","description","service_provider","status"], ["vehicle_id","status"]);
resource("institutional_budgets", "/budgets", "budget", { institutionId:"institution_id", departmentId:"department_id", budgetCode:"budget_code", fiscalYear:"fiscal_year", title:"title", proposedAmount:"proposed_amount", currencyCode:"currency_code", comment:"comment" }, ["budget_code","fiscal_year","title","status"], ["institution_id","department_id","fiscal_year","status"]);
resource("budget_lines", "/budget-lines", "budget", { budgetId:"budget_id", lineCode:"line_code", description:"description", category:"category", proposedAmount:"proposed_amount", approvedAmount:"approved_amount", spentAmount:"spent_amount", notes:"notes" }, ["line_code","description","category"], ["budget_id"]);
resource("institutional_risks", "/risks", "risk", { institutionId:"institution_id", riskCode:"risk_code", title:"title", category:"category", description:"description", probability:"probability", impact:"impact", ownerUserId:"owner_user_id", mitigation:"mitigation", reviewDate:"review_date", status:"status" }, ["risk_code","title","category","description","status"], ["institution_id","status","owner_user_id"]);
resource("strategic_goals", "/strategy/goals", "strategy", { institutionId:"institution_id", goalCode:"goal_code", title:"title", description:"description", ownerDepartmentId:"owner_department_id", startDate:"start_date", targetDate:"target_date", status:"status" }, ["goal_code","title","description","status"], ["institution_id","owner_department_id","status"]);
resource("strategic_kpis", "/strategy/kpis", "strategy", { goalId:"goal_id", kpiCode:"kpi_code", title:"title", unit:"unit", baseline:"baseline", target:"target", actual:"actual", measurementDate:"measurement_date", ownerUserId:"owner_user_id", notes:"notes" }, ["kpi_code","title","unit"], ["goal_id","owner_user_id"]);
resource("management_meetings", "/meetings", "meetings", { institutionId:"institution_id", meetingNumber:"meeting_number", title:"title", meetingType:"meeting_type", startsAt:"starts_at", endsAt:"ends_at", venue:"venue", chairUserId:"chair_user_id", minutes:"minutes", status:"status" }, ["meeting_number","title","meeting_type","status"], ["institution_id","status"]);
resource("meeting_agenda_items", "/meeting-agenda", "meetings", { meetingId:"meeting_id", itemNumber:"item_number", title:"title", presenterUserId:"presenter_user_id", discussionNotes:"discussion_notes", resolution:"resolution" }, ["title","discussion_notes","resolution"], ["meeting_id"], false);
resource("meeting_actions", "/meeting-actions", "meetings", { meetingId:"meeting_id", agendaItemId:"agenda_item_id", actionNumber:"action_number", actionText:"action_text", ownerUserId:"owner_user_id", dueDate:"due_date", status:"status", completionNote:"completion_note" }, ["action_number","action_text","status"], ["meeting_id","owner_user_id","status"]);
resource("accreditation_standards", "/accreditation/standards", "accreditation", { institutionId:"institution_id", standardCode:"standard_code", regulator:"regulator", title:"title", requirement:"requirement", ownerDepartmentId:"owner_department_id", reviewDueDate:"review_due_date", status:"status", notes:"notes" }, ["standard_code","regulator","title","requirement","status"], ["institution_id","owner_department_id","status"]);
resource("accreditation_evidence", "/accreditation/evidence", "accreditation", { standardId:"standard_id", evidenceTitle:"evidence_title", evidenceType:"evidence_type", storagePath:"storage_path", documentId:"document_id", verifiedBy:"verified_by", verifiedAt:"verified_at", expiryDate:"expiry_date", status:"status", notes:"notes" }, ["evidence_title","evidence_type","status"], ["standard_id","status"]);

export default router;
