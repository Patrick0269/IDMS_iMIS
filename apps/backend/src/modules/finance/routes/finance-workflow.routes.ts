import { randomUUID } from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import { getSupabase } from "../../../config/database.js";
import { privateDocumentMatchesMime } from "../../../utils/private-document-validation.js";
import { privateStorageObjectPath } from "../../../utils/private-storage-path.js";
import { env } from "../../../config/env.js";
import { requirePermission } from "../../../middleware/rbac.js";

type Row = Record<string, any>;
const router = Router();

function actor(req: Request): string {
  if (!req.user?.id) throw new Error("Authenticated IDMS identity is unavailable.");
  return req.user.id;
}
function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || !value) throw new Error(`Missing route parameter: ${name}.`);
  return value;
}
function text(value: unknown, max = 2000): string | null {
  const clean = String(value ?? "").trim();
  return clean ? clean.slice(0, max) : null;
}
function amount(value: unknown, label = "Amount"): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be greater than zero.`);
  return Math.round(number * 100) / 100;
}
function rows(value: any): Row[] { return Array.isArray(value) ? value : []; }
function code(prefix: string): string {
  return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
}
function handle(action: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try { res.json({ success: true, data: await action(req) }); }
    catch (error) {
      const message = error instanceof Error ? error.message : "Finance workflow failed.";
      res.status(/not found|does not belong/i.test(message) ? 404 : 400).json({ success: false, message });
    }
  };
}
function userName(user: Row | undefined): string {
  if (!user) return "—";
  return user.display_name || [user.first_name, user.middle_name, user.last_name].filter(Boolean).join(" ") || user.user_number || "—";
}
async function userMap(ids: Array<string | null | undefined>): Promise<Map<string, Row>> {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const result = await getSupabase().from("users").select("id,user_number,display_name,first_name,middle_name,last_name,email").in("id", unique);
  if (result.error) throw result.error;
  return new Map(rows(result.data).map(item => [String(item.id), item]));
}
async function ownStudent(req: Request): Promise<Row> {
  const result = await getSupabase().from("students").select("*").eq("user_id", actor(req)).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw new Error("Authenticated account is not linked to a student record.");
  return result.data;
}
async function history(entityType: string, entityId: string, action: string, previous: string | null, next: string, by: string, comment?: string | null) {
  const result = await getSupabase().from("finance_workflow_history").insert({ entity_type: entityType, entity_id: entityId, action, previous_status: previous, new_status: next, performed_by: by, comment: comment ?? null });
  if (result.error) throw result.error;
}

async function financeInstitutionId(): Promise<string> {
  const result = await getSupabase().from("institutions").select("id").limit(1).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data?.id) throw new Error("Institution record is not configured.");
  return result.data.id;
}
async function paymentSettings(): Promise<Row> {
  const institutionId = await financeInstitutionId();
  const result = await getSupabase().from("system_settings").select("id,setting_value,is_editable,updated_at").eq("institution_id", institutionId).eq("setting_key", "FINANCE_PAYMENT_INSTRUCTIONS").maybeSingle();
  if (result.error) throw result.error;
  return result.data ?? { id: null, setting_value: { bankName: "NMB International Bank", accountName: "International Institute of Development and Medical Sciences", controlNumber: "52010004227", locked: false } };
}

router.get("/payment-settings", requirePermission("finance.portal.view"), handle(async () => paymentSettings()));
router.put("/payment-settings", requirePermission("finance.payments.confirm"), handle(async req => {
  const db = getSupabase(), by = actor(req), institutionId = await financeInstitutionId(), current = await paymentSettings();
  const old = current.setting_value || {};
  if (old.locked) throw new Error("Finance payment instructions are locked. A user with Finance management permission must unlock them first.");
  const bankName = text(req.body?.bankName,150), accountName = text(req.body?.accountName,200), controlNumber = text(req.body?.controlNumber,100);
  if (!bankName || !accountName || !controlNumber) throw new Error("Bank, account name and control number are required.");
  const value = { bankName, accountName, controlNumber, locked: req.body?.lock === true };
  const result = await db.from("system_settings").upsert({ institution_id: institutionId, setting_key: "FINANCE_PAYMENT_INSTRUCTIONS", setting_name: "Finance Payment Instructions", value_type: "JSON", setting_value: value, is_sensitive: false, is_editable: !value.locked, description: "Official student fee payment instructions controlled by Finance.", updated_by: by }, { onConflict: "institution_id,setting_key" }).select("id,setting_value,is_editable,updated_at").single();
  if (result.error) throw result.error;
  return result.data;
}));
router.post("/payment-settings/unlock", requirePermission("finance.manage"), handle(async () => {
  const db = getSupabase(), institutionId = await financeInstitutionId(), current = await paymentSettings(), value = { ...(current.setting_value || {}), locked: false };
  if (!current.id) throw new Error("Save payment instructions before unlocking them.");
  const result = await db.from("system_settings").update({ setting_value: value, is_editable: true, updated_at: new Date().toISOString() }).eq("id", current.id).eq("institution_id", institutionId).select("id,setting_value,is_editable,updated_at").single();
  if (result.error) throw result.error;
  return result.data;
}));

async function financeStudents(query = ""): Promise<Row[]> {
  const db = getSupabase();
  let studentQuery: any = db.from("students").select("id,student_number,first_name,middle_name,last_name,email,phone,student_status,programme_id,admission_year").order("student_number").limit(1000);
  const q = query.trim();
  if (q) studentQuery = studentQuery.or(`student_number.ilike.%${q.replace(/[,%()]/g, "")}%,first_name.ilike.%${q.replace(/[,%()]/g, "")}%,last_name.ilike.%${q.replace(/[,%()]/g, "")}%`);
  const students = await studentQuery;
  if (students.error) throw students.error;
  const list = rows(students.data);
  const ids = list.map(item => item.id);
  const programmeIds = [...new Set(list.map(item => item.programme_id).filter(Boolean))];
  const accounts = ids.length ? await db.from("student_financial_accounts").select("*").in("student_id", ids) : { data: [], error: null };
  const programmes = programmeIds.length ? await db.from("programmes").select("id,programme_code,programme_name").in("id", programmeIds) : { data: [], error: null };
  if (accounts.error) throw accounts.error;
  if (programmes.error) throw programmes.error;
  const accountMap = new Map(rows(accounts.data).map(item => [item.student_id, item]));
  const programmeMap = new Map(rows(programmes.data).map(item => [item.id, item]));
  return list.map(item => ({ ...item, full_name: [item.first_name,item.middle_name,item.last_name].filter(Boolean).join(" "), programme: programmeMap.get(item.programme_id) ?? null, account: accountMap.get(item.id) ?? null }));
}

async function studentBundle(studentId: string): Promise<Row> {
  const db = getSupabase();
  const student = await db.from("students").select("*").eq("id", studentId).maybeSingle();
  if (student.error) throw student.error;
  if (!student.data) throw new Error("Student was not found.");
  const [account, charges, invoices, payments, requests, assignments, registrations] = await Promise.all([
    db.from("student_financial_accounts").select("*").eq("student_id", studentId).maybeSingle(),
    db.from("student_charges").select("*").eq("student_id", studentId).order("charge_date", { ascending: false }),
    db.from("invoices").select("*").eq("student_id", studentId).order("invoice_date", { ascending: false }),
    db.from("payments").select("*").eq("student_id", studentId).order("payment_date", { ascending: false }),
    db.from("student_payment_requests").select("*").eq("student_id", studentId).order("requested_at", { ascending: false }),
    db.from("student_fee_structure_assignments").select("*").eq("student_id", studentId).order("assigned_at", { ascending: false }),
    db.from("student_registrations").select("registration_number,academic_year_id,semester_id,created_at").eq("student_id", studentId).order("created_at", { ascending: false }).limit(1),
  ]);
  for (const result of [account, charges, invoices, payments, requests, assignments, registrations]) if (result.error) throw result.error;
  const invoiceIds = rows(invoices.data).map(item => item.id).filter(Boolean);
  const paymentIds = rows(payments.data).map(item => item.id).filter(Boolean);
  const [invoiceItems, paymentAllocations] = await Promise.all([
    invoiceIds.length ? db.from("invoice_items").select("*").in("invoice_id", invoiceIds).order("created_at") : Promise.resolve({ data: [], error: null }),
    paymentIds.length ? db.from("payment_allocations").select("*").in("payment_id", paymentIds).eq("status", "ACTIVE") : Promise.resolve({ data: [], error: null }),
  ]);
  for (const result of [invoiceItems, paymentAllocations]) if (result.error) throw result.error;
  const confirms = await userMap(rows(payments.data).map(item => item.confirmed_by));
  return { student: student.data, account: account.data, registration: rows(registrations.data)[0] ?? null, charges: charges.data ?? [], invoices: invoices.data ?? [], invoice_items: invoiceItems.data ?? [], payments: rows(payments.data).map(item => ({ ...item, confirmed_by_name: userName(confirms.get(String(item.confirmed_by))) })), payment_allocations: paymentAllocations.data ?? [], payment_requests: requests.data ?? [], assignments: assignments.data ?? [] };
}

async function assignStructure(studentId: string, feeStructureId: string, semester: string, by: string): Promise<Row> {
  const db = getSupabase();
  const structure = await db.from("fee_structures").select("id,semester").eq("id", feeStructureId).eq("status", "ACTIVE").maybeSingle();
  if (structure.error) throw structure.error;
  if (!structure.data) throw new Error("Published fee structure was not found.");
  const selectedSemester = structure.data.semester || semester;
  if (semester && structure.data.semester && semester !== structure.data.semester) throw new Error("Selected semester does not match the published fee structure.");
  const result = await db.rpc("idmc_invoice_from_structure", {
    p_student: studentId, p_structure: feeStructureId, p_semester: selectedSemester, p_actor: by,
  });
  if (result.error) throw result.error;
  return result.data as Row;
}

router.get("/catalog", requirePermission("finance.portal.view"), handle(async () => {
  const result = await getSupabase().from("institutional_fee_catalog").select("*").eq("status", "ACTIVE").order("display_order");
  if (result.error) throw result.error;
  return result.data ?? [];
}));

router.get("/fee-structures/published", requirePermission("finance.portal.view"), handle(async () => {
  const result = await getSupabase().from("fee_structures").select("*,fee_items(*)").eq("status", "ACTIVE").order("published_at", { ascending: false });
  if (result.error) throw result.error;
  return result.data ?? [];
}));

router.get("/students", requirePermission("finance.portal.view"), handle(req => financeStudents(String(req.query.q ?? ""))));
router.get("/students/:studentId", requirePermission("finance.portal.view"), handle(req => studentBundle(param(req,"studentId"))));

router.post("/fee-structures/publish", requirePermission("finance.fees.publish"), handle(async req => {
  const db = getSupabase(); const by = actor(req);
  const academicYear = text(req.body?.academicYear, 20); const semester = text(req.body?.semester, 50) || "SEMESTER 1";
  const structureName = text(req.body?.name, 200); const programmeLevel = text(req.body?.programmeLevel, 50) || "ALL";
  const inputItems = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!academicYear || !structureName) throw new Error("Academic year and fee structure name are required.");
  const selectedItems = inputItems.map((item: Row, index: number) => ({ fee_item_code: text(item.code,100), fee_item_name: text(item.name,200), category: text(item.category,50) || "OTHER", amount: Number(item.semesterAmount || 0), semester_amount: Number(item.semesterAmount || 0), annual_amount: Number(item.annualAmount || Number(item.semesterAmount || 0)*2), first_installment_amount: item.firstInstallmentAmount == null || item.firstInstallmentAmount === "" ? null : Number(item.firstInstallmentAmount), amount_confirmed: Boolean(item.confirmed), is_mandatory: item.mandatory !== false, display_order: index+1 })).filter((item: Row) => item.fee_item_code && item.fee_item_name && item.amount_confirmed && item.amount > 0);
  if (!selectedItems.length) throw new Error("Enter and confirm at least one fee item amount before publishing.");
  if (selectedItems.some((item: Row) => item.first_installment_amount != null && (!Number.isFinite(item.first_installment_amount) || item.first_installment_amount < 0 || item.first_installment_amount > item.semester_amount))) throw new Error("Each fee item first installment must be zero or no greater than that item's semester amount.");
  const structureCode = code(`FEE-${programmeLevel.replace(/[^A-Z0-9]/gi, "").toUpperCase() || "ALL"}`);
  const totalSemester = selectedItems.reduce((sum: number,item: Row) => sum+item.semester_amount,0);
  const totalAnnual = selectedItems.reduce((sum: number,item: Row) => sum+item.annual_amount,0);
  const itemFirstInstallments = selectedItems.reduce((sum: number, item: Row) => sum + Number(item.first_installment_amount || 0), 0);
  const firstInstallmentAmount = req.body?.firstInstallmentAmount === "" || req.body?.firstInstallmentAmount == null ? (itemFirstInstallments || null) : Number(req.body.firstInstallmentAmount);
  if (firstInstallmentAmount != null && (!Number.isFinite(firstInstallmentAmount) || firstInstallmentAmount < 0 || firstInstallmentAmount > totalSemester)) throw new Error("First installment must be zero or between zero and the confirmed semester total.");
  const structure = await db.from("fee_structures").insert({ fee_structure_code: structureCode, fee_structure_name: structureName, academic_year: academicYear, semester, first_installment_amount: firstInstallmentAmount, description: `${programmeLevel} | Semester ${totalSemester} | Annual ${totalAnnual}`, status: "ACTIVE", currency_code: "TZS", billing_frequency: "SEMESTER", semesters_per_year: 2, effective_from: new Date().toISOString().slice(0,10), published_by: by, published_at: new Date().toISOString(), created_by: by, updated_by: by }).select().single();
  if (structure.error) throw structure.error;
  const items = await db.from("fee_items").insert(selectedItems.map((item: Row) => ({ ...item, fee_structure_id: structure.data.id }))).select();
  if (items.error) throw items.error;
  let assigned = 0; const failures: Row[] = [];
  if (req.body?.applyToAll === true) {
    const students = await db.from("students").select("id,student_number").eq("student_status", "ACTIVE").limit(5000);
    if (students.error) throw students.error;
    for (const student of rows(students.data)) {
      try { await assignStructure(student.id, structure.data.id, semester, by); assigned += 1; }
      catch (error) { failures.push({ student_number: student.student_number, message: error instanceof Error ? error.message : "Failed" }); }
    }
  }
  return { fee_structure: structure.data, fee_items: items.data, totals: { semester: totalSemester, annual: totalAnnual }, assigned_students: assigned, failures };
}));

router.post("/students/:studentId/generate-invoice", requirePermission("finance.fees.publish"), handle(req => {
  const structureId = text(req.body?.feeStructureId,80); const semester = text(req.body?.semester,50) || "SEMESTER 1";
  if (!structureId) throw new Error("Fee structure is required.");
  return assignStructure(param(req,"studentId"), structureId, semester, actor(req));
}));

async function recordPayment(studentId: string, invoiceId: string, inputAmount: number, method: string, reference: string | null, by: string, controlNumber?: string | null): Promise<Row> {
  const db = getSupabase();
  const instructions = await paymentSettings(), paymentInfo = instructions.setting_value || {};
  const invoice = await db.from("invoices").select("*").eq("id", invoiceId).eq("student_id", studentId).maybeSingle();
  if (invoice.error || !invoice.data) throw new Error("Invoice does not belong to the selected student.");
  const balance = Number(invoice.data.balance_amount || 0);
  if (balance <= 0) throw new Error("Invoice is already fully paid.");
  if (inputAmount > balance) throw new Error(`Payment cannot exceed the invoice balance of TZS ${balance.toLocaleString("en-TZ")}.`);
  const payment = await db.from("payments").insert({ student_id: studentId, payment_number: code("PAY"), external_reference: reference, control_number: controlNumber || paymentInfo.controlNumber || null, payment_method: method, provider: method === "CONTROL_NUMBER" ? "IDMC_CONTROL_NUMBER" : "MANUAL_FINANCE", amount: inputAmount, currency_code: "TZS", payment_date: new Date().toISOString(), status: "CONFIRMED", confirmed_by: by, confirmed_at: new Date().toISOString(), created_by: by, updated_by: by }).select().single();
  if (payment.error) throw payment.error;
  const allocation = await db.from("payment_allocations").insert({ payment_id: payment.data.id, invoice_id: invoiceId, allocated_amount: inputAmount, allocation_reference: code("ALLOC"), status: "ACTIVE", created_by: by }).select().single();
  if (allocation.error) throw allocation.error;
  const invoiceRefresh = await db.rpc("refresh_invoice_financials", { p_invoice_id: invoiceId }); if (invoiceRefresh.error) throw invoiceRefresh.error;
  const accountRefresh = await db.rpc("refresh_student_financial_account", { p_student_id: studentId }); if (accountRefresh.error) throw accountRefresh.error;
  return { payment: payment.data, allocation: allocation.data };
}

router.post("/students/:studentId/payments", requirePermission("finance.payments.confirm"), handle(async req => {
  const invoiceId = text(req.body?.invoiceId,80); if (!invoiceId) throw new Error("Invoice is required.");
  return recordPayment(param(req,"studentId"), invoiceId, amount(req.body?.amount), String(req.body?.paymentMethod || "BANK").toUpperCase(), text(req.body?.reference,150), actor(req), text(req.body?.controlNumber,100));
}));

router.post("/students/:studentId/manual-invoice-payment", requirePermission("finance.payments.confirm"), handle(async req => {
  const db = getSupabase(), studentId = param(req,"studentId"), by = actor(req);
  const invoiceAmount = amount(req.body?.invoiceAmount,"Invoice amount"), paidAmount = amount(req.body?.amount,"Payment amount");
  if (paidAmount > invoiceAmount) throw new Error("Payment cannot exceed the manually entered invoice amount.");
  const description = text(req.body?.description,255), academicYear = text(req.body?.academicYear,20), semester = text(req.body?.semester,50);
  if (!description || !academicYear || !semester) throw new Error("Description, academic year and semester are required.");
  const student = await db.from("students").select("id").eq("id",studentId).maybeSingle(); if (student.error) throw student.error; if (!student.data) throw new Error("Student was not found.");
  const settings = await paymentSettings(), instructions = settings.setting_value || {};
  const invoice = await db.from("invoices").insert({ student_id:studentId, invoice_number:code("INV"), invoice_date:new Date().toISOString().slice(0,10), academic_year:academicYear, semester, subtotal:invoiceAmount, total_amount:invoiceAmount, amount_paid:0, balance_amount:invoiceAmount, status:"ISSUED", currency_code:"TZS", control_number:text(req.body?.controlNumber,100) || instructions.controlNumber || null, control_institution_name:instructions.accountName || null, issued_by:by, issued_at:new Date().toISOString(), created_by:by, notes:"Manually entered by Finance: " + description }).select().single();
  if (invoice.error) throw invoice.error;
  const item = await db.from("invoice_items").insert({ invoice_id:invoice.data.id, description, quantity:1, unit_amount:invoiceAmount, discount_amount:0 });
  if (item.error) throw item.error;
  const recorded = await recordPayment(studentId,invoice.data.id,paidAmount,String(req.body?.paymentMethod||"BANK").toUpperCase(),text(req.body?.reference,150),by,text(req.body?.controlNumber,100));
  return { invoice:invoice.data,...recorded };
}));

router.get("/payment-requests", requirePermission("finance.portal.view"), handle(async () => {
  const db = getSupabase();
  const result = await db.from("student_payment_requests").select("*").order("requested_at", { ascending: false }).limit(1000);
  if (result.error) throw result.error;
  const requests = rows(result.data); const studentIds = [...new Set(requests.map(item => item.student_id))];
  const students = studentIds.length ? await db.from("students").select("id,student_number,first_name,middle_name,last_name").in("id", studentIds) : { data: [], error: null };
  if (students.error) throw students.error;
  const map = new Map(rows(students.data).map(item => [item.id,item]));
  return requests.map(item => ({ ...item, student: map.get(item.student_id) ?? null }));
}));

router.post("/payment-requests/:id/control-number", requirePermission("finance.payments.confirm"), handle(async req => {
  const db = getSupabase(); const by = actor(req); const id=param(req,"id");
  const current = await db.from("student_payment_requests").select("*").eq("id",id).maybeSingle();
  if (current.error || !current.data) throw new Error("Payment request was not found.");
  if (!["PENDING_PROVIDER","FAILED"].includes(current.data.request_status)) throw new Error("Control number can only be issued for a pending request.");
  const controlNumber = text(req.body?.controlNumber,100) || `IDMS${Date.now()}${Math.floor(Math.random()*900+100)}`;
  const updated = await db.from("student_payment_requests").update({ control_number: controlNumber, provider_reference: code("CN"), request_status: "ISSUED", provider_message: "Control number issued by the Finance Office.", issued_at: new Date().toISOString(), reviewed_by: by, reviewed_at: new Date().toISOString(), finance_notes: text(req.body?.notes,2000), updated_at: new Date().toISOString() }).eq("id",id).select().single();
  if (updated.error) throw updated.error;
  await history("PAYMENT_REQUEST",id,"ISSUE_CONTROL_NUMBER",current.data.request_status,"ISSUED",by,text(req.body?.notes,2000));
  return updated.data;
}));

router.post("/student/payment-requests/:id/receipt", requirePermission("students.payments.upload_receipt"), express.raw({ type: "application/octet-stream", limit: "6mb" }), handle(async req => {
  const db = getSupabase(); const student = await ownStudent(req); const body = req.body as Buffer; const id=param(req,"id");
  const request = await db.from("student_payment_requests").select("*").eq("id",id).eq("student_id",student.id).maybeSingle();
  if (request.error || !request.data) throw new Error("Payment request does not belong to the authenticated student.");
  if (!["ISSUED","REJECTED"].includes(request.data.request_status)) throw new Error("Receipt can only be uploaded for an issued or rejected payment request.");
  const fileName = text(req.headers["x-file-name"],255)?.replace(/[^a-zA-Z0-9._-]/g,"_");
  const mime = text(req.headers["x-mime-type"],100) || "application/octet-stream";
  if (!Buffer.isBuffer(body) || !body.length || !fileName) throw new Error("Receipt file is required.");
  if (!["application/pdf","image/jpeg","image/png","image/webp"].includes(mime)) throw new Error("Only PDF, JPG, PNG and WEBP receipts are accepted.");
  if (!privateDocumentMatchesMime(body, mime)) throw Object.assign(new Error("Receipt contents do not match the selected file type."), { statusCode: 400 });
  const path = `finance/receipts/${student.id}/${Date.now()}-${randomUUID().slice(0,8)}-${fileName}`;
  const upload = await db.storage.from("idmc-private-documents").upload(path,body,{contentType:mime,upsert:false}); if (upload.error) throw upload.error;
  const updated = await db.from("student_payment_requests").update({ receipt_file_path:path, receipt_file_name:fileName, receipt_mime_type:mime, receipt_uploaded_at:new Date().toISOString(), receipt_uploaded_by:actor(req), request_status:"RECEIPT_UPLOADED", provider_message:"Receipt uploaded; awaiting Finance confirmation.", updated_at:new Date().toISOString() }).eq("id",id).select().single();
  if (updated.error) { await db.storage.from("idmc-private-documents").remove([path]); throw updated.error; }
  await history("PAYMENT_REQUEST",id,"UPLOAD_RECEIPT",request.data.request_status,"RECEIPT_UPLOADED",actor(req),null);
  return updated.data;
}));

router.get("/payment-requests/:id/receipt", requirePermission("finance.portal.view"), handle(async req => {
  const request = await getSupabase().from("student_payment_requests").select("student_id,receipt_file_path,receipt_file_name").eq("id",param(req,"id")).maybeSingle();
  if (request.error || !request.data?.receipt_file_path) throw new Error("Receipt was not found.");
  const path = privateStorageObjectPath(request.data.receipt_file_path, env.LEGACY_STORAGE_ORIGIN || "https://local.invalid", `finance/receipts/${request.data.student_id}/`);
  if (!path) throw Object.assign(new Error("Receipt was not found."), { statusCode: 404 });
  const signed = await getSupabase().storage.from("idmc-private-documents").createSignedUrl(path,300);
  if (signed.error) throw signed.error;
  return { url:signed.data.signedUrl,file_name:request.data.receipt_file_name,expires_in:300 };
}));

router.post("/payments/:id/deduct", requirePermission("finance.payments.confirm"), handle(async req => {
  const invoiceId = text(req.body?.invoiceId,80);
  if (!invoiceId) throw new Error("Invoice is required.");
  const result = await getSupabase().rpc("idmc_deduct_confirmed_payment", {p_payment:param(req,"id"),p_invoice:invoiceId,p_actor:actor(req)});
  if (result.error) throw new Error(result.error.code === "PGRST202" ? "Apply the Admissions and Finance workflow SQL migration before deducting payments." : result.error.message);
  return result.data;
}));
router.post("/payment-requests/:id/confirm", requirePermission("finance.payments.confirm"), handle(async req => {
  const reference = text(req.body?.reference,150), notes = text(req.body?.notes,2000);
  if (!reference || !notes) throw new Error("Verified bank reference and Finance verification note are required.");
  const result = await getSupabase().rpc("idmc_confirm_receipt_payment", {p_request:param(req,"id"),p_reference:reference,p_notes:notes,p_actor:actor(req)});
  if (result.error) throw new Error(result.error.code === "PGRST202" ? "Apply the Admissions and Finance workflow SQL migration before confirming receipts." : result.error.message);
  return result.data;
}));

router.get("/student/dashboard", requirePermission("students.self.view"), handle(async req => {
  const student = await ownStudent(req); const bundle = await studentBundle(student.id);
  const db = getSupabase();
  const structures = await db.from("fee_structures").select("*,fee_items(*)").eq("status","ACTIVE").order("published_at",{ascending:false});
  if (structures.error) throw structures.error;
  const invoiceIds = rows(bundle.invoices).map(item => item.id).filter(Boolean);
  const paymentIds = rows(bundle.payments).map(item => item.id).filter(Boolean);
  const [invoiceItems, allocations] = await Promise.all([
    invoiceIds.length ? db.from("invoice_items").select("*").in("invoice_id", invoiceIds).order("created_at") : Promise.resolve({ data: [], error: null }),
    paymentIds.length ? db.from("payment_allocations").select("*").in("payment_id", paymentIds).eq("status", "ACTIVE") : Promise.resolve({ data: [], error: null }),
  ]);
  if (invoiceItems.error) throw invoiceItems.error;
  if (allocations.error) throw allocations.error;
  const instructions = await paymentSettings();
  return {...bundle,fee_structures:structures.data??[],invoice_items:invoiceItems.data??[],payment_allocations:allocations.data??[],payment_instructions:instructions.setting_value??null};
}));

router.get("/expenses", requirePermission("finance.portal.view"), handle(async () => {
  const db=getSupabase(); const result=await db.from("finance_expense_requests").select("*,finance_expense_participants(*)").order("created_at",{ascending:false}); if(result.error) throw result.error;
  const items=rows(result.data); const map=await userMap(items.flatMap(item=>[item.requested_by,item.finance_reviewed_by,item.approved_by,item.paid_by]));
  return items.map(item=>({...item,requested_by_name:userName(map.get(String(item.requested_by))),finance_reviewed_by_name:userName(map.get(String(item.finance_reviewed_by))),approved_by_name:userName(map.get(String(item.approved_by))),paid_by_name:userName(map.get(String(item.paid_by)))}));
}));

router.get("/staff/expenses", requirePermission("staff.finance.request_own"), handle(async req => {
  const result=await getSupabase().from("finance_expense_requests").select("*,finance_expense_participants(*)").eq("requested_by",actor(req)).order("created_at",{ascending:false});
  if(result.error)throw result.error;
  return result.data??[];
}));

router.post("/staff/expenses", requirePermission("staff.finance.request_own"), handle(async req => {
  const db=getSupabase(); const by=actor(req); const type=String(req.body?.expenseType||"").toUpperCase();
  if(!["PURCHASE","MEETING_ALLOWANCE","TRAVEL","OPERATIONS","OTHER"].includes(type)) throw new Error("Select a valid expense type.");
  const title=text(req.body?.title,200); const description=text(req.body?.description,4000); if(!title||!description) throw new Error("Title and description are required.");
  const created=await db.from("finance_expense_requests").insert({request_number:code("EXP"),requested_by:by,expense_type:type,title,description,amount:amount(req.body?.amount),meeting_date:text(req.body?.meetingDate,10),status:"SUBMITTED"}).select().single(); if(created.error) throw created.error;
  const participants=Array.isArray(req.body?.participants)?req.body.participants:[];
  if(type==="MEETING_ALLOWANCE"&&participants.length){const insert=await db.from("finance_expense_participants").insert(participants.map((item:Row)=>({expense_request_id:created.data.id,staff_id:text(item.staffId,80),participant_name:text(item.name,200)||"Staff",allowance_amount:Number(item.amount||0)})));if(insert.error)throw insert.error;}
  await history("EXPENSE_REQUEST",created.data.id,"SUBMIT",null,"SUBMITTED",by,null); return created.data;
}));

router.patch("/expenses/:id/review", requirePermission("finance.expenses.review"), handle(async req => {
  const db=getSupabase(); const by=actor(req); const id=param(req,"id"); const current=await db.from("finance_expense_requests").select("*").eq("id",id).maybeSingle(); if(current.error||!current.data)throw new Error("Expense request was not found."); if(current.data.status!=="SUBMITTED")throw new Error("Only submitted requests can receive Finance review.");
  const next=req.body?.approve===false?"REJECTED":"FINANCE_REVIEWED"; const updated=await db.from("finance_expense_requests").update({status:next,finance_reviewed_by:by,finance_reviewed_at:new Date().toISOString(),finance_comment:text(req.body?.comment,2000),updated_at:new Date().toISOString()}).eq("id",id).select().single();if(updated.error)throw updated.error;await history("EXPENSE_REQUEST",id,"FINANCE_REVIEW",current.data.status,next,by,text(req.body?.comment,2000));return updated.data;
}));

router.patch("/expenses/:id/approve", requirePermission("finance.expenses.approve"), handle(async req => {
  const db=getSupabase();const by=actor(req);const id=param(req,"id");const current=await db.from("finance_expense_requests").select("*").eq("id",id).maybeSingle();if(current.error||!current.data)throw new Error("Expense request was not found.");if(current.data.status!=="FINANCE_REVIEWED")throw new Error("Principal approval requires Finance review first.");const next=req.body?.approve===false?"REJECTED":"PRINCIPAL_APPROVED";const updated=await db.from("finance_expense_requests").update({status:next,approved_by:by,approved_at:new Date().toISOString(),approval_comment:text(req.body?.comment,2000),updated_at:new Date().toISOString()}).eq("id",id).select().single();if(updated.error)throw updated.error;if(next==="PRINCIPAL_APPROVED"){const participants=await db.from("finance_expense_participants").update({payment_status:"APPROVED"}).eq("expense_request_id",id).eq("payment_status","PENDING");if(participants.error)throw participants.error;}await history("EXPENSE_REQUEST",id,"PRINCIPAL_APPROVAL",current.data.status,next,by,text(req.body?.comment,2000));return updated.data;
}));

router.patch("/expenses/:id/pay", requirePermission("finance.expenses.pay"), handle(async req => {
  const db=getSupabase();const by=actor(req);const id=param(req,"id");const current=await db.from("finance_expense_requests").select("*").eq("id",id).maybeSingle();if(current.error||!current.data)throw new Error("Expense request was not found.");if(current.data.status!=="PRINCIPAL_APPROVED")throw new Error("Only Principal-approved expenses can be paid.");const reference=text(req.body?.reference,150);if(!reference)throw new Error("Payment reference is required.");const updated=await db.from("finance_expense_requests").update({status:"PAID",paid_by:by,paid_at:new Date().toISOString(),payment_reference:reference,updated_at:new Date().toISOString()}).eq("id",id).select().single();if(updated.error)throw updated.error;await db.from("finance_expense_participants").update({payment_status:"PAID",payment_reference:reference,paid_at:new Date().toISOString()}).eq("expense_request_id",id).eq("payment_status","APPROVED");await history("EXPENSE_REQUEST",id,"PAY",current.data.status,"PAID",by,reference);return updated.data;
}));

export default router;
