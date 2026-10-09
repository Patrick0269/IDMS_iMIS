(function () {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const value = (response) => response && Object.prototype.hasOwnProperty.call(response, "data") ? response.data : response;
  const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const button = $("#openOfficerApplication");
  const dialog = $("#officerApplicationDialog");
  const form = $("#officerApplicationForm");
  const note = $("#pageMessage");
  if (!button || !dialog || !form || !window.IDMCAPI) return;

  const kinHeading = Array.from(form.querySelectorAll("h3")).find((heading) => heading.textContent.includes("Next of kin"));
  const yearLabel = form.elements.academicYearId.closest("label");
  if (yearLabel) {
    const identifiers = document.createElement("div");
    identifiers.className = "admission-form-grid wide";
    identifiers.innerHTML = '<label>National ID number<input name="nationalIdNumber" maxlength="100"></label><label>Passport number<input name="passportNumber" maxlength="100"></label>';
    yearLabel.before(identifiers);
  }
  if (kinHeading) {
    const documents = document.createElement("section");
    documents.className = "officer-documents";
    documents.innerHTML = '<h3>Supporting documents</h3><p class="officer-form-help">Attach scans so Admissions can verify the application without requiring applicant login. PDF, JPEG, PNG or WebP; maximum 5 MB each.</p><div class="admission-form-grid"><label>Document type<select name="documentType"><option value="ACADEMIC_CERTIFICATE">Academic certificate / result slip</option><option value="IDENTITY">National ID / passport</option><option value="BIRTH_CERTIFICATE">Birth certificate</option><option value="OTHER">Other supporting document</option></select></label><label class="wide">Scanned documents<input name="documents" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" multiple required></label></div>';
    kinHeading.before(documents);
  }

  async function setup() {
    try {
      const caps = value(await IDMCAPI.get("/improvements/capabilities"));
      const roles = caps.roles || [];
      if (!roles.some((role) => ["ADMIN", "SUPER_ADMIN", "SYSTEM_ADMIN", "ADMISSIONS_OFFICER"].includes(role)) && !(caps.permissions || []).includes("applications.manage")) {
        button.hidden = true;
        return;
      }
      button.addEventListener("click", async () => {
        try {
          const refs = value(await IDMCAPI.get("/improvements/references"));
          const years = (refs.years || []).filter((row) => ["ACTIVE", "OPEN"].includes(String(row.status).toUpperCase()));
          const programmes = (refs.programmes || []).filter((row) => String(row.status).toUpperCase() === "ACTIVE");
          form.elements.academicYearId.innerHTML = '<option value="">Select academic year</option>' + years.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.year_code || row.year_name)}</option>`).join("");
          const programmeOptions = '<option value="">Select programme</option>' + programmes.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml([row.programme_code, row.programme_name].filter(Boolean).join(" — "))}</option>`).join("");
          form.elements.programmeId.innerHTML = programmeOptions;
          form.elements.secondProgrammeId.innerHTML = '<option value="">No second choice</option>' + programmes.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml([row.programme_code, row.programme_name].filter(Boolean).join(" — "))}</option>`).join("");
          dialog.showModal();
        } catch (error) { note.textContent = error.message || "Could not load admission choices."; }
      });
      $("#closeOfficerApplication").onclick = $("#cancelOfficerApplication").onclick = () => dialog.close();
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const body = Object.fromEntries(new FormData(form));
        const files = Array.from(form.elements.documents?.files || []);
        const allowedTypes = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
        if (!files.length) {
          note.textContent = "Attach at least one supporting document before submitting the application.";
          note.className = "message show error";
          return;
        }
        if (files.some((file) => file.size > 5 * 1024 * 1024 || !allowedTypes.includes(file.type))) {
          note.textContent = "Each supporting document must be a PDF, JPEG, PNG or WebP file under 5 MB.";
          note.className = "message show error";
          return;
        }
        delete body.documents;
        body.qualifications = [{
          type: body.qualificationType, institutionName: body.institutionName,
          indexNumber: body.indexNumber, awardName: body.awardName,
          completionYear: body.completionYear, grade: body.grade
        }];
        if (body.qualification2Type || body.institution2Name || body.index2Number) body.qualifications.push({
          type: body.qualification2Type, institutionName: body.institution2Name,
          indexNumber: body.index2Number, completionYear: body.completion2Year
        });
        if (body.applicantConfirmed !== "on") {
          note.textContent = "Confirm that the applicant authorized this application.";
          note.className = "message show error";
          return;
        }
        body.applicantConfirmed = true;
        delete body.qualificationType; delete body.institutionName; delete body.indexNumber;
        delete body.awardName; delete body.completionYear; delete body.grade;
        delete body.qualification2Type; delete body.institution2Name; delete body.index2Number; delete body.completion2Year;
        const submit = form.querySelector('[type="submit"]');
        submit.disabled = true;
        try {
          const response = value(await IDMCAPI.post("/improvements/admissions/application", body));
          const documentErrors = [];
          for (const file of files) {
            try {
              const uploaded = await fetch(`${IDMCAPI.baseUrl}/improvements/admissions/application/${encodeURIComponent(response.applicationId)}/documents`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${IDMCAPI.getAccessToken()}`,
                  "Content-Type": "application/octet-stream",
                  "X-File-Name": file.name.replace(/[^a-zA-Z0-9._-]/g, "_"),
                  "X-Mime-Type": file.type,
                  "X-Document-Type": body.documentType
                },
                body: file
              });
              if (!uploaded.ok) { const result = await uploaded.json(); throw new Error(result.message || `Upload failed for ${file.name}`); }
            } catch (error) { documentErrors.push(error.message || `Upload failed for ${file.name}`); }
          }
          dialog.close();
          form.reset();
          const problems = [];
          if (response.emailSent === false) problems.push(`Email could not be sent: ${response.emailError || "check SMTP settings"}.`);
          if (documentErrors.length) problems.push(`Some documents could not be uploaded: ${documentErrors.join("; ")}`);
          note.textContent = `Application ${response.applicationNumber || ""} saved to Pending Work.${response.emailSent === true ? " Receipt emailed to applicant." : ""} ${problems.join(" ")}`;
          note.className = `message show ${problems.length ? "error" : "success"}`;
          $("#refreshWorkspace").click();
        } catch (error) {
          note.textContent = error.message || "Application could not be created.";
          note.className = "message show error";
        } finally { submit.disabled = false; }
      });
    } catch (error) {
      button.hidden = true;
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup, { once: true });
  else setup();
})();
