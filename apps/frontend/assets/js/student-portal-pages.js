(function () {
  "use strict";
  const config = window.IDMC_STUDENT_PAGE || {}, view = String(config.view || "");
  const $ = id => document.getElementById(id);
  const val = (v, fallback = "—") => v === null || v === undefined || v === "" ? fallback : String(v);
  const esc = v => val(v, "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const unwrap = r => r && Object.prototype.hasOwnProperty.call(r, "data") ? r.data : r;
  const badge = s => `<span class="portal-badge ${/(PUBLISH|PASS|PAID|REGISTER|ACTIVE|APPROV)/i.test(s || "") ? "success" : /(FAIL|REJECT|CANCEL|ABSENT)/i.test(s || "") ? "danger" : "warning"}">${esc(val(s))}</span>`;
  const money = n => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function table(columns, records) {
    if (!records.length) return `<div class="portal-empty"><strong>No records found</strong></div>`;
    return `<div class="portal-table-wrap"><table class="portal-table"><thead><tr>${columns.map(c => `<th>${esc(c[0])}</th>`).join("")}</tr></thead><tbody>${records.map(r => `<tr>${columns.map(c => `<td data-label="${esc(c[0])}">${c[2] ? c[1](r) : esc(val(c[1](r)))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  const summary = cards => `<div class="portal-summary">${cards.map(c => `<div class="portal-stat"><div class="portal-stat-label">${esc(c[0])}</div><div class="portal-stat-value">${esc(val(c[1]))}</div></div>`).join("")}</div>`;
  const setContent = html => { $("portalContent").innerHTML = html; };
  async function action(fn, message) { try { await fn(); alert(message); await loadView(); } catch (e) { alert(e.message || "Action failed."); } }

  async function identity() {
    const s = unwrap(await IDMCAPI.get("/students/me")) || {};
    const name = s.full_name || [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(" ") || "Student";
    [["currentUser", name], ["studentName", name], ["studentNumber", s.student_number || s.registration_number], ["studentProgramme", [s.programme_code, s.programme_name].filter(Boolean).join(" — ") || s.programme_id]].forEach(([id, v]) => { if ($(id)) $(id).textContent = val(v); });
  }

  async function registration() {
    const d = unwrap(await IDMCAPI.get("/self-service/student/registration")), current = d.current_registration || {};
    const courses = new Map((d.courses || []).map(x => [x.id, x]));
    const selectedRows = (d.selected_courses || []).filter(x => !["DROPPED", "REJECTED", "CANCELLED"].includes(x.registration_status));
    const selected = new Set(selectedRows.map(x => x.course_id));
    const offerings = d.offerings || [];
    const context = d.registration_context || {}, curriculum = new Map(offerings.map(o => [o.course_id, o]));
    const creditProgress = `${current.total_registered_credits || 0} / ${current.maximum_credits || context.maximum_credits || "—"}`;
    const registrationStatus = String(current.registration_status || "").toUpperCase();
    const canSubmit = ["DRAFT", "ELIGIBLE"].includes(registrationStatus);
    const academicPeriod = [context.academic_year?.year_code || context.academic_year?.year_name, context.semester?.semester_name || context.semester?.semester_code].filter(Boolean).join(" · ");
    setContent(`<section class="registration-overview"><div class="registration-overview__heading"><span>ACADEMIC RECORD</span><h2>${esc(academicPeriod || "Current semester")}</h2><p>${esc(context.programme?.programme_name || context.programme?.programme_code || "Programme not linked")}</p></div><div class="registration-overview__details"><div><small>Registration status</small>${badge(current.registration_status || "NO REGISTRATION")}</div><div><small>Credits registered / maximum</small><strong>${esc(creditProgress)}</strong></div><div><small>Course selection</small><strong>Select an eligible course to register it automatically</strong></div></div></section>` +
      `${canSubmit ? `<div class="portal-actions"><button class="portal-button" id="submitRegistration">Submit Registration</button></div>` : ""}<h3>Curriculum Courses Available for Selection</h3>` +
      table([["Course", r => `${courses.get(r.course_id)?.course_code || r.offering_code} — ${courses.get(r.course_id)?.course_name || ""}`], ["Category", r => r.course_category || courses.get(r.course_id)?.course_type], ["Class", r => `Year ${r.year_number || 1}, Semester ${r.semester_number || 1}`], ["Credits", r => r.credit_units ?? courses.get(r.course_id)?.credit_units], ["Requirement", r => r.is_compulsory ? "Compulsory" : "Elective"], ["Eligibility", r => r.is_cross_cutting ? badge("CROSS-CUTTING") : badge("PROGRAMME COURSE"), true], ["Action", r => selected.has(r.course_id) ? (selectedRows.find(x => x.course_id === r.course_id)?.registration_status === "REGISTERED" ? badge("REGISTERED") : "Already selected") : r.status === "OPEN" ? `<button class="portal-button select-course" data-id="${esc(r.id)}">Register</button>` : "Registration closed", true]], offerings) +
      `<h3>My Registered Curriculum Courses</h3>` + table([["Code", r => courses.get(r.course_id)?.course_code], ["Course", r => courses.get(r.course_id)?.course_name], ["Category", r => curriculum.get(r.course_id)?.course_category || courses.get(r.course_id)?.course_type], ["Class", r => `Year ${curriculum.get(r.course_id)?.year_number || "—"}, Semester ${curriculum.get(r.course_id)?.semester_number || "—"}`], ["Credits", r => r.credits], ["Requirement", r => curriculum.get(r.course_id)?.is_compulsory ? "Compulsory" : "Elective"], ["Eligibility", r => curriculum.get(r.course_id)?.is_cross_cutting ? badge("CROSS-CUTTING") : badge("PROGRAMME COURSE"), true], ["Status", r => badge(r.registration_status), true]], selectedRows));
    $("submitRegistration")?.addEventListener("click", () => action(() => IDMCAPI.post("/self-service/student/registration/submit", {}), "Registration submitted."));
    document.querySelectorAll(".select-course").forEach(b => b.addEventListener("click", () => action(() => IDMCAPI.post("/self-service/student/registration/select", { courseOfferingId: b.dataset.id }), "Course registered successfully.")));
  }

  async function attendance() {
    const rows = unwrap(await IDMCAPI.get("/students/me/attendance")).records || [], attended = rows.filter(x => ["PRESENT", "LATE"].includes(String(x.attendance_status).toUpperCase())).length;
    setContent(summary([["Records", rows.length], ["Present/Late", attended], ["Absent", rows.filter(x => String(x.attendance_status).toUpperCase() === "ABSENT").length], ["Rate", rows.length ? `${((attended / rows.length) * 100).toFixed(1)}%` : "—"]]) + table([["Session", r => r.attendance_session_id], ["Status", r => badge(r.attendance_status), true], ["Check-in", r => r.check_in_time], ["Minutes Late", r => r.minutes_late], ["Remarks", r => r.remarks]], rows));
  }

  async function results() {
    const d = unwrap(await IDMCAPI.get("/students/me/results")), rows = d.course_results || [], sem = d.semester_results?.[0] || {}, cg = d.cgpa_records?.[0] || {};
    setContent(summary([["Latest GPA", sem.gpa], ["CGPA", cg.cgpa || sem.cgpa], ["Published Courses", rows.length], ["Standing", sem.academic_standing || cg.academic_standing]]) + table([["Code", r => r.course_code], ["Module", r => r.course_name], ["CW", r => r.coursework_mark], ["SE", r => r.examination_mark], ["Total", r => r.total_mark], ["Credits", r => r.credits || r.credit_units], ["Grade", r => r.grade_code], ["Points", r => r.quality_points], ["Remarks", r => badge(r.pass_status), true]], rows));
  }

  async function timetable() {
    const d = unwrap(await IDMCAPI.get("/students/me/timetable"));
    setContent(`<h3>Class Timetable</h3>` + table([["Day", r => r.slot?.day_of_week || r.slot?.day_name], ["Course", r => `${val(r.course_code, "")} ${val(r.course_name, "")}`], ["Start", r => r.slot?.start_time], ["End", r => r.slot?.end_time], ["Room", r => r.room?.room_name || r.room?.room_code], ["Lecturer", r => r.lecturer_name]], d.classes || []) + `<h3>Examination Timetable</h3>` + table([["Date", r => r.examination_date], ["Paper", r => r.paper_title || r.course_name], ["Start", r => r.start_time], ["End", r => r.end_time], ["Room", r => r.room?.room_name || r.room?.room_code], ["Eligibility", r => badge(r.eligibility_status), true]], d.examinations || []));
  }

  async function fees() {
    const d = unwrap(await IDMCAPI.get("/finance/workflow/student/dashboard", { timeoutMs: 120000 }));
    const account = d.account || {}, invoices = d.invoices || [], requests = d.payment_requests || [], payments = d.payments || [];
    const structures = d.fee_structures || [], invoiceItems = d.invoice_items || [], allocations = d.payment_allocations || [];
    const validInvoices = invoices.filter(x => !["CANCELLED", "VOID"].includes(String(x.status).toUpperCase()));
    const years = [...new Set([...validInvoices.map(x => x.academic_year), ...structures.map(x => x.academic_year)].filter(Boolean))].sort().reverse();
    const currentYear = years.find(y => structures.some(x => x.academic_year === y)) || years[0] || "—";
    const requestedYear = new URLSearchParams(location.search).get("ac_year");
    const selectedYear = requestedYear === "all" ? "all" : years.includes(requestedYear) ? requestedYear : currentYear;
    const yearInvoices = validInvoices.filter(x => selectedYear === "all" || x.academic_year === selectedYear);
    const yearInvoiceIds = new Set(yearInvoices.map(x => x.id));
    const yearAllocations = allocations.filter(x => yearInvoiceIds.has(x.invoice_id));
    const yearPaymentIds = new Set(yearAllocations.map(x => x.payment_id));
    const yearPayments = payments.filter(x => yearPaymentIds.has(x.id) || (selectedYear === "all" && !allocations.some(a => a.payment_id === x.id)));
    const yearRequests = requests.filter(x => selectedYear === "all" || yearInvoiceIds.has(x.invoice_id));
    const authUser = IDMCAuth.getUser() || {};
    const lastLogin = authUser.lastLoginAt || authUser.last_login_at;
    const displayDate = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Not available";
    const cash = value => `TZS ${money(value)}`;
    const ledger = [];
    yearInvoices.forEach(invoice => {
      const items = invoiceItems.filter(item => item.invoice_id === invoice.id);
      const labels = items.map(item => item.description).filter(Boolean);
      ledger.push({ date: invoice.invoice_date || invoice.issued_at, year: invoice.academic_year, control: invoice.control_number || yearRequests.find(r => r.invoice_id === invoice.id)?.control_number || "—", reference: invoice.invoice_number, type: "INVOICE", fee: labels.join(", ") || invoice.notes || "Student fees", debit: Number(invoice.total_amount || 0), installment: invoice.first_installment_amount == null ? "—" : cash(invoice.first_installment_amount), credit: 0, balance: Number(invoice.balance_amount || 0), status: invoice.status, invoiceId: invoice.id });
    });
    yearPayments.forEach(payment => {
      const linked = yearAllocations.filter(a => a.payment_id === payment.id);
      const invoice = yearInvoices.find(i => linked.some(a => a.invoice_id === i.id));
      const desc = invoice ? invoiceItems.filter(item => item.invoice_id === invoice.id).map(item => item.description).filter(Boolean).join(", ") : "Student payment";
      ledger.push({ date: payment.payment_date, year: invoice?.academic_year || selectedYear, control: payment.control_number || "—", reference: payment.receipt_number || payment.external_reference || payment.payment_number, type: "PAYMENT", fee: desc, debit: 0, installment: "—", credit: Number(payment.amount || 0), balance: null, status: payment.status, invoiceId: invoice?.id });
    });
    ledger.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    let runningBalance = 0;
    ledger.forEach(row => { runningBalance += row.debit - row.credit; row.runningBalance = Math.max(0, runningBalance); });
    const options = [...years.map(year => `<option value="${esc(year)}" ${year === selectedYear ? "selected" : ""}>${esc(year)}</option>`), `<option value="all" ${selectedYear === "all" ? "selected" : ""}>All years</option>`].join("");
    const paymentLedger = ledger.length ? `<div class="portal-table-wrap"><table class="portal-table payment-ledger"><thead><tr><th>#</th><th>Academic Year</th><th>Control Number</th><th>Receipt / Invoice</th><th>Fee Type</th><th>Debit</th><th>First Installment</th><th>Credit</th><th>Balance</th><th>Date</th><th>Status</th></tr></thead><tbody>${ledger.map((r,i) => `<tr><td>${i+1}</td><td>${esc(val(r.year))}</td><td>${esc(val(r.control))}</td><td>${esc(val(r.reference))}</td><td>${esc(val(r.fee))}</td><td>${r.debit ? cash(r.debit) : "—"}</td><td>${esc(r.installment)}</td><td>${r.credit ? cash(r.credit) : "—"}</td><td>${cash(r.balance ?? r.runningBalance)}</td><td>${esc(displayDate(r.date))}</td><td>${badge(r.status)}</td></tr>`).join("")}</tbody><tfoot><tr><th colspan="8">Closing Balance</th><th>${cash(ledger.at(-1)?.runningBalance || 0)}</th><th colspan="2"></th></tr></tfoot></table></div>` : `<div class="portal-empty"><strong>No payment records found for this academic year.</strong></div>`;
    const publishedStructures = structures.filter(x => selectedYear === "all" || x.academic_year === selectedYear);
    const structureTable = table([["Academic Year", r => r.academic_year], ["Semester", r => r.semester], ["First Installment", r => r.first_installment_amount == null ? "—" : cash(r.first_installment_amount)], ["Fee Structure", r => `<details><summary>${esc(r.fee_structure_name)}</summary><ul>${(r.fee_items || []).map(item => `<li>${esc(item.fee_item_name)} — ${cash(item.amount)}</li>`).join("")}</ul></details>`, true], ["Effective", r => r.effective_from], ["Status", r => badge(r.status), true]], publishedStructures);
    const totalCharges = selectedYear === "all" ? (account.total_charged ?? validInvoices.reduce((sum, x) => sum + Number(x.total_amount || 0), 0)) : yearInvoices.reduce((sum, x) => sum + Number(x.total_amount || 0), 0);
    const totalPaid = selectedYear === "all" ? (account.total_paid ?? payments.filter(x => x.status === "CONFIRMED").reduce((sum, x) => sum + Number(x.amount || 0), 0)) : yearPayments.filter(x => x.status === "CONFIRMED").reduce((sum, x) => sum + Number(x.amount || 0), 0);
    const balanceDue = selectedYear === "all" ? (account.current_balance ?? validInvoices.reduce((sum, x) => sum + Number(x.balance_amount || 0), 0)) : yearInvoices.reduce((sum, x) => sum + Number(x.balance_amount || 0), 0);
    setContent(`<section class="payment-info"><h3>Payment Info</h3><div><p><strong>Current Year:</strong> ${esc(currentYear)}</p><p><strong>Last Login:</strong> ${esc(displayDate(lastLogin))}</p><p><strong>Today:</strong> ${esc(new Date().toLocaleDateString())}</p></div><small>Use “View All Records” to see invoices and payments from every academic year. Payment records reflect confirmed IDMC transactions.</small><p><strong>Payment channel:</strong> ${esc(d.payment_instructions?.bankName || "NMB")} · <strong>Account:</strong> ${esc(d.payment_instructions?.accountName || "—")} · <strong>Control number:</strong> ${esc(d.payment_instructions?.controlNumber || "—")}</p></section>` + summary([["Total Charges", cash(totalCharges)], ["Total Paid", cash(totalPaid)], ["Balance Due", cash(balanceDue)], ["Account", account.account_status || (Number(balanceDue) > 0 ? "OUTSTANDING" : "CLEARED")]]) + `<div class="portal-actions"><button type="button" class="portal-button" onclick="window.print()">Print / Save Statement</button></div><section class="payment-filter"><label for="paymentYear">Filter by academic year</label><select id="paymentYear">${options}</select><button type="button" class="portal-button" id="viewAllPayments">View All Records</button></section><h3>Academic Year: ${esc(selectedYear)}</h3>${paymentLedger}<h3>Outstanding Invoices</h3>` + table([["Invoice", r => r.invoice_number], ["Academic Year", r => `${val(r.academic_year, "")} ${val(r.semester, "")}`], ["Amount", r => cash(r.total_amount)], ["Paid", r => cash(r.amount_paid)], ["Balance", r => cash(r.balance_amount)], ["Status", r => badge(r.status), true], ["Action", r => Number(r.balance_amount || 0) > 0 ? `<button class="portal-button request-payment" data-id="${esc(r.id)}">Request Control Number</button>` : "Cleared", true]], yearInvoices.filter(x => Number(x.balance_amount || 0) > 0)) + `<h3>Control Numbers and Receipt Upload</h3>` + table([["Request", r => r.request_number], ["Control Number", r => r.control_number], ["Amount", r => cash(r.amount)], ["Status", r => badge(r.request_status), true], ["Finance Message", r => r.provider_message], ["Action", r => ["ISSUED", "REJECTED"].includes(r.request_status) ? `<label class="portal-button">Upload Receipt<input class="receipt-upload" data-id="${esc(r.id)}" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" hidden></label>` : r.receipt_file_name || "—", true]], yearRequests) + `<h3>Published Fee Structures</h3>${structureTable}`);
    $("paymentYear")?.addEventListener("change", event => { const url = new URL(location.href); url.searchParams.set("ac_year", event.target.value); location.assign(url); });
    $("viewAllPayments")?.addEventListener("click", () => { const url = new URL(location.href); url.searchParams.set("ac_year", "all"); location.assign(url); });
    document.querySelectorAll(".request-payment").forEach(button => button.addEventListener("click", () => { const payerPhone = prompt("Payer phone number (optional):") || ""; action(() => IDMCAPI.post("/self-service/student/payments/control-number", { invoiceId: button.dataset.id, payerPhone }), "Payment request created; awaiting configured provider confirmation."); }));
    document.querySelectorAll(".receipt-upload").forEach(input => input.addEventListener("change", async () => {
      const file = input.files?.[0]; if (!file) return;
      if (file.size > 6 * 1024 * 1024) return alert("Receipt must not exceed 6 MB.");
      try {
        const token = IDMCAuth.getAccessToken();
        const response = await fetch(`${IDMCAPI.baseUrl}/finance/workflow/student/payment-requests/${encodeURIComponent(input.dataset.id)}/receipt`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "X-File-Name": file.name, "X-Mime-Type": file.type }, body: file });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) { const error = new Error(payload.message || "Receipt upload failed."); error.status = response.status; error.requestId = response.headers?.get("x-request-id") || payload.requestId; throw error; }
        alert("Receipt uploaded. Finance will review and confirm the payment."); await loadView();
      } catch (error) { alert(IDMCAPI.toUserMessage(error) || "Receipt upload failed."); }
    }));
  }

  async function documents() {
    const d = unwrap(await IDMCAPI.get("/students/me/documents"));
    setContent(`<h3>My Documents</h3>` + table([["Document", r => r.file_name || r.document_type], ["Type", r => r.document_type], ["Uploaded", r => r.uploaded_at], ["Verification", r => badge(r.verification_status), true], ["Action", r => `<button class="portal-button download-document" data-id="${esc(r.id)}">Download</button>`, true]], d.documents || []) + `<h3>Service Requests</h3>` + table([["Request", r => r.request_number], ["Type", r => r.request_type], ["Subject", r => r.subject], ["Status", r => badge(r.status), true], ["Submitted", r => r.submitted_at]], d.service_requests || []));
    document.querySelectorAll(".download-document").forEach(b => b.addEventListener("click", async () => { try { const x = unwrap(await IDMCAPI.get(`/students/me/documents/${encodeURIComponent(b.dataset.id)}/download`)); window.open(x.url, "_blank", "noopener"); } catch (e) { alert(e.message); } }));
  }

  async function notifications() {
    const d = unwrap(await IDMCAPI.get("/students/me/notifications"));
    setContent(`<div class="portal-actions"><button class="portal-button" id="readAll">Mark All Read</button></div>` + table([["Date", r => r.created_at], ["Title", r => r.title], ["Message", r => r.body || r.message], ["Priority", r => badge(r.priority), true], ["Status", r => badge(r.read_at ? "READ" : r.status || "UNREAD"), true], ["Action", r => r.read_at ? "Read" : `<button class="portal-button read-one" data-id="${esc(r.id)}">Mark Read</button>`, true]], d.notifications || []) + `<h3>Announcements</h3>` + table([["Date", r => r.publish_at || r.created_at], ["Title", r => r.title], ["Message", r => r.summary || r.body || r.message]], d.announcements || []));
    $("readAll")?.addEventListener("click", () => action(() => IDMCAPI.post("/students/me/notifications/read-all", {}), "Notifications marked as read."));
    document.querySelectorAll(".read-one").forEach(b => b.addEventListener("click", () => action(() => IDMCAPI.patch(`/students/me/notifications/${encodeURIComponent(b.dataset.id)}/read`, {}), "Notification marked as read.")));
  }

  const loaders = { registration, attendance, results, timetable, fees, documents, notifications };
  async function loadView() { setContent(`<div class="portal-state"><div class="portal-spinner"></div><h3>Loading ${esc(config.title || "Student Panel")}</h3></div>`); try { await (loaders[view] || registration)(); } catch (e) { setContent(`<div class="portal-error">${esc(e.message || "Unable to load this page.")}</div>`); } }
  async function boot() { try { if (!await IDMCAuth.requireAuth()) return; await identity(); document.querySelector(`[data-view="${CSS.escape(view)}"]`)?.classList.add("active"); await loadView(); } catch (e) { setContent(`<div class="portal-error">${esc(e.message || "Unable to open Student Panel.")}</div>`); } }
  document.addEventListener("DOMContentLoaded", () => { $("portalRefreshButton")?.addEventListener("click", loadView); boot(); });
})();
