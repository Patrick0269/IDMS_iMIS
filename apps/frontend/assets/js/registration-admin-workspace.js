(function () {
  "use strict";
  const state = { students: [], years: [], semesters: [], programmes: [], versions: [], registrations: [], selectedStudentIds: new Set(), showAll: false };
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "-").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const name = (s) => [s?.first_name, s?.middle_name, s?.last_name].filter(Boolean).join(" ") || "Student";
  const map = (rows) => new Map(rows.map((x) => [x.id, x]));
  function message(text, error = false) { $("message").textContent = text; $("message").className = "message" + (error ? " error" : ""); }
  function fillSelect(select, items, label) { const first = select.options[0].outerHTML; select.innerHTML = first + items.map((x) => `<option value="${esc(x.id)}">${esc(label(x))}</option>`).join(""); }
  function activeStudents() {
    const yearId = $("academicYearId").value, semesterId = $("semesterId").value;
    const alreadyRegistered = new Set(state.registrations.filter((r) => String(r.registration_status || "").toUpperCase() === "REGISTERED" && (!yearId || r.academic_year_id === yearId) && (!semesterId || r.semester_id === semesterId)).map((r) => r.student_id));
    for (const id of state.selectedStudentIds) if (alreadyRegistered.has(id)) state.selectedStudentIds.delete(id);
    return state.students.filter((s) => ["ACTIVE", "PENDING_ACTIVATION"].includes(String(s.student_status || "").toUpperCase()) && !alreadyRegistered.has(s.id));
  }
  function renderStudentChoices() {
    const eligible = activeStudents(), query = $("studentSearch").value.trim().toLowerCase();
    const matched = query ? eligible.filter((s) => `${s.student_number || ""} ${name(s)} ${programmeLabel(s)}`.toLowerCase().includes(query)) : eligible;
    const shown = state.showAll || query ? matched : matched.slice(0, 100);
    $("studentChoices").innerHTML = shown.map((s) => `<tr><td><input type="checkbox" data-student-choice="${esc(s.id)}" aria-label="Select ${esc(s.student_number)}" ${state.selectedStudentIds.has(s.id) ? "checked" : ""}></td><td><strong>${esc(s.student_number)}</strong><span class="minor">${esc(name(s))}</span></td><td>${esc(programmeLabel(s))}</td><td>${esc(s.student_status)}</td></tr>`).join("") || '<tr><td colspan="4" class="empty">No eligible students match this search.</td></tr>';
    $("studentChoiceCount").textContent = `${state.selectedStudentIds.size} selected · ${matched.length} matching students`;
    $("loadAll").hidden = state.showAll || Boolean(query) || matched.length <= shown.length;
  }
  function programmeLabel(student) { const p = state.programmes.find((x) => x.id === student.programme_id); return p ? `${p.programme_code || ""} · ${p.programme_name}` : "Programme not linked"; }
  function yearSemesters(yearId) { return state.semesters.filter((s) => !s.academic_year_id || s.academic_year_id === yearId); }
  function updateSemesters() { fillSelect($("semesterId"), yearSemesters($("academicYearId").value), (s) => s.semester_name || s.semester_code); }
  function render() {
    const sm = map(state.students), pm = map(state.programmes), ym = map(state.years), sem = map(state.semesters), q = $("search").value.trim().toLowerCase(), status = $("status").value;
    const list = state.registrations.filter((r) => (!status || r.registration_status === status) && (!q || JSON.stringify(r).toLowerCase().includes(q) || String(sm.get(r.student_id)?.student_number || "").toLowerCase().includes(q) || name(sm.get(r.student_id)).toLowerCase().includes(q)));
    $("registrationRows").innerHTML = list.map((r) => { const s = sm.get(r.student_id) || {}, p = pm.get(r.programme_id) || {}, y = ym.get(r.academic_year_id) || {}, x = sem.get(r.semester_id) || {}; return `<tr><td><strong>${esc(s.student_number)}</strong><span class="minor">${esc(name(s))}</span></td><td>${esc(p.programme_code)}<span class="minor">${esc(p.programme_name)}</span></td><td>${esc(y.year_name || y.year_code)}<span class="minor">${esc(x.semester_name || x.semester_code)}</span></td><td>${esc(r.registration_number)}</td><td>${esc(r.total_registered_credits)}</td><td>Academic: ${esc(r.academic_eligibility_status)}<span class="minor">Finance: ${esc(r.finance_eligibility_status)} | Documents: ${esc(r.document_eligibility_status)}</span></td><td><span class="badge ${esc(String(r.registration_status || "").toLowerCase())}">${esc(r.registration_status)}</span></td></tr>`; }).join("") || '<tr><td colspan="7" class="empty">No matching registrations.</td></tr>';
    $("summary").innerHTML = [["Students", state.students.length], ["Registrations", state.registrations.length], ["Draft", state.registrations.filter((r) => r.registration_status === "DRAFT").length], ["Registered", state.registrations.filter((r) => r.registration_status === "REGISTERED").length]].map((x) => `<div class="stat"><span>${x[0]}</span><strong>${x[1]}</strong></div>`).join("");
  }
  async function load() {
    message("Loading students and academic periods...");
    try {
      const response = await window.IDMCAPI.get("/registrations/workspace/references"), d = response.data || {};
      state.students = d.students || []; state.years = d.academicYears || []; state.semesters = d.semesters || []; state.programmes = d.programmes || []; state.versions = d.programmeVersions || []; state.registrations = d.registrations || [];
      const yearId = $("academicYearId").value;
      fillSelect($("academicYearId"), state.years, (y) => `${y.year_code || ""} - ${y.year_name || ""}${y.status === "ACTIVE" ? " (Active)" : ""}`);
      if (state.years.some((y) => y.id === yearId)) $("academicYearId").value = yearId;
      else { const activeYear = state.years.find((y) => y.status === "ACTIVE"); if (activeYear) $("academicYearId").value = activeYear.id; }
      updateSemesters(); render(); renderStudentChoices(); message("Registration workspace loaded. Students already registered for this academic period are hidden from the selection list.");
    } catch (e) { message(e.message || "Unable to load registration workspace.", true); }
  }
  async function submit(e) {
    e.preventDefault(); const form = e.currentTarget;
    if (!form.reportValidity()) return;
    const studentIds = [...state.selectedStudentIds], academicYearId = $("academicYearId").value, semesterId = $("semesterId").value;
    if (!studentIds.length) return message("Tick at least one student to register.", true);
    const year = state.years.find((x) => x.id === academicYearId), semester = state.semesters.find((x) => x.id === semesterId);
    if (!year || !semester) return message("Choose an academic year and semester.", true);
    const button = $("bulkRegister"), progress = $("registrationProgress"), progressText = $("registrationProgressText"), results = $("bulkRegistrationResults");
    const succeeded = [], failed = [];
    button.disabled = true; progress.hidden = false; progress.max = studentIds.length; progress.value = 0; results.innerHTML = "";
    for (let i = 0; i < studentIds.length; i += 1) {
      const studentId = studentIds[i], student = state.students.find((x) => x.id === studentId);
      progressText.textContent = `Registering ${i + 1} of ${studentIds.length}: ${student?.student_number || name(student)} · ${programmeLabel(student || {})}`;
      try {
        const response = await window.IDMCAPI.post("/registrations/workspace/create", { studentId, academicYearId, semesterId, notes: form.elements.notes.value });
        succeeded.push({ student, message: response.message || "Registration completed." }); state.selectedStudentIds.delete(studentId);
      } catch (error) { failed.push({ student, message: error.message || "Registration failed." }); }
      progress.value = i + 1;
      renderStudentChoices();
    }
    await load();
    results.innerHTML = [...succeeded.map((x) => `<li><strong>${esc(x.student?.student_number)} · ${esc(name(x.student || {}))}</strong> — ${esc(x.message)}</li>`), ...failed.map((x) => `<li class="error"><strong>${esc(x.student?.student_number)} · ${esc(name(x.student || {}))}</strong> — ${esc(x.message)}</li>`)].join("");
    progressText.textContent = `${succeeded.length} registered; ${failed.length} need attention.`;
    message(`${succeeded.length} of ${studentIds.length} registrations completed${failed.length ? `; ${failed.length} failed. Review the results below.` : "."}`, failed.length > 0);
    button.disabled = false;
  }
  function downloadRegistered() {
    const sm = map(state.students), pm = map(state.programmes), ym = map(state.years), sem = map(state.semesters), rows = [["Student Number", "Student Name", "Programme", "Academic Year", "Semester", "Registration Number", "Credits", "Status"]];
    state.registrations.filter((r) => r.registration_status === "REGISTERED").forEach((r) => { const s = sm.get(r.student_id) || {}, p = pm.get(r.programme_id) || {}, y = ym.get(r.academic_year_id) || {}, x = sem.get(r.semester_id) || {}; rows.push([s.student_number || "", name(s), p.programme_code || p.programme_name || "", y.year_code || y.year_name || "", x.semester_name || x.semester_code || "", r.registration_number || "", r.total_registered_credits || 0, r.registration_status || ""]); });
    const csv = rows.map((row) => row.map((v) => '"' + String(v ?? "").replaceAll('"', '""') + '"').join(",")).join("\r\n"), a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); a.download = `IDMC-registered-students-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
  }
  async function init() { if (!await window.IDMCAuth.requireAuth()) return; await load(); }
  $("studentSearch").oninput = renderStudentChoices;
  $("studentChoices").addEventListener("change", (event) => { const input = event.target.closest("[data-student-choice]"); if (!input) return; if (input.checked) state.selectedStudentIds.add(input.dataset.studentChoice); else state.selectedStudentIds.delete(input.dataset.studentChoice); $("studentChoiceCount").textContent = `${state.selectedStudentIds.size} selected`; });
  $("selectVisibleStudents").onclick = () => { document.querySelectorAll("[data-student-choice]").forEach((input) => state.selectedStudentIds.add(input.dataset.studentChoice)); renderStudentChoices(); };
  $("clearStudentSelection").onclick = () => { state.selectedStudentIds.clear(); renderStudentChoices(); };
  $("loadAll").onclick = () => { state.showAll = true; renderStudentChoices(); };
  $("academicYearId").onchange = () => { updateSemesters(); renderStudentChoices(); };
  $("semesterId").onchange = renderStudentChoices;
  $("search").oninput = render; $("status").onchange = render; $("refresh").onclick = load;
  const dl = $("downloadRegistrations"); if (dl) dl.onclick = downloadRegistered;
  $("registrationForm").onsubmit = submit;
  document.addEventListener("DOMContentLoaded", init);
}());
