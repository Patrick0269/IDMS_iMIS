(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "—").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const label = item => item.course_name || item.module_name || item.name || item.course?.course_name || item.course?.module_name || item.course?.name || item.course_code || item.code || "Registered course";
  const message = (value, error = false) => { const box = $("evaluationMessage"); box.hidden = !value; box.textContent = value || ""; box.className = `portal-state${error ? " portal-error" : ""}`; };
  let offerings = [];
  function render(data) {
    const student = data.student || {};
    $("studentName").textContent = student.full_name || [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ") || "Student";
    $("studentNumber").textContent = student.student_number || student.registration_number || "—";
    $("studentProgramme").textContent = student.programme_name || student.programme_code || "—";
    const registrations = (data.course_registrations || []).filter(row => !["DROPPED", "REJECTED", "CANCELLED"].includes(String(row.registration_status || "").toUpperCase()));
    offerings = registrations.filter(row => row.course_offering_id);
    const existing = new Map((data.course_evaluations || []).map(row => [row.course_offering_id, row]));
    $("evaluationCourse").innerHTML = '<option value="">Select a registered course</option>' + offerings.map(row => `<option value="${esc(row.course_offering_id)}">${esc(label(row))}${existing.has(row.course_offering_id) ? " — evaluation on file" : ""}</option>`).join("");
    $("evaluationHistory").innerHTML = existing.size ? `<div class="portal-table-wrap"><table class="portal-table"><thead><tr><th>Course</th><th>Rating</th><th>Lecturer preparation</th><th>Content delivery</th><th>Learning resources</th><th>Submitted</th></tr></thead><tbody>${[...existing.values()].map(row => {
      const course = offerings.find(item => item.course_offering_id === row.course_offering_id);
      return `<tr><td>${esc(course ? label(course) : row.course_name || "Registered course")}</td><td>${esc(row.rating)}/5</td><td>${esc(row.lecturer_preparation ?? "—")}</td><td>${esc(row.content_delivery ?? "—")}</td><td>${esc(row.learning_resources ?? "—")}</td><td>${esc(row.submitted_at ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "Africa/Dar_es_Salaam" }).format(new Date(row.submitted_at)) : "—")}</td></tr>`;
    }).join("")}</tbody></table></div>` : "No course evaluations have been submitted yet.";
    if (!offerings.length) { $("evaluationCourse").innerHTML = '<option value="">No registered courses available</option>'; message("Course evaluation becomes available after your course registration is recorded."); }
  }
  async function load() { const response = await IDMCAPI.get("/students/me/portal"); const data = response.data || response; window.__idmcEvaluations = data.course_evaluations || []; render(data); }
  $("evaluationCourse").addEventListener("change", event => {
    const found = (window.__idmcEvaluations || []).find(row => row.course_offering_id === event.target.value);
    const form = $("evaluationForm");
    if (found) { ["rating", "lecturerPreparation", "contentDelivery", "learningResources", "comment"].forEach(key => { const field = form.elements[key]; if (field) field.value = found[key === "lecturerPreparation" ? "lecturer_preparation" : key === "contentDelivery" ? "content_delivery" : key === "learningResources" ? "learning_resources" : key === "comment" ? "student_comment" : key] ?? ""; }); message("An evaluation already exists for this course. Submitting will update it."); }
    else { ["rating", "lecturerPreparation", "contentDelivery", "learningResources", "comment"].forEach(key => { const field = form.elements[key]; if (field) field.value = ""; }); message(""); }
  });
  $("evaluationForm").addEventListener("submit", async event => {
    event.preventDefault(); const form = event.currentTarget, button = $("evaluationSubmit"); button.disabled = true; message("Submitting your evaluation…");
    const raw = Object.fromEntries(new FormData(form).entries());
    const payload = { courseOfferingId: raw.courseOfferingId, rating: Number(raw.rating), lecturerPreparation: raw.lecturerPreparation ? Number(raw.lecturerPreparation) : "", contentDelivery: raw.contentDelivery ? Number(raw.contentDelivery) : "", learningResources: raw.learningResources ? Number(raw.learningResources) : "", comment: raw.comment };
    try { await IDMCAPI.post("/students/me/course-evaluations", payload); message("Your course evaluation has been saved."); await load(); }
    catch (error) { message(error.message || "Unable to submit this course evaluation.", true); }
    finally { button.disabled = false; }
  });
  async function init() { if (!await IDMCAuth.requireAuth()) return; try { const response = await IDMCAPI.get("/students/me/portal"); const data = response.data || response; window.__idmcEvaluations = data.course_evaluations || []; render(data); } catch (error) { $("evaluationHistory").textContent = error.message || "Unable to load course evaluation data."; message("Course evaluation data could not be loaded.", true); } }
  init();
}());
