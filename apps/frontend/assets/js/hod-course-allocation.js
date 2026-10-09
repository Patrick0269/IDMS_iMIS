(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const state = { data: { staff: [], users: [], courses: [], offerings: [], assignments: [], years: [], semesters: [] } };
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const list = (v) => Array.isArray(v) ? v : [];
  const msg = (text, type) => { $("haMessage").textContent = text; $("haMessage").className = `ha-message ${type || ""}`; };
  const nameOf = (staff, user) => user?.display_name || [staff?.first_name, staff?.middle_name, staff?.last_name].filter(Boolean).join(" ") || user?.email || staff?.employee_number || "Staff member";
  const maps = () => ({
    staff: new Map(list(state.data.staff).map((x) => [String(x.user_id), x])),
    users: new Map(list(state.data.users).map((x) => [String(x.id), x])),
    courses: new Map(list(state.data.courses).map((x) => [String(x.id), x])),
    years: new Map(list(state.data.years).map((x) => [String(x.id), x])),
    semesters: new Map(list(state.data.semesters).map((x) => [String(x.id), x])),
  });
  function offeringLabel(offering, m) {
    const course = m.courses.get(String(offering.course_id)) || {};
    const year = m.years.get(String(offering.academic_year_id)) || {};
    const semester = m.semesters.get(String(offering.semester_id)) || {};
    return `${course.course_code || offering.offering_code || "Course"} · ${course.course_name || "Unnamed course"} · ${year.year_name || year.year_code || "Academic year"} / ${semester.semester_name || semester.semester_code || "Semester"}${offering.section_name ? ` · ${offering.section_name}` : ""}`;
  }
  function renderSelects() {
    const m = maps();
    $("haOffering").innerHTML = '<option value="">Select course offering</option>' + list(state.data.offerings).map((row) => `<option value="${esc(row.id)}">${esc(offeringLabel(row, m))}</option>`).join("");
    $("haLecturer").innerHTML = '<option value="">Select active lecturer</option>' + list(state.data.staff).filter((x) => x.user_id).map((row) => `<option value="${esc(row.user_id)}">${esc(nameOf(row, m.users.get(String(row.user_id))))}${row.employee_number ? ` · ${esc(row.employee_number)}` : ""}</option>`).join("");
    $("haScope").textContent = state.data.departmentId ? "Department scope active" : "Administrator view";
  }
  function renderRows() {
    const m = maps(), term = $("haSearch").value.trim().toLowerCase();
    const rows = list(state.data.assignments).filter((assignment) => {
      const offering = list(state.data.offerings).find((x) => String(x.id) === String(assignment.course_offering_id)) || {};
      const staff = m.staff.get(String(assignment.lecturer_user_id)) || {};
      const user = m.users.get(String(assignment.lecturer_user_id)) || {};
      return !term || `${offeringLabel(offering, m)} ${nameOf(staff, user)} ${assignment.assignment_role} ${assignment.assignment_status}`.toLowerCase().includes(term);
    });
    $("haCount").textContent = `${rows.length} allocation(s)`;
    $("haRows").innerHTML = rows.length ? rows.map((assignment) => {
      const offering = list(state.data.offerings).find((x) => String(x.id) === String(assignment.course_offering_id)) || {};
      const staff = m.staff.get(String(assignment.lecturer_user_id)) || {};
      const user = m.users.get(String(assignment.lecturer_user_id)) || {};
      return `<tr><td><strong>${esc(offeringLabel(offering, m))}</strong></td><td>${esc(nameOf(staff, user))}<small>${esc(user.email || "")}</small></td><td>${esc(assignment.assignment_role)}</td><td>${esc(assignment.workload_hours ?? 0)} hrs</td><td><span class="ha-status">${esc(assignment.assignment_status)}</span></td><td>${esc(assignment.assigned_at ? new Date(assignment.assigned_at).toLocaleDateString() : "—")}</td></tr>`;
    }).join("") : '<tr><td colspan="6" class="ha-empty">No course allocations match this view.</td></tr>';
  }
  async function load() {
    msg("Loading department courses and active staff…");
    const response = await window.IDMCAPI.get("/academic-core/hod/course-allocation", { cache: "no-store" });
    state.data = response.data || state.data;
    renderSelects(); renderRows();
    msg(`${list(state.data.staff).length} active staff member(s), ${list(state.data.courses).length} course(s), and ${list(state.data.assignments).length} current allocation(s) in scope.`, "success");
  }
  async function init() {
    try {
      if (!await window.IDMCAuth.requireAuth()) return;
      const rbac = window.IDMC_RBAC_API;
      if (!rbac || !await rbac.ensureRBACLoaded() || !rbac.hasPermission("lecturer.assignments.manage")) throw new Error("Your HOD account does not have course-allocation permission. Ask an administrator to apply the HOD course-allocation migration.");
      await load();
    } catch (error) { msg(error.message || "Could not load course allocation.", "error"); }
  }
  $("haForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("haSubmit"); button.disabled = true;
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.workloadHours = Number(payload.workloadHours || 0);
    try {
      const result = await window.IDMCAPI.post("/academic-core/hod/course-allocation", payload);
      msg(result.message || "Lecturer assigned successfully.", "success"); form.reset(); await load();
    } catch (error) { msg(error.message || "Course allocation failed.", "error"); }
    finally { button.disabled = false; }
  });
  $("haRefresh").addEventListener("click", () => load().catch((e) => msg(e.message || "Refresh failed.", "error")));
  $("haSearch").addEventListener("input", renderRows);
  init();
})();
