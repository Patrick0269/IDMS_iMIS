(function () {
  "use strict";
  const state = { accounts: [], allowed_roles: [], institutions: [], departments: [], selected: null };
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const payloadData = (response) => response && typeof response === "object" && "data" in response ? response.data : response;
  const rows = (response) => { const data = payloadData(response); return Array.isArray(data) ? data : []; };

  function message(text, error = false) {
    const box = $("message"); box.hidden = !text; box.textContent = text || ""; box.className = `message${error ? " error" : ""}`;
    if (text) scrollTo({ top: 0, behavior: "smooth" });
  }
  function option(value, label) { return `<option value="${esc(value)}">${esc(label)}</option>`; }
  function displayName(item) {
    const staff = item.staff || {}; const user = item.user || {};
    return user.display_name || [user.first_name || staff.first_name, user.middle_name || staff.middle_name, user.last_name || staff.last_name].filter(Boolean).join(" ") || staff.email || user.email || "Unnamed staff";
  }
  function renderSelects() {
    $("roleCode").innerHTML = '<option value="">Select role</option>' + state.allowed_roles.map((item) => option(item.role_code, item.role_name)).join("");
    $("institutionId").innerHTML = state.institutions.map((item) => option(item.id, `${item.institution_code} — ${item.institution_name}`)).join("");
    if (state.institutions.length === 1) { $("institutionId").value = state.institutions[0].id; $("institutionId").disabled = true; }
    const departments = [...new Map(state.departments.map((item) => [item.id, item])).values()];
    $("departmentId").innerHTML = '<option value="">Choose department</option>' + departments.map((item) => option(item.id, `${item.department_code || ""} — ${item.department_name || "Department"}`)).join("");
    $("departmentFilter").innerHTML = '<option value="">All departments</option>' + departments.map((item) => option(item.id, item.department_name || item.department_code || "Department")).join("");
    const roleOptions = [...new Map(state.accounts.flatMap((item) => item.roles || []).map((role) => [role.role_code, role])).values()];
    $("roleFilter").innerHTML = '<option value="">All roles</option>' + roleOptions.map((role) => option(role.role_code, role.role_name || role.role_code)).join("");
    updateDepartmentRequirement();
  }
  function updateDepartmentRequirement() {
    const required = $("roleCode").value === "LECTURER";
    $("departmentId").required = required;
    $("departmentId").setCustomValidity(required && !$("departmentId").value ? "Select the lecturer's department." : "");
  }
  function filteredAccounts() {
    const term = $("staffSearch").value.trim().toLowerCase();
    const departmentId = $("departmentFilter").value;
    const roleCode = $("roleFilter").value;
    return state.accounts.filter((item) => {
      const staff = item.staff || {}; const user = item.user || {}; const roles = item.roles || [];
      const searchable = [displayName(item), user.email, user.username, user.user_number, staff.employee_number, staff.job_title, item.department?.department_name, item.department?.department_code, ...roles.map((role) => role.role_name), ...roles.map((role) => role.role_code)].join(" ").toLowerCase();
      const status = $("statusFilter").value;
      return (!term || searchable.includes(term)) && (!departmentId || staff.department_id === departmentId) && (!roleCode || roles.some((role) => role.role_code === roleCode)) && (!status || String(staff.employment_status || "").toUpperCase() === status);
    });
  }
  function renderAccounts() {
    const accounts = filteredAccounts();
    $("accounts").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Employee number</th><th>Staff member</th><th>Department</th><th>Login email</th><th>Job title</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>${accounts.length ? accounts.map((item) => {
      const staff = item.staff || {}; const user = item.user || {}; const roles = item.roles || [];
      const terminated = String(staff.employment_status || "").toUpperCase() === "TERMINATED";
      return `<tr><td>${esc(staff.employee_number || "—")}</td><td><strong>${esc(displayName(item))}</strong><br><small>${esc(user.user_number || "")}</small></td><td>${esc(item.department?.department_name || "—")}</td><td>${esc(user.email || staff.email || "—")}</td><td>${esc(staff.job_title || "—")}</td><td>${roles.length ? roles.map((role) => esc(role.role_name || role.role_code)).join("<br>") : "No role"}</td><td><span class="status">${esc(staff.employment_status || user.status || "—")}</span></td><td><button class="button small" type="button" data-open-staff="${esc(staff.id)}">Open</button>${terminated ? "" : ` <button class="button small danger" type="button" data-delete-staff="${esc(staff.id)}">Delete staff</button>`}</td></tr>`;
    }).join("") : '<tr><td colspan="8" class="empty">No staff match this search.</td></tr>'}</tbody></table></div><p class="table-count">Showing ${accounts.length} of ${state.accounts.length} staff records</p>`;
    $("accounts").querySelectorAll("[data-open-staff]").forEach((button) => button.addEventListener("click", () => openStaffFile(button.dataset.openStaff)));
    $("accounts").querySelectorAll("[data-delete-staff]").forEach((button) => button.addEventListener("click", () => archiveStaff(button.dataset.deleteStaff)));
  }
  async function load() {
    const response = await IDMCAPI.get("/staff-workspace/admin/accounts", { cache: "no-store" });
    Object.assign(state, payloadData(response) || {});
    renderSelects(); renderAccounts();
  }
  async function searchExistingUsers() {
    const term = $("existingUserSearch").value.trim(); const target = $("existingUserResults");
    if (term.length < 2) { target.innerHTML = '<p class="search-hint">Type at least two letters to search users.</p>'; return; }
    const button = $("findExistingUser"); button.disabled = true; target.innerHTML = '<p class="search-hint">Searching user accounts…</p>';
    try {
      const result = await IDMCAPI.get(`/users?search=${encodeURIComponent(term)}&limit=50`, { cache: "no-store" });
      const users = rows(result).filter((user) => String(user.status || "").toUpperCase() === "ACTIVE");
      target.innerHTML = users.length ? users.map((user) => {
        const name = user.display_name || [user.first_name, user.middle_name, user.last_name].filter(Boolean).join(" ") || "Unnamed user";
        const roleNames = (user.user_roles || []).filter((assignment) => String(assignment.status || "ACTIVE").toUpperCase() === "ACTIVE").map((assignment) => assignment.roles?.role_name || assignment.roles?.role_code).filter(Boolean).join(", ") || "No role yet";
        const disabled = !user.auth_user_id;
        return `<button class="search-result" type="button" role="option" data-user-email="${esc(user.email)}" data-user-auth="${disabled ? "no" : "yes"}" ${disabled ? "disabled" : ""}><strong>${esc(name)}</strong><span>${esc(user.email || "No email")} · ${esc(user.user_number || "No user number")}</span><small>${esc(roleNames)}${disabled ? " · Login identity missing" : ""}</small></button>`;
      }).join("") : '<p class="search-hint">No active user accounts match that name or email.</p>';
      target.querySelectorAll("[data-user-email]").forEach((candidate) => candidate.addEventListener("click", () => {
        if (candidate.dataset.userAuth !== "yes") return;
        $("identifier").value = candidate.dataset.userEmail; target.innerHTML = `<p class="search-hint success">Selected account: ${esc(candidate.dataset.userEmail)}. Choose the staff role and department, then save.</p>`;
      }));
    } catch (error) { target.innerHTML = `<p class="search-hint error-text">${esc(error.message || "Could not search users.")}</p>`; }
    finally { button.disabled = false; }
  }
  async function archiveStaff(staffId) {
    const item = state.accounts.find((entry) => String(entry.staff?.id) === String(staffId));
    if (!item) return;
    const name = displayName(item);
    if (!confirm(`Delete staff access for ${name}? This archives the staff record as TERMINATED, cancels active lecturer course assignments, and deactivates staff roles. HR history and any Student or Admin role are kept.`)) return;
    try {
      await IDMCAPI.delete(`/staff-workspace/admin/accounts/${encodeURIComponent(staffId)}`);
      $("staffFile").hidden = true; await load();
      message(`${name} was moved to TERMINATED. HR history is preserved; Student and Admin roles remain. You can view the record using the TERMINATED status filter.`);
    } catch (error) { message(error.message || "Unable to delete staff access.", true); }
  }
  const can = (permission) => Boolean(window.IDMCAuth?.hasPermission?.(permission));
  function staffRecordTabs(staff) {
    const tabs = [{ key: "profile", label: "Profile" }];
    if (can("staff.view")) tabs.push(
      { key: "employment-history", label: "Employment history" },
      { key: "qualifications", label: "Qualifications" },
      { key: "documents", label: "Documents" }
    );
    if (can("staff.attendance.view")) tabs.push({ key: "attendance", label: "Attendance" });
    if (can("leave.view")) tabs.push({ key: "leave/requests", label: "Leave" });
    if (can("payroll.view")) tabs.push({ key: "payroll/entries", label: "Payroll" });
    $("staffFileTabs").innerHTML = tabs.map((tab) => `<button type="button" class="record-tab" data-record-tab="${esc(tab.key)}">${esc(tab.label)}</button>`).join("");
    $("staffFileTabs").querySelectorAll("[data-record-tab]").forEach((button) => button.addEventListener("click", () => loadStaffRecordTab(staff, button.dataset.recordTab)));
    loadStaffRecordTab(staff, "profile");
  }
  function profileMarkup(item) {
    const staff = item.staff || {}; const user = item.user || {};
    const fields = [["Employee number", staff.employee_number], ["Name", displayName(item)], ["Email", user.email || staff.email], ["Phone", user.phone || staff.phone], ["Department", item.department?.department_name], ["Job title", staff.job_title], ["Category", staff.staff_category], ["Employment type", staff.employment_type], ["Employment status", staff.employment_status], ["Account status", user.status], ["Account number", user.user_number]];
    return `<dl class="staff-profile-grid">${fields.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value || "—")}</dd></div>`).join("")}</dl>`;
  }
  const recordColumns = {
    "employment-history": [["Job title", "job_title"], ["Employment type", "employment_type"], ["Start", "start_date"], ["End", "end_date"], ["Reason", "reason_for_change"]],
    qualifications: [["Level", "qualification_level"], ["Qualification", "qualification_name"], ["Institution", "institution_name"], ["Field", "field_of_study"], ["Completed", "completion_year"], ["Verification", "verification_status"]],
    documents: [["Type", "document_type"], ["Document", "document_name"], ["Number", "document_number"], ["Issue date", "issue_date"], ["Expiry date", "expiry_date"], ["Verification", "verification_status"]],
    attendance: [["Date", "attendance_date"], ["Status", "attendance_status"], ["Check in", "check_in"], ["Check out", "check_out"], ["Late minutes", "late_minutes"]],
    "leave/requests": [["Request", "request_number"], ["Start", "start_date"], ["End", "end_date"], ["Days", "days_requested"], ["Status", "request_status"], ["Reason", "reason"]],
    "payroll/entries": [["Period", "payroll_period_id"], ["Basic pay", "basic_salary"], ["Gross pay", "gross_pay"], ["Deductions", "total_deductions"], ["Net pay", "net_pay"], ["Status", "status"], ["Paid", "paid_at"]],
  };
  async function loadStaffRecordTab(item, tab) {
    $("staffFileTabs").querySelectorAll(".record-tab").forEach((button) => button.classList.toggle("active", button.dataset.recordTab === tab));
    const content = $("staffFileContent");
    if (tab === "profile") { content.innerHTML = profileMarkup(item); return; }
    content.innerHTML = '<p class="search-hint">Loading staff records…</p>';
    const endpoint = tab === "employment-history" ? "employment-history" : tab === "qualifications" ? "qualifications" : tab === "documents" ? "documents" : tab;
    try {
      const response = await IDMCAPI.get(`/hr/${endpoint}?staff_id=${encodeURIComponent(item.staff.id)}&limit=100`, { cache: "no-store" });
      const data = rows(response); const columns = recordColumns[tab] || [];
      content.innerHTML = data.length ? `<div class="table-wrap"><table><thead><tr>${columns.map(([label]) => `<th>${esc(label)}</th>`).join("")}</tr></thead><tbody>${data.map((record) => `<tr>${columns.map(([, key]) => `<td>${esc(record[key] ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : '<p class="search-hint">No records are available for this staff member.</p>';
    } catch (error) { content.innerHTML = `<p class="search-hint error-text">${esc(error.message || "You do not have permission to view this staff record.")}</p>`; }
  }
  function openStaffFile(staffId) {
    const item = state.accounts.find((entry) => String(entry.staff?.id) === String(staffId));
    if (!item) return;
    state.selected = item; $("staffFile").hidden = false; $("staffFileTitle").textContent = displayName(item); $("staffFileSubtitle").textContent = [item.staff?.employee_number, item.department?.department_name, item.staff?.job_title].filter(Boolean).join(" · ");
    staffRecordTabs(item); $("staffFile").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function submit(event) {
    event.preventDefault(); message(""); const form = event.currentTarget; const body = Object.fromEntries(new FormData(form).entries()); const button = form.querySelector("button[type=submit]"); button.disabled = true;
    try { const result = payloadData(await IDMCAPI.post("/staff-workspace/admin/accounts", body)); form.reset(); $("existingUserResults").innerHTML = ""; setMode(); await load(); message(`Staff account saved. Assigned role: ${result.role.role_name}. Portal: ${result.portal}`); }
    catch (error) { message(error.message || "Unable to save staff account.", true); }
    finally { button.disabled = false; }
  }
  function setMode() {
    const link = $("mode").value === "LINK";
    document.querySelectorAll(".link-field").forEach((element) => { element.hidden = !link; });
    document.querySelectorAll(".create-field").forEach((element) => { element.hidden = link; });
    $("identifier").required = link;
    for (const id of ["firstName", "lastName", "email", "password"]) $(id).required = !link;
    if (!link) { $("existingUserSearch").value = ""; $("existingUserResults").innerHTML = ""; $("identifier").value = ""; }
    updateDepartmentRequirement();
  }
  async function init() {
    try { if (!await IDMCAuth.requireAuth()) return; await load(); }
    catch (error) { message(error.message || "Unable to load staff accounts.", true); }
  }
  $("today").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  $("mode").onchange = setMode; $("roleCode").onchange = updateDepartmentRequirement; $("departmentId").onchange = updateDepartmentRequirement;
  $("findExistingUser").onclick = searchExistingUsers; $("existingUserSearch").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); searchExistingUsers(); } });
  $("staffSearch").addEventListener("input", renderAccounts); $("departmentFilter").onchange = renderAccounts; $("roleFilter").onchange = renderAccounts; $("statusFilter").onchange = renderAccounts;
  $("refreshStaff").onclick = async () => { try { await load(); message("Staff directory refreshed."); } catch (error) { message(error.message || "Unable to refresh staff directory.", true); } };
  $("closeStaffFile").onclick = () => { $("staffFile").hidden = true; state.selected = null; };
  $("accountForm").onsubmit = submit; $("menuButton").onclick = () => $("sidebar").classList.toggle("open"); $("logoutButton").onclick = () => IDMCAuth.logout();
  setMode(); init();
})();
