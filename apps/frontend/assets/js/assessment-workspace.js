(function () {
  "use strict";
  const intakeLabel=document.createElement('label');intakeLabel.textContent='Student intake';const intakeSelect=document.createElement('select');intakeSelect.id='marksIntake';intakeSelect.innerHTML='<option value="">Choose intake</option><option value="MARCH">March Intake</option><option value="SEPTEMBER">September Intake</option>';intakeLabel.append(intakeSelect);document.getElementById('markAssessment').parentElement.append(intakeLabel);


  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const state = { offerings: [], assessments: [], roster: [], selected: null };
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  function message(text, type = "") {
    const element = $("#assessmentMessage");
    element.textContent = text || "";
    element.className = "aw-message " + type;
  }

  function option(assessment) {
    return `<option value="${esc(assessment.id)}">${esc(assessment.assessment_code)} — ${esc(assessment.assessment_name)} | ${esc(assessment.course_label)}</option>`;
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return `"${text.replace(/"/g, '""')}"`;
  }

  function downloadCsv(filename, rows) {
    const content = rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
    const url = URL.createObjectURL(new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function parseCsv(text) {
    const rows = [];
    let row = [], value = "", quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted && char === '"' && text[i + 1] === '"') { value += '"'; i += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) { row.push(value); value = ""; }
      else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && text[i + 1] === "\n") i += 1;
        row.push(value); value = "";
        if (row.some((cell) => cell.trim() !== "")) rows.push(row);
        row = [];
      } else value += char;
    }
    if (quoted) throw new Error("CSV has an unclosed quotation mark.");
    row.push(value);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
    return rows;
  }

  function selectedOfferings() {
    return $$("input[name='courseOfferingIds']:checked").map((input) => input.value);
  }

  function renderCourses() {
    const container = $("#assessmentCourseChoices");
    if (!state.offerings.length) {
      container.innerHTML = '<span class="aw-empty">No course offerings are available for your account.</span>';
      return;
    }
    container.innerHTML = state.offerings.map((offering) => `
      <label class="aw-course-choice">
        <input type="checkbox" name="courseOfferingIds" value="${esc(offering.id)}">
        <span>${esc(offering.label)}</span>
      </label>`).join("");
  }

  function render() {
    const query = $("#assessmentSearch").value.trim().toLowerCase();
    const records = state.assessments.filter((item) => !query || JSON.stringify(item).toLowerCase().includes(query));
    $("#assessmentCount").textContent = `${records.length} record${records.length === 1 ? "" : "s"}`;
    $("#assessmentRows").innerHTML = records.length ? records.map((item) => `
      <tr><td>${esc(item.course_label)}</td><td>${esc(item.assessment_code)}</td><td>${esc(item.assessment_name)}</td>
      <td>${esc(item.assessment_type)}</td><td>${esc(item.maximum_marks)}</td><td>${esc(item.weight_percentage)}%</td>
      <td>${esc(item.due_date || "—")} ${esc(item.due_time || "")}</td><td>${esc(item.status)}</td></tr>`).join("")
      : '<tr><td colspan="8" class="aw-empty">No assessments found.</td></tr>';
    $("#markAssessment").innerHTML = '<option value="">Select an assessment</option>' + state.assessments.map(option).join("");
  }

  async function load() {
    message("Loading assessment records…");
    try {
      const response = await IDMCAPI.get("/assessment/workspace");
      state.assessments = response.data.assessments || [];
      state.offerings = response.data.offerings || [];
      renderCourses();
      render();
      message(`${state.assessments.length} assessment records loaded.`, "success");
    } catch (error) {
      message(error.message || "Unable to load assessments.", "error");
    }
  }

  async function loadRoster() {
    const id = $("#markAssessment").value;
    if (!id) { message("Select an assessment first.", "error"); return; }
    message("Loading registered students…");
    try {
      const response = await IDMCAPI.get(`/assessment/workspace/assessments/${encodeURIComponent(id)}/roster?intakeCode=${encodeURIComponent(document.getElementById("marksIntake").value)}`);
      state.selected = response.data.assessment;
      state.roster = response.data.roster || [];
      $("#markSummary").textContent = `${state.selected.assessment_code} — ${state.selected.assessment_name} | Maximum marks: ${state.selected.maximum_marks} | ${state.roster.length} registered student(s)${response.data.sharedRoster ? ` | shared roster across ${response.data.offeringCount} programme offering(s)` : ""}`;
      $("#markRows").innerHTML = state.roster.length ? state.roster.map((student, index) => `
        <tr data-row="${index}"><td>${index + 1}</td><td>${esc(student.studentNumber)}</td><td>${esc(student.studentName)}</td><td>${esc(student.programme || "—")}</td>
        <td><input type="number" min="0" max="${esc(state.selected.maximum_marks)}" step="0.01" value="${esc(student.marks ?? "")}" required aria-label="Marks for ${esc(student.studentNumber)}"></td>
        <td><input type="text" maxlength="1000" value="${esc(student.remarks || "")}" aria-label="Remarks for ${esc(student.studentNumber)}"></td><td>${esc(student.status)}</td></tr>`).join("")
        : '<tr><td colspan="7" class="aw-empty">No registered students found for this course offering.</td></tr>';
      $("#saveMarks").disabled = !state.roster.length;
      $("#downloadMarksTemplate").disabled = !state.roster.length;
      $("#marksCsvFile").disabled = !state.roster.length;
      message("Student register loaded.", "success");
    } catch (error) {
      message(error.message || "Unable to load students.", "error");
    }
  }

  async function saveMarks(event) {
    event.preventDefault();
    if (!state.selected || !state.roster.length) return;
    try {
      const rows = state.roster.map((student, index) => {
        const inputs = $(`#markRows tr[data-row="${index}"]`).querySelectorAll("input");
        const marks = Number(inputs[0].value);
        if (!Number.isFinite(marks) || marks < 0 || marks > Number(state.selected.maximum_marks)) {
          throw new Error(`Check marks for ${student.studentNumber}; maximum is ${state.selected.maximum_marks}.`);
        }
        return { studentId: student.studentId, registrationId: student.registrationId, studentNumber: student.studentNumber, marks, remarks: inputs[1].value };
      });
      message("Saving draft marks…");
      await IDMCAPI.post(`/assessment/workspace/assessments/${encodeURIComponent(state.selected.id)}/marks`, { rows });
      message("Draft marks saved successfully.", "success");
      await loadRoster();
    } catch (error) {
      message(error.message || "Marks could not be saved.", "error");
    }
  }

  function downloadMarksTemplate() {
    if (!state.selected || !state.roster.length) return;
    downloadCsv("IDMS-marks-template.csv", [
      ["registrationNumber", "studentName", "marks", "remarks"],
      ...state.roster.map((student) => [student.studentNumber, student.studentName, student.marks ?? "", student.remarks ?? ""])
    ]);
  }

  async function importMarksCsv(event) {
    const file = event.target.files?.[0];
    if (!file || !state.selected || !state.roster.length) return;
    try {
      const parsed = parseCsv((await file.text()).replace(/^\uFEFF/, ""));
      if (parsed.length < 2) throw new Error("CSV must contain a header and at least one student row.");
      const headers = parsed[0].map((value) => value.trim().toLowerCase());
      const regIndex = headers.indexOf("registrationnumber");
      const marksIndex = headers.indexOf("marks");
      const remarksIndex = headers.indexOf("remarks");
      if (regIndex < 0 || marksIndex < 0) throw new Error("CSV needs registrationNumber and marks columns. Use the template button.");
      const rosterByNumber = new Map(state.roster.map((student) => [String(student.studentNumber).trim(), student]));
      const seen = new Set();
      const imported = new Map();
      for (const row of parsed.slice(1)) {
        const number = String(row[regIndex] || "").trim();
        if (!number) continue;
        const student = rosterByNumber.get(number);
        if (!student) throw new Error(`Registration number ${number} is not on the selected course.`);
        if (seen.has(number)) throw new Error(`Duplicate registration number: ${number}.`);
        seen.add(number);
        const marks = Number(row[marksIndex]);
        if (row[marksIndex] === "" || !Number.isFinite(marks) || marks < 0 || marks > Number(state.selected.maximum_marks)) {
          throw new Error(`Invalid marks for ${number}; maximum is ${state.selected.maximum_marks}.`);
        }
        imported.set(number, { marks: String(marks), remarks: remarksIndex >= 0 ? row[remarksIndex] || "" : "" });
      }
      state.roster.forEach((student, index) => {
        const values = imported.get(String(student.studentNumber).trim());
        if (!values) return;
        const inputs = $(`#markRows tr[data-row="${index}"]`).querySelectorAll("input");
        inputs[0].value = values.marks;
        inputs[1].value = values.remarks;
      });
      message(`${imported.size} CSV rows validated and loaded. Review them, then choose Save Draft Marks.`, "success");
    } catch (error) {
      message(error.message || "CSV could not be read.", "error");
    } finally {
      event.target.value = "";
    }
  }

  function readAssessmentForm() {
    const data = {};
    for (const [key, value] of new FormData($("#assessmentForm"))) {
      if (key !== "courseOfferingIds" && String(value).trim() !== "") data[key] = value;
    }
    return data;
  }

  function bindTabs() {
    for (const button of $$(".aw-tabs button")) button.onclick = () => {
      $$(".aw-tabs button, .aw-panel").forEach((element) => element.classList.remove("active"));
      button.classList.add("active");
      $(`[data-panel="${button.dataset.view}"]`).classList.add("active");
    };
  }

  async function init() {
    try { if (!(await IDMCAuth.requireAuth())) return; } catch { return; }
    bindTabs();
    $("#assessmentSearch").oninput = render;
    $("#refreshAssessment").onclick = load;
    $("#openAssessmentForm").onclick = () => $("#assessmentDialog").showModal();
    $("#closeAssessmentForm").onclick = $("#cancelAssessmentForm").onclick = () => $("#assessmentDialog").close();
    $("#loadMarkRoster").onclick = loadRoster;
    $("#marksForm").onsubmit = saveMarks;
    $("#downloadMarksTemplate").onclick = downloadMarksTemplate;
    $("#marksCsvFile").onchange = importMarksCsv;
    $("#assessmentForm").onsubmit = async (event) => {
      event.preventDefault();
      const courseOfferingIds = selectedOfferings();
      if (!courseOfferingIds.length) { message("Select at least one course offering.", "error"); return; }
      const data = readAssessmentForm();
      try {
        message("Saving assessment…");
        if (courseOfferingIds.length === 1) {
          await IDMCAPI.post("/assessment/workspace/assessments", { ...data, courseOfferingId: courseOfferingIds[0] });
        } else {
          await IDMCAPI.post("/improvements/assessments/batch", { ...data, courseOfferingIds });
        }
        $("#assessmentDialog").close();
        event.target.reset();
        await load();
        message(`Assessment created for ${courseOfferingIds.length} course offering(s).`, "success");
      } catch (error) {
        message(error.message || "Assessment could not be saved.", "error");
      }
    };
    await load();
  }

  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", init, { once: true })
    : init();
})();
