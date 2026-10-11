(function () {
  "use strict";

  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const state = { refs: null, rows: [], page: 1, total: 0, limit: 25, editing: null, roster: null, rosterPage: 1, rosterTotal: 0, rosterLimit: 100, canManage: false, candidates: [], candidatePage: 1, candidateTotal: 0, candidateLimit: 100, selectedCandidates: new Set() };
  const form = $("#cohortForm");

  function payload(response) { return response?.data ?? response; }
  function notice(message, kind = "ok") { const el = $("#notice"); el.textContent = message; el.className = `notice ${kind}`; }
  function clearNotice() { const el = $("#notice"); el.textContent = ""; el.className = "notice"; }
  function options(select, rows, key, label, first) {
    const prior = select.value;
    select.innerHTML = `<option value="">${esc(first)}</option>` + rows.map(row => `<option value="${esc(row.id)}">${esc(label(row))}</option>`).join("");
    if ([...select.options].some(item => item.value === prior)) select.value = prior;
  }
  function populateReferences() {
    const ref = state.refs;
    options(form.elements.programmeId, ref.programmes, "id", row => `${row.programme_code} · ${row.programme_name}`, "Select programme");
    options($("#programmeFilter"), ref.programmes, "id", row => `${row.programme_code} · ${row.programme_name}`, "All programmes");
    options(form.elements.academicYearId, ref.academicYears, "id", row => `${row.year_code} · ${row.year_name}`, "Select year (optional)");
    options($("#academicYearFilter"), ref.academicYears, "id", row => `${row.year_code} · ${row.year_name}`, "All academic years");
    options(form.elements.campusId, ref.campuses, "id", row => `${row.campus_code} · ${row.campus_name}`, "No campus specified");
    refreshVersions();
  }
  function refreshVersions() {
    const programmeId = form.elements.programmeId.value;
    const rows = state.refs.programmeVersions.filter(row => row.programme_id === programmeId);
    options(form.elements.programmeVersionId, rows, "id", row => `${row.version_code} · ${row.version_name || "Programme version"}`, "Select version (optional)");
  }
  function params() {
    const query = new URLSearchParams({ page: String(state.page), limit: String(state.limit) });
    const add = (key, selector) => { const value = $(selector).value.trim(); if (value) query.set(key, value); };
    add("search", "#searchFilter"); add("programmeId", "#programmeFilter"); add("academicYearId", "#academicYearFilter"); add("admissionYear", "#yearFilter"); add("intakeCode", "#intakeFilter"); add("status", "#statusFilter");
    return query;
  }
  async function loadCohorts() {
    clearNotice(); $("#cohortRows").innerHTML = '<tr><td colspan="8" class="empty">Loading cohorts…</td></tr>';
    try {
      const result = payload(await IDMCAPI.get(`/cohorts?${params()}`));
      state.rows = result.rows || []; state.total = result.total || 0;
      $("#resultCount").textContent = `${state.total} cohort${state.total === 1 ? "" : "s"}`;
      $("#pageLabel").textContent = `Page ${state.page} of ${Math.max(1, Math.ceil(state.total / state.limit))}`;
      $("#previousButton").disabled = state.page <= 1;
      $("#nextButton").disabled = state.page * state.limit >= state.total;
      renderCohorts();
    } catch (error) { $("#cohortRows").innerHTML = `<tr><td colspan="8" class="empty">${esc(error.message || "Unable to load cohorts.")}</td></tr>`; notice(error.message || "Unable to load cohorts.", "error"); }
  }
  function programmeName(id) {
    const row = state.refs.programmes.find(item => item.id === id);
    return row ? `${row.programme_code} · ${row.programme_name}` : "Programme unavailable";
  }
  function campusName(id) {
    const row = state.refs.campuses.find(item => item.id === id);
    return row ? row.campus_name : "No campus";
  }
  function versionName(id) {
    const row = state.refs.programmeVersions.find(item => item.id === id);
    return row ? `${row.version_code}${row.version_name ? ` · ${row.version_name}` : ""}` : "";
  }
  function yearName(id) {
    const row = state.refs.academicYears.find(item => item.id === id);
    return row ? `${row.year_code} · ${row.year_name}` : "";
  }
  function renderCohorts() {
    const body = $("#cohortRows");
    if (!state.rows.length) { body.innerHTML = '<tr><td colspan="8" class="empty">No cohorts match these filters. Create a cohort to get started.</td></tr>'; return; }
    body.innerHTML = state.rows.map(row => `<tr>
      <td><strong>${esc(row.cohort_code)}</strong><small>${esc(row.cohort_name)}</small></td>
      <td>${esc(programmeName(row.programme_id))}${row.programme_version_id ? `<small>${esc(versionName(row.programme_version_id))}</small>` : ""}</td>
      <td>${esc(row.entry_year)}${yearName(row.default_academic_year_id) ? `<small>${esc(yearName(row.default_academic_year_id))}</small>` : ""}${row.intake_name ? `<small>${esc(row.intake_name)}${row.intake_code ? ` · ${esc(row.intake_code)}` : ""}</small>` : ""}</td>
      <td>${esc(String(row.study_mode || "FULL_TIME").replaceAll("_", " "))}<small>${esc(campusName(row.campus_id))}</small></td>
      <td>${esc(row.student_count ?? 0)}</td><td>${row.max_capacity ? `${esc(row.student_count ?? 0)} / ${esc(row.max_capacity)}` : "No limit"}</td>
      <td><span class="badge ${esc(String(row.status || "").toLowerCase())}">${esc(row.status)}</span></td>
      <td><div class="actions"><button class="secondary" data-roster="${esc(row.id)}">Students</button>${state.canManage ? `<button class="secondary" data-edit="${esc(row.id)}">Edit</button>` : ""}</div></td>
    </tr>`).join("");
  }
  function showForm(row = null) {
    state.editing = row?.id || null;
    form.reset();
    if (row) {
      for (const [key, value] of Object.entries({ cohortCode: row.cohort_code, cohortName: row.cohort_name, programmeId: row.programme_id, programmeVersionId: row.programme_version_id, academicYearId: row.default_academic_year_id, intakeCode: row.intake_code, intakeName: row.intake_name, admissionYear: row.entry_year, startDate: row.start_date, expectedCompletionDate: row.expected_completion_date, studyMode: row.study_mode, campusId: row.campus_id, maxCapacity: row.max_capacity, status: row.status, notes: row.notes })) form.elements[key].value = value ?? "";
      refreshVersions(); form.elements.programmeVersionId.value = row.programme_version_id || "";
    } else {
      form.elements.admissionYear.value = new Date().getFullYear();
      form.elements.status.value = "ACTIVE";
      form.elements.studyMode.value = "FULL_TIME";
    }
    $("#formTitle").textContent = row ? `Edit ${row.cohort_code}` : "Create cohort";
    $("#formCard").hidden = !state.canManage;
    $("#formCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function saveCohort(event) {
    event.preventDefault(); clearNotice();
    const raw = Object.fromEntries(new FormData(form).entries());
    raw.admissionYear = Number(raw.admissionYear);
    raw.maxCapacity = raw.maxCapacity ? Number(raw.maxCapacity) : null;
    try {
      const result = await (state.editing ? IDMCAPI.patch(`/cohorts/${encodeURIComponent(state.editing)}`, raw) : IDMCAPI.post("/cohorts", raw));
      const row = payload(result);
      notice(state.editing ? "Cohort updated." : `Cohort ${row.cohort_code} created.`);
      $("#formCard").hidden = true; await loadCohorts();
    } catch (error) { notice(error.message || "Unable to save cohort.", "error"); }
  }
  async function editCohort(id) {
    try { const row = payload(await IDMCAPI.get(`/cohorts/${encodeURIComponent(id)}`)); showForm(row); }
    catch (error) { notice(error.message || "Unable to load cohort.", "error"); }
  }
  async function loadRoster(id, page = 1) {
    try {
      if (state.roster?.id !== id) state.rosterPage = 1;
      state.rosterPage = page;
      const row = state.rows.find(item => item.id === id) || payload(await IDMCAPI.get(`/cohorts/${encodeURIComponent(id)}`));
      const result = payload(await IDMCAPI.get(`/cohorts/${encodeURIComponent(id)}/students?page=${state.rosterPage}&limit=${state.rosterLimit}`));
      state.roster = row;
      state.rosterTotal = result.total || 0;
      $("#rosterTitle").textContent = `${row.cohort_code} · ${row.cohort_name}`;
      $("#rosterCount").textContent = `${state.rosterTotal} students`;
      $("#rosterPageLabel").textContent = `Page ${state.rosterPage} of ${Math.max(1, Math.ceil(state.rosterTotal / state.rosterLimit))}`;
      $("#rosterPreviousButton").disabled = state.rosterPage <= 1;
      $("#rosterNextButton").disabled = state.rosterPage * state.rosterLimit >= state.rosterTotal;
      $("#assignButton").hidden = !state.canManage || row.status !== "ACTIVE";
      $("#rosterRows").innerHTML = result.rows?.length ? result.rows.map(student => {
        const name = [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ");
        const program = state.refs.programmes.find(item => item.id === student.programme_id);
        return `<tr><td><strong>${esc(student.student_number)}</strong></td><td>${esc(name)}</td><td>${esc(program?.programme_code || "—")}</td><td>${esc(student.admission_year || "—")}</td><td>${esc(student.student_status)}</td><td>${state.canManage ? `<button class="roster-remove" data-remove="${esc(student.id)}">Remove / transfer</button>` : ""}</td></tr>`;
      }).join("") : '<tr><td colspan="6" class="empty">No students assigned to this cohort.</td></tr>';
      $("#rosterCard").hidden = false; $("#rosterCard").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) { notice(error.message || "Unable to load cohort roster.", "error"); }
  }
  async function loadCandidates() {
    if (!state.roster) return;
    try {
      const query = new URLSearchParams({ page: String(state.candidatePage), limit: String(state.candidateLimit), search: $("#studentSearch").value.trim() });
      const result = payload(await IDMCAPI.get(`/cohorts/${encodeURIComponent(state.roster.id)}/available-students?${query}`));
      state.candidates = result.rows || []; state.candidateTotal = result.total || 0;
      $("#candidatePageLabel").textContent = `Page ${state.candidatePage} of ${Math.max(1, Math.ceil(state.candidateTotal / state.candidateLimit))}`;
      $("#candidatePreviousButton").disabled = state.candidatePage <= 1;
      $("#candidateNextButton").disabled = state.candidatePage * state.candidateLimit >= state.candidateTotal;
      $("#candidateSelectionCount").textContent = `${state.selectedCandidates.size} student${state.selectedCandidates.size === 1 ? "" : "s"} selected (maximum 200)`;
      $("#candidateRows").innerHTML = state.candidates.length ? state.candidates.map(student => {
        const name = [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ");
        const isCurrent = student.cohort_id === state.roster.id;
        const checked = state.selectedCandidates.has(student.id);
        return `<label class="candidate"><input type="checkbox" value="${esc(student.id)}" ${checked ? "checked" : ""} ${isCurrent ? "disabled" : ""}><span><strong>${esc(student.student_number)}</strong><small>${esc(name)} · ${esc(student.student_status)}</small></span><span class="candidate-tag">${isCurrent ? "Already in cohort" : student.cohort_id ? "Transfer from another cohort" : "Unassigned"}</span></label>`;
      }).join("") : '<p class="empty">No student records found.</p>';
    } catch (error) { $("#candidateRows").innerHTML = `<p class="empty">${esc(error.message || "Unable to find students.")}</p>`; }
  }
  async function assignStudents(event) {
    event.preventDefault();
    const studentIds = [...state.selectedCandidates];
    const reason = $("#assignmentReason").value.trim();
    if (!studentIds.length) { notice("Select at least one student.", "error"); return; }
    if (studentIds.length > 200) { notice("Select no more than 200 students per assignment.", "error"); return; }
    try {
      await IDMCAPI.post(`/cohorts/${encodeURIComponent(state.roster.id)}/students`, { studentIds, reason });
      $("#assignDialog").close(); $("#assignForm").reset(); state.selectedCandidates.clear(); notice(`${studentIds.length} student record(s) assigned or transferred.`); await loadCohorts(); await loadRoster(state.roster.id, state.rosterPage);
    } catch (error) { notice(error.message || "Unable to assign students.", "error"); }
  }
  async function removeStudent(studentId) {
    const reason = window.prompt("Enter the reason for removing this student from the cohort:");
    if (reason === null) return;
    try {
      await IDMCAPI.delete(`/cohorts/${encodeURIComponent(state.roster.id)}/students/${encodeURIComponent(studentId)}`, { body: JSON.stringify({ reason }), headers: { "Content-Type": "application/json" } });
      notice("Student removed from cohort."); await loadCohorts(); await loadRoster(state.roster.id, state.rosterPage);
    } catch (error) { notice(error.message || "Unable to remove student.", "error"); }
  }
  async function exportCsv() {
    try {
      const query = new URLSearchParams();
      const programme = $("#programmeFilter").value, academicYear = $("#academicYearFilter").value, year = $("#yearFilter").value, intake = $("#intakeFilter").value;
      if (programme) query.set("programmeId", programme); if (academicYear) query.set("academicYearId", academicYear); if (year) query.set("admissionYear", year); if (intake) query.set("intakeCode", intake);
      const base = String(IDMC_CONFIG.API_BASE_URL || IDMCAPI.baseUrl).replace(/\/$/, "");
      const response = await fetch(`${base}/cohorts/export.csv?${query}`, { headers: { Authorization: `Bearer ${IDMCAuth.getAccessToken()}`, Accept: "text/csv" } });
      if (!response.ok) { const error = new Error(`Export failed with HTTP ${response.status}.`); error.status = response.status; error.requestId = response.headers?.get("x-request-id"); throw error; }
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = url; link.download = "idmc-cohorts.csv"; link.click(); URL.revokeObjectURL(url);
    } catch (error) { notice(IDMCAPI.toUserMessage(error) || "Unable to export cohorts.", "error"); }
  }
  function bind() {
    $("#newButton").addEventListener("click", () => showForm());
    $("#cancelButton").addEventListener("click", () => { $("#formCard").hidden = true; });
    $("#refreshButton").addEventListener("click", loadCohorts);
    $("#filterButton").addEventListener("click", () => { state.page = 1; loadCohorts(); });
    $("#searchFilter").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); state.page = 1; loadCohorts(); } });
    $("#previousButton").addEventListener("click", () => { if (state.page > 1) { state.page--; loadCohorts(); } });
    $("#nextButton").addEventListener("click", () => { if (state.page * state.limit < state.total) { state.page++; loadCohorts(); } });
    $("#exportButton").addEventListener("click", exportCsv);
    $("#closeRosterButton").addEventListener("click", () => { $("#rosterCard").hidden = true; });
    $("#rosterPreviousButton").addEventListener("click", () => { if (state.rosterPage > 1) loadRoster(state.roster.id, state.rosterPage - 1); });
    $("#rosterNextButton").addEventListener("click", () => { if (state.rosterPage * state.rosterLimit < state.rosterTotal) loadRoster(state.roster.id, state.rosterPage + 1); });
    $("#assignButton").addEventListener("click", async () => { $("#studentSearch").value = ""; $("#assignmentReason").value = ""; state.candidatePage = 1; state.selectedCandidates.clear(); await loadCandidates(); $("#assignDialog").showModal(); });
    $("#candidatePreviousButton").addEventListener("click", () => { if (state.candidatePage > 1) { state.candidatePage--; loadCandidates(); } });
    $("#candidateNextButton").addEventListener("click", () => { if (state.candidatePage * state.candidateLimit < state.candidateTotal) { state.candidatePage++; loadCandidates(); } });
    $("#candidateRows").addEventListener("change", event => {
      const checkbox = event.target.closest('input[type="checkbox"]'); if (!checkbox) return;
      if (checkbox.checked && !state.selectedCandidates.has(checkbox.value) && state.selectedCandidates.size >= 200) { checkbox.checked = false; notice("A maximum of 200 students can be assigned in one request.", "error"); return; }
      if (checkbox.checked) state.selectedCandidates.add(checkbox.value); else state.selectedCandidates.delete(checkbox.value);
      $("#candidateSelectionCount").textContent = `${state.selectedCandidates.size} student${state.selectedCandidates.size === 1 ? "" : "s"} selected (maximum 200)`;
    });
    $("#studentSearch").addEventListener("input", () => { window.clearTimeout(state.searchTimer); state.searchTimer = window.setTimeout(() => { state.candidatePage = 1; loadCandidates(); }, 250); });
    $("#assignForm").addEventListener("submit", assignStudents);
    $("#closeAssignButton").addEventListener("click", () => $("#assignDialog").close());
    $("#logoutButton").addEventListener("click", () => IDMCAuth.logout());
    form.addEventListener("submit", saveCohort);
    form.elements.programmeId.addEventListener("change", refreshVersions);
    document.addEventListener("click", async event => {
      const edit = event.target.closest("[data-edit]"); if (edit) return editCohort(edit.dataset.edit);
      const roster = event.target.closest("[data-roster]"); if (roster) return loadRoster(roster.dataset.roster);
      const remove = event.target.closest("[data-remove]"); if (remove) return removeStudent(remove.dataset.remove);
    });
  }
  async function init() {
    try {
      await IDMCAuth.requireAuth();
      if (!IDMCAuth.hasPermission("cohorts.view")) { IDMCAuth.requirePermission("cohorts.view"); return; }
      state.canManage = IDMCAuth.hasPermission("cohorts.manage");
      $("#newButton").hidden = !state.canManage; $("#formCard").hidden = true;
      $("#assignButton").hidden = !state.canManage;
      const ref = payload(await IDMCAPI.get("/cohorts/reference-data"));
      state.refs = ref; populateReferences(); bind(); await loadCohorts();
    } catch (error) { notice(error.message || "Unable to initialize cohort management.", "error"); }
  }
  init();
})();
