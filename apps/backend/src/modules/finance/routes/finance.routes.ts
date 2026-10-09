import { Router } from "express";
import * as controller from "../controllers/finance.controller.js";
import { authenticate } from "../../../middleware/auth.js";
import { requirePermission } from "../../../middleware/rbac.js";
import { registerCrudResource } from "../../../utils/resourceCrud.js";
import { getSupabase } from "../../../config/database.js";
import { createAuditLog } from "../../../services/audit.service.js";
import financeWorkflowRoutes from "./finance-workflow.routes.js";

const router = Router();
router.use(authenticate);
router.use("/workflow", financeWorkflowRoutes);

router.get("/programme-tuition", requirePermission("finance.view"), async (_req, res, next) => {
  try {
    const db = getSupabase();
    const [programmesResult, structuresResult] = await Promise.all([
      db.from("programmes").select("id,programme_code,programme_name,programme_type,award_level,duration_years,mode_of_study,tuition_fee,status").order("programme_name"),
      db.from("fee_structures").select("id,fee_structure_name,academic_year,description,status,created_at,fee_items(*)").eq("status", "ACTIVE").order("created_at", { ascending:false }),
    ]);
    if (programmesResult.error) throw programmesResult.error;
    if (structuresResult.error) throw structuresResult.error;
    const structures = structuresResult.data ?? [];
    const feeForLevel = (level: string) => {
      const matching = structures.find((structure: any) => String(structure.description ?? "").toUpperCase().startsWith(level));
      const allStudents = structures.find((structure: any) => /(^|[^A-Z])ALL([^A-Z]|$)/i.test(String(structure.description ?? "")));
      const structure: any = matching ?? allStudents;
      if (!structure) return { amount:null, structureName:null };
      const items = Array.isArray(structure.fee_items) ? structure.fee_items : [];
      const confirmed = items.filter((item: any) => item.amount_confirmed !== false && Number(item.annual_amount ?? item.semester_amount ?? item.amount) > 0);
      const amount = confirmed.reduce((total: number, item: any) => total + Number(item.annual_amount ?? (Number(item.semester_amount ?? item.amount) * 2)), 0);
      return { amount:amount || null, structureName:structure.fee_structure_name };
    };
    const data = (programmesResult.data ?? []).map((programme: any) => {
      const award = String(`${programme.award_level ?? ""} ${programme.programme_type ?? ""}`).toUpperCase();
      const level = award.includes("CERTIFICATE") ? "CERTIFICATE" : award.includes("DIPLOMA") ? "DIPLOMA" : "";
      const structureFee = level ? feeForLevel(level) : { amount:null, structureName:null };
      const manuallySet = programme.tuition_fee !== null && programme.tuition_fee !== undefined;
      return { ...programme, tuition_fee:manuallySet ? programme.tuition_fee : structureFee.amount, fee_source:manuallySet ? "MANUAL" : structureFee.amount == null ? "UNAVAILABLE" : "FEE_STRUCTURE", fee_structure_name:structureFee.structureName };
    });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});
router.patch("/programme-tuition/:id", requirePermission("finance.manage"), async (req, res, next) => {
  try {
    const raw = req.body?.tuitionFee;
    const fee = raw === null || raw === "" ? null : Number(raw);
    if (fee !== null && (!Number.isFinite(fee) || fee < 0)) return res.status(400).json({ success: false, message: "Tuition fee must be a non-negative amount." });
    const { data, error } = await getSupabase().from("programmes").update({ tuition_fee: fee, updated_at: new Date().toISOString() }).eq("id", String(req.params.id ?? "")).select("id,programme_code,programme_name,tuition_fee").single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get("/student-options", requirePermission("finance.charges.view"), async (_req, res, next) => {
  try {
    const { data, error } = await getSupabase().from("students")
      .select("id,student_number,registration_number,first_name,middle_name,last_name,student_status")
      .not("student_status", "in", "(INACTIVE,WITHDRAWN)")
      .order("student_number").limit(5000);
    if (error) throw error;
    res.json({ success: true, data: data ?? [] });
  } catch (error) { next(error); }
});

registerCrudResource(
  router,
  {
    moduleCode: "FINANCE",
    entityType: "fee_structures",
    table: "fee_structures",
    permissionView: "finance.view",
    permissionManage: "finance.manage",
    searchFields: [
      "fee_structure_code",
      "fee_structure_name",
      "academic_year",
      "semester",
      "status",
      "currency_code"
    ],
    filterFields: [
      "academic_year",
      "semester",
      "status",
      "currency_code"
    ],
    defaultOrderField: "created_at",
    fields: {
      feeStructureCode: "fee_structure_code",
      feeStructureName: "fee_structure_name",
      academicYear: "academic_year",
      semester: "semester",
      description: "description",
      status: "status",
      currencyCode: "currency_code",
      effectiveFrom: "effective_from",
      effectiveTo: "effective_to",
      createdBy: "created_by",
      updatedBy: "updated_by"
    }
  },
  "/fee-structures"
);

registerCrudResource(router,{moduleCode:"FINANCE",entityType:"student_charges",table:"student_charges",permissionView:"finance.charges.view",permissionManage:"finance.manage",searchFields:["charge_number","description","academic_year","semester","status"],filterFields:["student_id","fee_structure_id","fee_item_id","status"],defaultOrderField:"charge_date",allowCreate:false,allowUpdate:false,allowDelete:false,fields:{studentId:"student_id",feeStructureId:"fee_structure_id",feeItemId:"fee_item_id",chargeNumber:"charge_number",description:"description",academicYear:"academic_year",semester:"semester",originalAmount:"original_amount",scholarshipAmount:"scholarship_amount",waiverAmount:"waiver_amount",adjustmentAmount:"adjustment_amount",netAmount:"net_amount",status:"status",chargeDate:"charge_date",dueDate:"due_date"}},"/charges");
registerCrudResource(router,{moduleCode:"FINANCE",entityType:"invoices",table:"invoices",permissionView:"finance.invoices.view",permissionManage:"finance.manage",searchFields:["invoice_number","academic_year","semester","status","notes"],filterFields:["student_id","status"],defaultOrderField:"invoice_date",allowCreate:false,allowUpdate:false,allowDelete:false,fields:{studentId:"student_id",invoiceNumber:"invoice_number",invoiceDate:"invoice_date",dueDate:"due_date",academicYear:"academic_year",semester:"semester",subtotal:"subtotal",discountAmount:"discount_amount",scholarshipAmount:"scholarship_amount",adjustmentAmount:"adjustment_amount",totalAmount:"total_amount",amountPaid:"amount_paid",balanceAmount:"balance_amount",status:"status",currencyCode:"currency_code",notes:"notes"}},"/invoices");
router.get("/scholarship-applications", requirePermission("finance.scholarships.view"), async (_req,res,next)=>{try{const db=getSupabase();const [apps,students]=await Promise.all([db.from("scholarship_applications").select("*").order("created_at",{ascending:false}).limit(2000),db.from("students").select("id,student_number,first_name,middle_name,last_name,email").limit(5000)]);if(apps.error)throw apps.error;if(students.error)throw students.error;const byId=new Map((students.data??[]).map((s:any)=>[s.id,s]));res.json({success:true,data:(apps.data??[]).map((a:any)=>{const s:any=byId.get(a.student_id);return {...a,student_number:s?.student_number??"",student_name:s?[s.first_name,s.middle_name,s.last_name].filter(Boolean).join(" "):"",student_email:s?.email??""};})});}catch(error){next(error);}});
router.post("/scholarship-applications/:id/action", requirePermission("finance.manage"), async (req,res,next)=>{try{const db=getSupabase(),id=String(req.params.id),action=String(req.body?.action??"").toUpperCase(),reason=String(req.body?.reason??"").trim().slice(0,2000),now=new Date().toISOString();const current=await db.from("scholarship_applications").select("id,status").eq("id",id).maybeSingle();if(current.error)throw current.error;if(!current.data)return res.status(404).json({success:false,message:"Scholarship application was not found."});let nextStatus="";if(action==="REVIEW"){if(current.data.status!=="SUBMITTED")return res.status(409).json({success:false,message:"Only a submitted scholarship application can enter review."});nextStatus="UNDER_REVIEW";}else if(action==="REJECT"){if(!reason)return res.status(400).json({success:false,message:"Enter a reason for rejecting this scholarship application."});if(!["SUBMITTED","UNDER_REVIEW"].includes(current.data.status))return res.status(409).json({success:false,message:`A ${current.data.status} scholarship application cannot be rejected.`});nextStatus="REJECTED";}else if(action==="LOCK"){if(!["UNDER_REVIEW","APPROVED"].includes(current.data.status))return res.status(409).json({success:false,message:"Only reviewed or approved scholarship applications can be locked."});nextStatus="LOCKED";}else return res.status(400).json({success:false,message:"Choose REVIEW, LOCK or REJECT."});const update=await db.from("scholarship_applications").update({status:nextStatus,decision_notes:reason||String(req.body?.notes??"").trim().slice(0,2000)||null,reviewed_by:req.user?.id,reviewed_at:now,updated_at:now}).eq("id",id).eq("status",current.data.status).select("*").single();if(update.error)throw update.error;res.json({success:true,data:update.data,message:nextStatus==="UNDER_REVIEW"?"Scholarship application entered review.":nextStatus==="LOCKED"?"Scholarship application locked.":"Scholarship application rejected."});}catch(error){next(error);}});
registerCrudResource(router,{moduleCode:"FINANCE",entityType:"student_scholarships",table:"student_scholarships",permissionView:"finance.scholarships.view",permissionManage:"finance.manage",searchFields:["scholarship_code","scholarship_name","sponsor_name","status"],filterFields:["student_id","academic_year","semester","status"],fields:{studentId:"student_id",scholarshipCode:"scholarship_code",scholarshipName:"scholarship_name",sponsorName:"sponsor_name",scholarshipType:"scholarship_type",amount:"amount",percentage:"percentage",academicYear:"academic_year",semester:"semester",startDate:"start_date",endDate:"end_date",status:"status",approvalReference:"approval_reference",notes:"notes"}},"/scholarships");
router.post("/refunds/:id/action", requirePermission("finance.manage"), async (req, res, next) => {
  try {
    const db = getSupabase();
    const actorId = req.user?.id;
    const refundId = String(req.params.id ?? "");
    if (!actorId) return res.status(401).json({ success: false, message: "Authentication is required." });
    const action = String(req.body?.action ?? "").trim().toUpperCase();
    const reason = String(req.body?.reason ?? "").trim().slice(0, 2000);
    const externalReference = String(req.body?.externalReference ?? "").trim().slice(0, 150);
    const current = await db.from("refunds").select("id,status,requested_by,approved_by,metadata").eq("id", refundId).maybeSingle();
    if (current.error) throw current.error;
    if (!current.data) return res.status(404).json({ success: false, message: "Refund request was not found." });

    const now = new Date().toISOString();
    let expectedStatus: string;
    let nextStatus: string;
    const update: Record<string, unknown> = { updated_at: now };
    if (action === "APPROVE" || action === "REJECT") {
      expectedStatus = "REQUESTED";
      nextStatus = action === "APPROVE" ? "APPROVED" : "REJECTED";
      if (!current.data.requested_by || current.data.requested_by === actorId) return res.status(403).json({ success: false, message: "Only a different identified staff member can decide this refund." });
      if (action === "REJECT" && !reason) return res.status(400).json({ success: false, message: "A reason is required to reject a refund." });
      if (action === "APPROVE") { update.approved_by = actorId; update.approved_at = now; }
      if (action === "REJECT") update.metadata = { ...(current.data.metadata && typeof current.data.metadata === "object" ? current.data.metadata : {}), decision_reason: reason, decided_by: actorId, decided_at: now };
    } else if (action === "PROCESS") {
      expectedStatus = "APPROVED"; nextStatus = "PROCESSING";
    } else if (action === "PAY") {
      expectedStatus = "PROCESSING"; nextStatus = "PAID";
      if (!externalReference) return res.status(400).json({ success: false, message: "An external payment reference is required to mark a refund paid." });
      update.processed_by = actorId; update.processed_at = now; update.external_reference = externalReference;
    } else {
      return res.status(400).json({ success: false, message: "Choose APPROVE, REJECT, PROCESS or PAY." });
    }
    if (current.data.status !== expectedStatus) return res.status(409).json({ success: false, message: `A ${current.data.status} refund cannot perform this action.` });
    update.status = nextStatus;
    const saved = await db.from("refunds").update(update).eq("id", refundId).eq("status", expectedStatus).select("id,status,approved_by,approved_at,processed_by,processed_at,external_reference,metadata").maybeSingle();
    if (saved.error) throw saved.error;
    if (!saved.data) return res.status(409).json({ success: false, message: "Refund status changed; reload and try again." });
    await createAuditLog({ actorUserId: actorId, actionCode: `REFUND_${action}`, moduleCode: "FINANCE", entityType: "refund", entityId: refundId, oldValues: { status: expectedStatus }, newValues: { ...saved.data, reason: action === "REJECT" ? reason : undefined }, ipAddress: req.ip, requestId: req.requestId });
    return res.json({ success: true, data: saved.data, message: `Refund ${nextStatus.toLowerCase()}.` });
  } catch (error) { next(error); }
});
registerCrudResource(router,{moduleCode:"FINANCE",entityType:"refunds",table:"refunds",permissionView:"finance.refunds.view",permissionManage:"finance.manage",searchFields:["refund_number","reason","refund_method","status","external_reference"],filterFields:["payment_id","student_id","status"],defaultOrderField:"requested_at",allowCreate:false,allowUpdate:false,allowDelete:false,fields:{paymentId:"payment_id",studentId:"student_id",refundNumber:"refund_number",amount:"amount",reason:"reason",refundMethod:"refund_method",status:"status",requestedAt:"requested_at",externalReference:"external_reference"}},"/refunds");
registerCrudResource(router,{moduleCode:"FINANCE",entityType:"payments",table:"payments",permissionView:"finance.payments.view",permissionManage:"finance.manage",searchFields:["payment_number","external_reference","control_number","receipt_number","status"],filterFields:["student_id","status","payment_method"],defaultOrderField:"payment_date",allowCreate:false,allowUpdate:false,allowDelete:false,fields:{studentId:"student_id",paymentNumber:"payment_number",externalReference:"external_reference",controlNumber:"control_number",paymentMethod:"payment_method",provider:"provider",amount:"amount",currencyCode:"currency_code",paymentDate:"payment_date",status:"status",payerName:"payer_name",payerPhone:"payer_phone",payerEmail:"payer_email",providerTransactionId:"provider_transaction_id",receiptNumber:"receipt_number"}},"/payments");

router.get("/students/:studentId/account", requirePermission("finance.view"), controller.getFinancialAccount);
router.get("/students/:studentId/charges", requirePermission("finance.charges.view"), controller.getCharges);
router.get("/students/:studentId/invoices", requirePermission("finance.invoices.view"), controller.getInvoices);
router.get("/students/:studentId/payments", requirePermission("finance.payments.view"), controller.getPayments);
router.get("/students/:studentId/refunds", requirePermission("finance.refunds.view"), controller.getRefunds);
router.get("/students/:studentId/scholarships", requirePermission("finance.scholarships.view"), controller.getScholarships);
router.get("/students/:studentId/adjustments", requirePermission("finance.charges.view"), controller.getAdjustments);
router.get("/students/:studentId/transactions", requirePermission("finance.view"), controller.getTransactions);

export default router;



