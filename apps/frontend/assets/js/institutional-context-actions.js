(function () {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const unwrap = (response) => response && Object.prototype.hasOwnProperty.call(response, "data") ? response.data : response;
  const workspace = document.body.dataset.workspace;
  const message = (text, type = "info") => {
    const box = $("#workspaceMessage") || $("#lecturerCourseMessage");
    if (box) { box.textContent = text; box.className = `iw-message show ${type}`; }
  };
  const downloadCsv = (filename, rows) => {
    const cell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const text = "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  function parseCsv(text) {
    const rows = []; let row = [], value = "", quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quoted && ch === '"' && text[i + 1] === '"') { value += '"'; i += 1; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) { row.push(value); value = ""; }
      else if ((ch === "\n" || ch === "\r") && !quoted) { if (ch === "\r" && text[i + 1] === "\n") i += 1; row.push(value); if (row.some((v) => v.trim())) rows.push(row); row = []; value = ""; }
      else value += ch;
    }
    if (quoted) throw new Error("CSV quotation marks are not balanced.");
    row.push(value); if (row.some((v) => v.trim())) rows.push(row);
    return rows;
  }
  function renderDialog(title, fields, onSubmit) {
    let dialog = $("#idmcContextDialog");
    if (!dialog) {
      dialog = document.createElement("dialog"); dialog.id = "idmcContextDialog"; dialog.className = "iw-context-dialog";
      dialog.innerHTML = '<form method="dialog" id="idmcContextForm"><header><div><span class="eyebrow">IDMS iMIS</span><h2 id="idmcContextTitle"></h2><p id="idmcContextHint"></p></div><button type="button" id="idmcContextClose" aria-label="Close">×</button></header><div class="iw-context-fields" id="idmcContextFields"></div><div class="iw-context-status" id="idmcContextStatus" role="status" aria-live="polite"></div><footer><button type="button" class="btn" id="idmcContextCancel">Cancel</button><button type="submit" class="btn primary">Submit</button></footer></form>';
      document.body.append(dialog);
      $("#idmcContextClose").onclick = $("#idmcContextCancel").onclick = () => dialog.close();
    }
    $("#idmcContextTitle").textContent = title;
    $("#idmcContextHint").textContent = "Complete the fields below. Records are checked by the backend before they are saved.";
    $("#idmcContextFields").innerHTML = fields;
    $("#idmcContextStatus").textContent = "";
    const form = $("#idmcContextForm");
    form.onsubmit = async (event) => { event.preventDefault(); const submit = form.querySelector('[type="submit"]'); submit.disabled = true; try { await onSubmit(form); dialog.close(); } catch (error) { $("#idmcContextStatus").textContent = error.message || "Could not complete this action."; } finally { submit.disabled = false; } };
    dialog.showModal(); return dialog;
  }
  function addButton(label, handler, permission) {
    const host = $("#contextActions"); if (!host || host.querySelector(`[data-context-action="${permission}"]`)) return;
    const button = document.createElement("button"); button.type = "button"; button.className = "btn primary"; button.textContent = label; button.dataset.contextAction = permission; button.onclick = handler; host.append(button);
  }
  async function get(path) { return unwrap(await IDMCAPI.get(path)); }
  async function post(path, body) { return unwrap(await IDMCAPI.post(path, body)); }
  function listRows(value) {
    let current = value;
    for (let i = 0; i < 5 && current && !Array.isArray(current); i += 1) {
      if (Array.isArray(current.items)) return current.items;
      if (Array.isArray(current.rows)) return current.rows;
      if (Array.isArray(current.records)) return current.records;
      if (Array.isArray(current.data)) return current.data;
      current = current.data;
    }
    return Array.isArray(current) ? current : [];
  }

  async function examinationControls(caps) {
    if (!(caps.permissions || []).includes("examinations.manage")) return;
    addButton("Create papers & schedule", async () => {
      try {
        const [refs, periods, campuses] = await Promise.all([get("/improvements/references"), get("/examinations/periods"), get("/academic-core/reference-data?resource=campuses")]);
        const editablePeriods = (Array.isArray(periods) ? periods : []).filter((p) => ["DRAFT", "PLANNING", "APPROVED"].includes(String(p.status).toUpperCase()));
        const periodOptions = editablePeriods.map((p) => `<option value="${esc(p.id)}">${esc(p.period_name)} · ${esc(p.period_code)}</option>`).join("");
        const campusRows = Array.isArray(campuses) ? campuses : campuses.rows || [];
        const campusOptions = campusRows.filter((x) => x.status === "ACTIVE").map((x) => `<option value="${esc(x.id)}">${esc(x.campus_name || x.campus_code)}</option>`).join("");
        const offers = refs.offerings || [];
        const fields = `<label class="wide">Examination period<select name="examinationPeriodId" required><option value="">Choose period</option>${periodOptions}</select></label><fieldset class="wide iw-context-choice"><legend>Course offerings</legend>${offers.map((o) => `<label><input type="checkbox" name="courseOfferingIds" value="${esc(o.id)}">${esc(o.label)}</label>`).join("") || "<p>No offerings found.</p>"}</fieldset><label>Campus<select name="campusId" required><option value="">Choose campus</option>${campusOptions}</select></label><label>Examination date<input name="examinationDate" type="date" required></label><label>Start time<input name="startTime" type="time" value="09:00" required></label><label>Duration in minutes<input name="durationMinutes" type="number" min="1" value="120" required></label><label>Room or hall name<input name="roomName" maxlength="120" required placeholder="e.g. Main Hall"></label><label>Capacity<input name="capacity" type="number" min="1" required></label>`;
        renderDialog("Create examination papers and schedule", fields, async (form) => {
          const courseOfferingIds = [...form.querySelectorAll('[name="courseOfferingIds"]:checked')].map((x) => x.value);
          if (!courseOfferingIds.length) throw new Error("Select at least one course offering.");
          const fd = new FormData(form);
          const result = await post("/improvements/examinations/combined", { examinationPeriodId: fd.get("examinationPeriodId"), courseOfferingIds, campusId: fd.get("campusId"), examinationDate: fd.get("examinationDate"), startTime: fd.get("startTime"), durationMinutes: Number(fd.get("durationMinutes")), roomName: fd.get("roomName"), capacity: Number(fd.get("capacity")) });
          message(`Created ${Array.isArray(result) ? result.length : "the"} examination schedule record(s).`, "success"); $("#refreshWorkspace")?.click();
        });
      } catch (error) { message(error.message || "Could not load exam options.", "error"); }
    }, "examinations.manage");
  }

  async function timetableControls(caps) {
    if (!(caps.permissions || []).includes("timetable.manage")) return;
    addButton("Import timetable CSV", async () => {
      try {
        const [timetables, refs] = await Promise.all([get("/timetables"), get("/improvements/references")]);
        const rows = Array.isArray(timetables) ? timetables : timetables.rows || [];
        const editable = rows.filter((r) => !["PUBLISHED", "LOCKED", "CANCELLED"].includes(String(r.status).toUpperCase()));
        if (!editable.length) throw new Error("Create an editable timetable record first.");
        const offers = refs.offerings || [], years = refs.years || [], semesters = refs.semesters || [], programmes = refs.programmes || [];
        const fields = `<label class="wide">Editable timetable<select name="timetableId" required><option value="">Choose timetable</option>${editable.map((r) => `<option value="${esc(r.id)}">${esc(r.timetable_name || r.timetable_code)} · ${esc((years.find((y) => y.id === r.academic_year_id) || {}).year_name || "Year")} · ${esc((semesters.find((s) => s.id === r.semester_id) || {}).semester_name || "Semester")}</option>`).join("")}</select></label><p class="wide">CSV columns: courseCode, dayOfWeek (1–7), startTime (HH:MM), endTime (HH:MM), roomCode. Course offering is matched to the selected timetable period.</p><label class="wide">CSV file<input name="file" type="file" accept=".csv,text/csv" required></label><button class="btn" type="button" id="downloadTimetableCsv">Download template for selected timetable</button>`;
        renderDialog("Import timetable sessions", fields, async (form) => {
          const file = form.elements.file.files[0]; if (!file || file.size > 5 * 1024 * 1024) throw new Error("Choose a CSV file smaller than 5 MB.");
          const parsed = parseCsv((await file.text()).replace(/^\uFEFF/, "")); if (parsed.length < 2) throw new Error("CSV has no timetable rows.");
          const headers = parsed[0].map((x) => x.trim().toLowerCase());
          const idx = Object.fromEntries(["courseofferingid", "coursecode", "coursename", "offeringcode", "programmename", "dayofweek", "starttime", "endtime", "roomcode"].map((k) => [k, headers.indexOf(k)]));
          if (["coursecode", "dayofweek", "starttime", "endtime", "roomcode"].some((k) => idx[k] < 0)) throw new Error("CSV headers must include courseCode, dayOfWeek, startTime, endTime and roomCode.");
          const timetableId = form.elements.timetableId.value;
          const selected = editable.find((x) => x.id === timetableId); const mappedOffers = offers.filter((o) => o.academic_year_id === selected.academic_year_id && o.semester_id === selected.semester_id);
          const normalized = parsed.slice(1).filter((r) => r.some((x) => x.trim())).map((r, line) => {
            const code = (r[idx.coursecode] || "").trim().toLowerCase();
            const suppliedId = idx.courseofferingid >= 0 ? (r[idx.courseofferingid] || "").trim() : "";
            const courseName=idx.coursename>=0?(r[idx.coursename]||"").trim().toLowerCase():"",offeringCode=idx.offeringcode>=0?(r[idx.offeringcode]||"").trim().toLowerCase():"";
            const programmeName=idx.programmename>=0?(r[idx.programmename]||"").trim().toLowerCase():"";
            const matches = mappedOffers.filter((o) => {const p=programmes.find(p=>p.id===o.programme_id);return (suppliedId ? o.id === suppliedId : String(o.course?.course_code || o.offering_code || "").toLowerCase() === code)&&(!courseName||String(o.course?.course_name||"").toLowerCase()===courseName)&&(!offeringCode||String(o.offering_code||"").toLowerCase()===offeringCode)&&(!programmeName||[p?.programme_name,p?.programme_code].some(n=>String(n||"").toLowerCase()===programmeName));});
            if (matches.length !== 1) throw new Error(`Line ${line + 2}: courseCode '${code}' is not unique in the selected period.`);
            const dayOfWeek = Number(r[idx.dayofweek]); if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) throw new Error(`Line ${line + 2}: dayOfWeek must be 1–7.`);
            return { courseOfferingId: matches[0].id, dayOfWeek, startTime: (r[idx.starttime] || "").trim(), endTime: (r[idx.endtime] || "").trim(), roomCode: (r[idx.roomcode] || "").trim() };
          });
          if (!normalized.length || normalized.length > 500) throw new Error("Import between 1 and 500 timetable rows.");
          const count = await post("/improvements/timetable/import", { timetableId, rows: normalized });
          message(`Imported ${count} timetable session(s).`, "success"); $("#refreshWorkspace")?.click();
        });
        $("#downloadTimetableCsv").onclick = () => {
          const timetable = $("#idmcContextForm").elements.timetableId.value; if (!timetable) { $("#idmcContextStatus").textContent = "Select a timetable first."; return; }
          const chosen = editable.find((x) => x.id === timetable); const selectedOffers = offers.filter((o) => o.academic_year_id === chosen.academic_year_id && o.semester_id === chosen.semester_id);
          downloadCsv("IDMS-timetable-template.csv", [["offeringCode", "courseCode", "courseName", "programmeName", "dayOfWeek", "startTime", "endTime", "roomCode"], ...selectedOffers.map((o) => [o.offering_code, o.course?.course_code || "", o.course?.course_name || "", programmes.find(p=>p.id===o.programme_id)?.programme_name || "", "", "", "", ""])]);
        };
      } catch (error) { message(error.message || "Could not load timetable options.", "error"); }
    }, "timetable.manage");
  }

  function fileAsBase64(file) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error(`Could not read ${file.name}.`)); reader.onload = () => resolve(String(reader.result).split(",")[1] || ""); reader.readAsDataURL(file); });
  }
  async function staffControls(caps) {
    if (!(caps.roles || []).some((r) => ["ADMIN", "SUPER_ADMIN"].includes(r))) return;
    addButton("Register staff member", async () => {
      try {
        const [institutionResponse, departmentResponse] = await Promise.all([get("/institutions"), get("/departments")]);
        const inst = listRows(institutionResponse), deps = listRows(departmentResponse);
        const idms = inst.find((row) => String(row.institution_code || "").toUpperCase() === "IDMS");
        if (!idms) throw new Error("IDMS institution record was not returned by Institution Management.");
        const activeDepartments = deps.filter((row) => String(row.institution_id || "") === String(idms.id) && String(row.status || "").toUpperCase() === "ACTIVE");
        const fields = `<div class="wide iw-context-lock"><label>Institution (locked)<input value="${esc(idms.institution_name || idms.name || "IDMS")}" readonly><input type="hidden" name="institutionId" value="${esc(idms.id)}"></label></div><label class="wide">Existing user email<input name="email" type="email" required autocomplete="off" placeholder="Enter the email already registered under User Management"><button type="button" class="btn" id="lookupStaffUser">Find user</button><input type="hidden" name="userId"></label><label>First name<input name="firstName" required readonly></label><label>Middle name<input name="middleName" readonly></label><label>Last name<input name="lastName" required readonly></label><label>Employee number<input name="employeeNumber" required maxlength="40"></label><label>Department<select name="departmentId"><option value="">Choose department (optional)</option>${activeDepartments.map((x) => `<option value="${esc(x.id)}">${esc(x.department_name || x.name || x.department_code || x.id)}</option>`).join("")}</select></label><label>Phone<input name="phone" type="tel"></label><label>Job title<input name="jobTitle"></label><label>Category<select name="staffCategory"><option>ACADEMIC</option><option>ADMINISTRATIVE</option><option>TECHNICAL</option><option>SUPPORT</option></select></label><label>Employment type<select name="employmentType"><option>FULL_TIME</option><option>PART_TIME</option><option>CONTRACT</option><option>TEMPORARY</option></select></label><label>Appointment date<input name="appointmentDate" type="date"></label><label>Highest qualification<input name="highestQualification"></label><label>Qualification name<input name="qualificationName"></label><label>Qualification institution<input name="qualificationInstitution"></label><label>Completion year<input name="completionYear" type="number" min="1950" max="2100"></label><label class="wide">Passport size photo (JPG/PNG)<input name="passport" type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png"></label><label class="wide">CV, certificates and supporting documents (PDF/DOCX/JPG/PNG)<input name="staffDocuments" type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" multiple></label>`;
        renderDialog("Register staff and documents", fields, async (form) => {
          if (!form.elements.userId.value) throw new Error("Find and confirm an existing User Management account before registering staff.");
          const fd = new FormData(form); const passport = form.elements.passport.files[0]; const docs = [...form.elements.staffDocuments.files];
          const files = [];
          if (passport) files.push({ fileName: passport.name, mimeType: passport.type || "image/jpeg", documentType: "PASSPORT", contentBase64: await fileAsBase64(passport) });
          if(docs.length+(passport?1:0)>12||docs.some(file=>file.size>5*1024*1024)||docs.reduce((n,file)=>n+file.size,passport?passport.size:0)>7*1024*1024)throw new Error("Limit uploads to 12 files, 5 MB each, 7 MB combined.");
          const prepare=async file=>({fileName:file.name,mimeType:file.type||"application/octet-stream",documentType:/cv|resume/i.test(file.name)?"CV":"CERTIFICATE",contentBase64:await fileAsBase64(file)});
          if(window.IDMCProgress){const prepared=await window.IDMCProgress.mapLimited(docs,3,prepare);for(const item of prepared){if(!item.ok)throw item.error;files.push(item.value);}}else{for(const file of docs)files.push(await prepare(file));}
          if (files.length > 12 || files.some((f) => (f.contentBase64.length * 3 / 4) > 5 * 1024 * 1024)) throw new Error("Limit uploads to 12 files, maximum 5 MB each.");
          if (files.reduce((total, file) => total + file.contentBase64.length * 3 / 4 - (file.contentBase64.endsWith("==") ? 2 : file.contentBase64.endsWith("=") ? 1 : 0), 0) > 7 * 1024 * 1024) throw new Error("Combined staff file size must not exceed 7 MB.");
          const body = Object.fromEntries([...fd.entries()].filter(([key]) => !["passport", "staffDocuments"].includes(key)));
          body.files = files;
          if (body.qualificationName) body.qualifications = [{ qualificationLevel: body.highestQualification || "OTHER", qualificationName: body.qualificationName, institutionName: body.qualificationInstitution || "", completionYear: body.completionYear || "" }];
          delete body.qualificationName; delete body.qualificationInstitution; delete body.completionYear;
          await post("/improvements/staff/register", body);
          message("Existing user account linked and staff record saved.", "success"); $("#refreshWorkspace")?.click();
        });
        const form = $("#idmcContextForm"), status = $("#idmcContextStatus"), lookup = $("#lookupStaffUser");
        lookup.onclick = async () => {
          const email = form.elements.email.value.trim();
          if (!email) { status.textContent = "Enter the user email first."; return; }
          lookup.disabled = true; status.textContent = "Searching User Management…";
          try {
            let user, verifiedByLookup = false;
            try {
              const found = await get(`/improvements/staff-user-lookup?email=${encodeURIComponent(email)}`);
              user = { id:found.id,email:found.email,firstName:found.firstName,middleName:found.middleName,lastName:found.lastName,phone:found.phone };
              verifiedByLookup = true;
            } catch (lookupError) {
              if (lookupError.status !== 404) throw lookupError;
              // Compatibility path for a running backend that has not yet been restarted with the lookup route.
              const userRows = await get("/users");
              const users = Array.isArray(userRows) ? userRows : Array.isArray(userRows?.items) ? userRows.items : [];
              const matches = users.filter((row) => String(row.email || "").trim().toLowerCase() === email.toLowerCase());
              if (matches.length !== 1) throw new Error(matches.length ? "More than one user account has this email. Ask an administrator to resolve the duplicate." : "No User Management account has this email. Create the account first, then return to HR.");
              const record = matches[0];
              if (String(record.status || "").toUpperCase() !== "ACTIVE") throw new Error("This user account is not active. Activate it in User Management first.");
              if (!record.auth_user_id) throw new Error("This user has no login identity. Complete account setup in User Management first.");
              user = { id:record.id,email:record.email,firstName:record.first_name,middleName:record.middle_name,lastName:record.last_name,phone:record.phone };
            }
            if (!user?.id) throw new Error("The matching user account has no IDMS user record.");
            if (!verifiedByLookup && String(user.email || "").trim().toLowerCase() !== email.toLowerCase()) throw new Error("The returned user email does not match the requested email.");
            form.elements.userId.value = user.id;
            form.elements.email.value = user.email || email;
            form.elements.firstName.value = user.firstName || "";
            form.elements.middleName.value = user.middleName || "";
            form.elements.lastName.value = user.lastName || "";
            if (!form.elements.phone.value) form.elements.phone.value = user.phone || "";
            status.textContent = `User account confirmed: ${[user.firstName,user.middleName,user.lastName].filter(Boolean).join(" ")} · ${user.email}`;
            status.className = "iw-context-status show success";
          } catch (error) { form.elements.userId.value = ""; status.textContent = error.message || "Could not find this user account."; status.className = "iw-context-status show error"; }
          finally { lookup.disabled = false; }
        };
        form.elements.email.addEventListener("input", () => { form.elements.userId.value = ""; form.elements.firstName.value = ""; form.elements.middleName.value = ""; form.elements.lastName.value = ""; });
      } catch (error) { message(error.message || "Could not load staff registration choices.", "error"); }
    }, "staff.register");
  }

  async function lecturerControls(caps) {
    if (!(caps.roles || []).includes("LECTURER")) return;
    const refs = await get("/improvements/references"); const offerings = refs.offerings || [];
    const host = $("#lecturerCourseActions") || $("#contextActions") || $("#idmc-resource-root"); if (!host) return;
    const panel = document.createElement("div"); panel.className = "iw-context-panel"; panel.innerHTML = '<div><h2>My assigned course</h2><p>Select an assigned course to view its curriculum and the complete registered roster. Cross-cutting courses combine eligible programmes.</p></div><label class="iw-context-select"><span>Assigned course</span><select id="lecturerOffering"><option value="">Choose course</option>' + offerings.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join("") + '</select></label><div class="iw-context-buttons"><button class="btn" id="downloadCurriculum" type="button">Download curriculum</button><button class="btn" id="downloadRoster" type="button">Download registered students</button></div><div id="lecturerCourseMessage" role="status" aria-live="polite"></div><div id="lecturerRosterPreview" class="iw-roster-preview"><p>Choose an assigned course to load its class roster.</p></div>';
    if (host.id === "lecturerCourseActions") { host.innerHTML = "<h3>My courses</h3>"; host.append(panel); }
    else { const tabs = host.querySelector(".idmc-rp-tabs"); host.insertBefore(panel, tabs || host.firstChild); }
    $("#downloadCurriculum").onclick = async () => {
      const id = $("#lecturerOffering").value; if (!id) return message("Choose your assigned course first.", "error");
      const result = await get(`/improvements/lecturer/curriculum/${encodeURIComponent(id)}`);
      downloadCsv("IDMS-my-curriculum.csv", [["Curriculum", "Course Code", "Course Name", "Year", "Semester", "Credits"], ...(result || []).map((r) => [r.curriculum, r.course?.course_code, r.course?.course_name, r.year_number, r.semester_number, r.credit_units])]);
      message("Curriculum downloaded.", "success");
    };
    $("#downloadRoster").onclick = async () => {
      const id = $("#lecturerOffering").value; if (!id) return message("Choose your assigned course first.", "error");
      const result = await get(`/improvements/offerings/${encodeURIComponent(id)}/export`);
      const students = result.students || [];
      downloadCsv("IDMS-course-roster.csv", [["Student Number", "Student Name", "Programme", "Credits"], ...students.map((s) => [s.student_number, [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(" "), s.programme_name || s.programme_code, s.credits])]);
      const host = $("#lecturerRosterPreview");
      host.innerHTML = `<h3>${result.sharedRoster ? "Combined cross-cutting roster" : "Registered class roster"} · ${students.length} student(s)</h3>` + (students.length ? '<div class="iw-roster-table-wrap"><table class="iw-roster-table"><thead><tr><th>No.</th><th>Student No.</th><th>Student Name</th><th>Programme</th><th>Credits</th></tr></thead><tbody>' + students.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.student_number)}</td><td>${esc([s.first_name, s.middle_name, s.last_name].filter(Boolean).join(" "))}</td><td>${esc(s.programme_name || s.programme_code || "—")}</td><td>${esc(s.credits ?? "—")}</td></tr>`).join("") + '</tbody></table></div>' : '<p>No APPROVED or REGISTERED students are enrolled yet.</p>');
      message(result.sharedRoster ? `Combined roster downloaded for ${students.length} registered students across ${result.offeringCount} programme offering(s).` : `Roster downloaded for ${students.length} registered students.`, "success");
    };
  }

  async function academicYearControls(caps) {
    if (!(caps.roles || []).some((r) => ["ADMIN", "SUPER_ADMIN", "ACADEMIC_OFFICER"].includes(r))) return;
    addButton("Check current academic year", async () => {
      try {
        const result = await post("/improvements/academic-year/ensure", {});
        message("Current academic year checked. The academic year was created only if it was missing.", "success");
        const refresh = $("#amxReload") || $("#refreshWorkspace");
        refresh?.click();
        if (result?.year_code || result?.year_name) message(`Academic year ${result.year_code || result.year_name} is ready.`, "success");
      } catch (error) { message(error.message || "Could not check the academic year.", "error"); }
    }, "academic-year.ensure");
  }

  async function init() {
    if (!["examinations", "timetable", "hr", "curriculum", "academics", "lecturer"].includes(workspace) || !window.IDMCAPI) return;
    try {
      const caps = await get("/improvements/capabilities");
      if (workspace === "examinations") await examinationControls(caps);
      if (workspace === "timetable") await timetableControls(caps);
      if (workspace === "hr") await staffControls(caps);
      if (workspace === "curriculum") await lecturerControls(caps);
      if (workspace === "academics") await academicYearControls(caps);
      if (workspace === "lecturer") await lecturerControls(caps);
    } catch (error) { message(error.message || "Could not load page actions.", "error"); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true }); else init();
})();
