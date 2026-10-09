(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "—").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const date = value => value ? new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Dar_es_Salaam", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
  const message = (value, error = false) => { const box = $("requestMessage"); box.hidden = !value; box.textContent = value || ""; box.className = `portal-state${error ? " portal-error" : ""}`; };
  async function load() {
    const response = await IDMCAPI.get("/students/me/portal"), data = response.data || response;
    const student = data.student || {};
    $("studentName").textContent = student.full_name || [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ") || "Student";
    $("studentNumber").textContent = student.student_number || student.registration_number || "—";
    $("studentProgramme").textContent = student.programme_name || student.programme_code || "—";
    const records = data.service_requests || [];
    $("requestHistory").innerHTML = records.length ? `<div class="portal-table-wrap"><table class="portal-table"><thead><tr><th>Request number</th><th>Type</th><th>Subject</th><th>Submitted</th><th>Status</th><th>Response</th></tr></thead><tbody>${records.map(row => `<tr><td>${esc(row.request_number)}</td><td>${esc(row.request_type)}</td><td>${esc(row.subject)}</td><td>${esc(date(row.submitted_at))}</td><td>${esc(row.status)}</td><td>${esc(row.review_comment || row.decision_reason || "—")}</td></tr>`).join("")}</tbody></table></div>` : "No requests have been submitted from this account yet.";
  }
  $("studentRequestForm").addEventListener("submit", async event => {
    event.preventDefault(); const form = event.currentTarget, button = $("submitRequest"); button.disabled = true; message("Submitting your request…");
    try { await IDMCAPI.post("/students/me/requests", Object.fromEntries(new FormData(form).entries())); form.reset(); message("Your request has been submitted to IDMC."); await load(); }
    catch (error) { message(error.message || "Unable to submit your request.", true); }
    finally { button.disabled = false; }
  });
  async function init() {
    const requestedType = new URLSearchParams(location.search).get("type");
    if ([...$("requestType").options].some(option => option.value === requestedType)) $("requestType").value = requestedType;
    if (!await IDMCAuth.requireAuth()) return;
    try { await load(); } catch (error) { $("requestHistory").textContent = error.message || "Unable to load request history."; message("Request information could not be loaded.", true); }
  }
  init();
}());
