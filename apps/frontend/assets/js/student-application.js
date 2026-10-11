(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const value = (...values) => values.find(item => item !== null && item !== undefined && String(item).trim() !== "") ?? "Not recorded";
  const date = input => {
    if (!input) return "Not recorded";
    const parsed = new Date(input);
    return Number.isNaN(parsed.valueOf()) ? String(input) : new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Dar_es_Salaam", day: "2-digit", month: "short", year: "numeric" }).format(parsed);
  };
  const dateTime = input => {
    if (!input) return "Not recorded";
    const parsed = new Date(input);
    return Number.isNaN(parsed.valueOf()) ? String(input) : new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Dar_es_Salaam", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(parsed);
  };
  const fields = items => `<dl class="registration-fields">${items.map(([label, content]) => `<div><dt>${esc(label)}</dt><dd>${esc(content)}</dd></div>`).join("")}</dl>`;
  const table = (headers, rows, empty) => `<div class="portal-table-wrap"><table class="portal-table"><thead><tr>${headers.map(item => `<th>${esc(item)}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.join("") : `<tr><td colspan="${headers.length}">${esc(empty)}</td></tr>`}</tbody></table></div>`;
  const unwrap = response => response?.data ?? response;
  const yearLabel = raw => {
    if (raw === null || raw === undefined || String(raw).trim() === "") return null;
    const text = String(raw).trim();
    if (/\d{4}\s*[/-]\s*\d{4}/.test(text)) return text.replace(/\s+/g, "");
    const year = Number(text);
    return Number.isInteger(year) && year >= 1900 && year <= 2100 ? `${year}/${year + 1}` : text;
  };

  function render(data) {
    const app = data.application || {}, student = data.student || {}, applicant = data.applicant || {};
    const entryYearId = student.entry_academic_year_id || app.academic_year_id;
    const year = data.years.find(row => String(row.id) === String(entryYearId));
    const linkedEntryYear = student.academic_years || student.academic_year || {};
    const programmeMap = new Map(data.programmes.map(row => [row.id, row]));
    const choices = data.choices.filter(row => !app.id || row.application_id === app.id).sort((a, b) => Number(a.choice_number || 0) - Number(b.choice_number || 0));
    const programmeRows = choices.length ? choices : (student.programme_name || student.programme_code ? [{ choice_number: "Current registered programme", programme_name: [student.programme_code, student.programme_name].filter(Boolean).join(" — "), preference_type: "Current student record" }] : []);
    const qualifications = data.qualifications || [];
    const documents = data.documents.filter(row => !row.application_id || !app.id || row.application_id === app.id);
    const kin = data.kin || data.portal.application_next_of_kin || data.portal.emergency_contacts?.[0] || {};
    const sponsor = data.portal.guardians?.[0] || {};
    const fullName = value(applicant.full_name, [applicant.first_name, applicant.middle_name, applicant.last_name].filter(Boolean).join(" "), student.full_name);
    const currentYear = value(data.portal.current_year, year?.year_name, year?.year_code, data.portal.panel?.current_year);
    const user = window.IDMCAuth?.getUser?.() || {};
    const lastLogin = data.portal.last_login_at || user.lastLoginAt || user.last_login_at || user.last_login || null;
    const today = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Dar_es_Salaam", day: "2-digit", month: "short", year: "numeric" }).format(new Date());
    const studentNumber = value(student.registration_number, student.student_number);
    // The student schema has no separate admission_number column. CoSIS records
    // the same institutional identifier in both admission and registration no.
    const admissionNumber = value(student.admission_number, student.admission_no, student.registration_number, student.student_number);
    const yearOfAdmission = value(year?.year_name, year?.year_code, linkedEntryYear.year_name, linkedEntryYear.year_code, yearLabel(student.admission_year), app.academic_year_name, data.portal.current_year, data.portal.panel?.current_year);
    const registrationNumber = value(student.registration_number, student.student_number);
    const campus = value(student.campus_name, student.campus, applicant.campus_name, app.campus_name);
    const programmeName = value(student.programme_name, student.programme_code, choices.map(row => programmeMap.get(row.programme_id)?.programme_name).filter(Boolean).join(", "));
    const profilePhoto = value(student.profile_photo_url, applicant.profile_photo_url, documents.find(row => /PROFILE.?PHOTO|PASSPORT/i.test(row.document_type || ""))?.file_url, "");
    const photoMarkup = profilePhoto !== "Not recorded" ? `<img class="registration-photo" src="${esc(profilePhoto)}" alt="Student profile photograph" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><p class="registration-photo-fallback" hidden>Admissions-managed photo is not available.</p>` : `<p class="registration-photo-fallback">Passport-size photo is managed by Admissions.</p>`;

    $("studentName").textContent = fullName === "Not recorded" ? "Student" : fullName;
    $("studentNumber").textContent = studentNumber;
    $("studentProgramme").textContent = programmeName;
    $("applicationMessage").hidden = true;
    $("applicationFormView").hidden = false;
    $("applicationFormView").innerHTML = `<div class="registration-toolbar"><div><span><strong>Current Year:</strong> ${esc(currentYear)}</span><span><strong>Last Login:</strong> ${esc(dateTime(lastLogin))}</span><span><strong>Today:</strong> ${esc(today)}</span></div><button id="printRegistrationForm" type="button">Print Registration Form</button></div>
      <article class="student-registration-form"><header class="registration-title"><h2>Student Registration Form</h2><p>Institute of Development and Medical Sciences · IDMS iMIS</p></header>
      <section class="registration-section"><h3>Study Programme Information</h3>${fields([
        ["Year of Admission", yearOfAdmission],
        ["Admission No.", admissionNumber],
        ["Campus", campus],
        ["Registration No.", registrationNumber],
        ["Programme Registered", programmeName],
        ["Graduation Date", date(student.graduation_date || student.expected_completion_date)],
        ["Class / Stream", value(student.class_name, student.stream_name, student.class_code, data.portal.student_classes?.[0]?.class_name, data.portal.student_classes?.[0]?.class_code)],
        ["Sponsorship", value(student.sponsorship, student.sponsor_type, app.sponsorship, sponsor.sponsorship_type)],
        ["Level of Study", value(student.award_level, student.level, student.study_level, app.entry_category, app.application_type)],
        ["Entry Type", value(student.entry_type, app.entry_category, app.application_type)],
        ["Student Status", value(student.student_status)]
      ])}</section>
      <section class="registration-section"><h3>Personal Information</h3>${fields([
        ["Surname", value(applicant.last_name, student.last_name)], ["First Name", value(applicant.first_name, student.first_name)],
        ["Middle Name", value(applicant.middle_name, student.middle_name)], ["Gender", value(applicant.gender, student.gender)],
        ["Date of Birth", date(applicant.date_of_birth || student.date_of_birth)], ["Nationality", value(applicant.nationality, student.nationality)],
        ["Marital Status", value(applicant.marital_status, student.marital_status)],
        ["District of Birth", value(applicant.birth_district, student.birth_district)], ["Region of Birth", value(applicant.birth_region, student.birth_region)], ["Country of Birth", value(applicant.birth_country, student.birth_country)],
        ["Phone", value(applicant.phone, student.phone)], ["Email", value(applicant.email, student.email)],
        ["National ID (NIDA)", value(applicant.national_id_number, student.national_id)], ["Passport Number", value(applicant.passport_number, student.passport_number)],
        ["City / District", [applicant.city, applicant.district].filter(Boolean).join(" / ") || "Not recorded"],
        ["Current Address", [applicant.address_line_1, applicant.address_line_2, applicant.city, applicant.district, applicant.region, applicant.country].filter(Boolean).join(", ") || value(student.physical_address)],
        ["Permanent Address", value(applicant.permanent_address, student.permanent_address)],
        ["Bank", value(applicant.bank_name, student.bank_name)], ["Bank Branch", value(applicant.bank_branch, student.bank_branch)],
        ["Bank Account Number", value(applicant.bank_account_number, student.bank_account_number)], ["NHIF Card No.", value(applicant.nhif_card_number, student.nhif_card_number)]
      ])}</section>
      <section class="registration-section"><h3>Next of Kin Information</h3>${fields([
        ["Name of Next of Kin", value(kin.full_name, kin.name)], ["Relationship", value(kin.relationship)],
        ["Next of Kin Occupation", value(kin.occupation)],
        ["Next of Kin Phone", value(kin.phone, kin.mobile_number)], ["Next of Kin Email", value(kin.email)], ["Next of Kin Address", value(kin.address)]
      ])}</section>
      <section class="registration-section"><h3>Sponsor Information</h3>${fields([
        ["Sponsorship Type", value(app.sponsorship_type, student.sponsorship, student.sponsor_type, sponsor.sponsorship_type)],
        ["Name of Sponsor", value(app.sponsor_name, sponsor.full_name, sponsor.sponsor_name, applicant.sponsor_name)],
        ["Sponsor Phone", value(app.sponsor_phone, sponsor.phone, sponsor.mobile_number, applicant.sponsor_phone)],
        ["Sponsor Occupation", value(app.sponsor_occupation, sponsor.occupation, applicant.sponsor_occupation)],
        ["Sponsor Address", value(app.sponsor_address, sponsor.address, sponsor.physical_address, applicant.sponsor_address)]
      ])}</section>
      <section class="registration-section"><h3>Entry Qualifications Information</h3>${table(["Qualification", "Index / Award", "Institution", "Completion Year", "Grade"], qualifications.map(row => `<tr><td>${esc(value(row.qualification_type))}</td><td>${esc(value(row.index_number, row.award_name))}</td><td>${esc(value(row.institution_name))}</td><td>${esc(value(row.completion_year))}</td><td>${esc(value(row.grade))}</td></tr>`), "No entry qualification information is recorded.")}</section>
      <section class="registration-section"><h3>Programme Choices</h3>${table(["Choice", "Programme", "Preference"], programmeRows.map(row => { const programme = programmeMap.get(row.programme_id); return `<tr><td>${esc(value(row.choice_number, "Registered programme"))}</td><td>${esc(programme ? `${programme.programme_code || ""} — ${programme.programme_name || ""}` : row.programme_name || "Programme details unavailable")}</td><td>${esc(value(row.preference_type))}</td></tr>`; }), "No programme choice or registered programme is recorded.")}</section>
      <section class="registration-section registration-picture-section"><h3>Profile Picture</h3><div class="registration-picture">${photoMarkup}</div></section>
      <section class="registration-section"><h3>Supporting Documents</h3>${table(["Document", "Type", "Verification"], documents.map(row => `<tr><td>${esc(value(row.document_name, row.file_name))}</td><td>${esc(value(row.document_type))}</td><td>${esc(value(row.verification_status))}</td></tr>`), "No supporting documents are recorded.")}</section>
      </article>`;
    $("printRegistrationForm").addEventListener("click", () => window.print());
  }

  async function init() {
    if (!await IDMCAuth.requireAuth()) return;
    try {
      const portalResponse = await IDMCAPI.get("/students/me/portal"), portal = unwrap(portalResponse);
      const student = portal.student || {};
      // Student accounts must not depend on applicant-only endpoints. The
      // student portal already returns the student's saved admission/profile
      // details, including for imported records with no source application.
      render({
        portal,
        student,
        applicant: portal.applicant || {},
        application: portal.application || {},
        choices: portal.application_choices || [],
        qualifications: portal.academic_qualifications || [],
        documents: [...(portal.application_documents || []), ...(portal.student_documents || [])],
        programmes: portal.programmes || [],
        years: portal.academic_years || [],
        kin: portal.emergency_contacts?.[0] || {}
      });
    } catch (error) {
      $("applicationMessage").textContent = error.message || "Unable to load student registration information.";
      $("applicationMessage").className = "portal-state portal-error";
    }
  }
  init();
}());

