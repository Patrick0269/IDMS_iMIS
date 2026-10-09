(function () {
    "use strict";

    const state = { data: null, coursework: null, deficiencies: [], selectedYear: "all", activeTab: new URLSearchParams(location.search).get("view") === "coursework" ? "coursework" : "results" };
    const byId = id => document.getElementById(id);
    const esc = value => String(value ?? "—")
        .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
    const number = (value, digits = 1) => value === null || value === undefined || value === ""
        ? "—" : Number(value).toFixed(digits).replace(/\.0$/, "");
    const dateTime = value => value ? new Intl.DateTimeFormat("en-GB", {
        day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).format(new Date(value)) : "—";
    const today = () => new Intl.DateTimeFormat("en-GB", {
        day: "2-digit", month: "short", year: "numeric"
    }).format(new Date());

    function setIdentity(student) {
        byId("currentUser").textContent = student.fullName || "Student";
        byId("studentName").textContent = student.fullName || "Student";
        byId("studentNumber").textContent = student.studentNumber || "—";
        byId("studentProgramme").textContent = student.programmeName || student.programmeCode || "—";
    }

    function yearButtons(years, label, countForYear) {
        const items = years.map(year => `
            <button class="result-year-button ${state.selectedYear === year.id ? "active" : ""}"
                    type="button" data-year-id="${esc(year.id)}">
                <span>${esc(year.studyYearLabel)}</span>
                <small>${countForYear(year)} ${label}</small>
            </button>`).join("");
        return `<div class="result-year-picker">
            <div class="result-section-label">Year of Study</div>
            <div class="result-year-list">${items}
                <button class="result-year-button ${state.selectedYear === "all" ? "active" : ""}" type="button" data-year-id="all">
                    <span>View All</span><small>Every academic year</small>
                </button>
            </div>
        </div>`;
    }

    function semesterTable(semester) {
        const rows = semester.results.map(row => `
            <tr>
                <td class="result-code">${esc(row.code)}</td>
                <td>${esc(row.moduleName)}</td>
                <td>${esc(row.type)}</td>
                <td>${number(row.coursework, 2)}</td>
                <td>${number(row.semesterExam, 2)}</td>
                <td>${number(row.supplementary, 2)}</td>
                <td class="result-strong">${number(row.total, 2)}</td>
                <td>${number(row.credits, 1)}</td>
                <td><span class="result-grade">${esc(row.grade)}</span></td>
                <td>${number(row.points, 2)}</td>
                <td><span class="result-remark ${String(row.remarks).toUpperCase() === "PASS" ? "pass" : ""}">${esc(row.remarks)}</span></td>
                <td></td>
            </tr>`).join("");
        return `<section class="result-semester">
            <h3>${esc(semester.name || `Semester ${semester.number}`)}</h3>
            <div class="portal-table-wrap">
                <table class="portal-table result-table">
                    <thead><tr><th>Code</th><th>Module Name</th><th>Type</th><th>CW</th><th>SE</th><th>SUP</th><th>Total</th><th>Credits</th><th>Grade</th><th>Points</th><th>Remarks</th><th>GPA</th></tr></thead>
                    <tbody>${rows || `<tr><td colspan="12" class="result-empty">No published results.</td></tr>`}</tbody>
                    <tfoot><tr><td colspan="7" class="result-summary-label">Semester Summary</td><td>${number(semester.credits, 1)}</td><td></td><td>${number(semester.qualityPoints, 2)}</td><td></td><td class="result-gpa">${number(semester.gpa, 2)}</td></tr></tfoot>
                </table>
            </div>
        </section>`;
    }

    function renderResults() {
        const data = state.data;
        if (!data) return `<div class="portal-empty"><strong>Examination results could not be loaded.</strong></div>`;
        const chosen = state.selectedYear === "all" ? data.years : data.years.filter(year => year.id === state.selectedYear);
        const resultBlocks = chosen.map(year => `
            <div class="result-year-block">
                <div class="result-year-heading"><div><small>Examination Results</small><h2>${esc(year.name || year.code)}</h2></div><span>${esc(year.studyYearLabel.split(" - ")[0])}</span></div>
                ${year.semesters.map(semesterTable).join("")}
            </div>`).join("");

        const deficiencyRows = state.deficiencies.map(row => `<tr><td>${esc(row.course_code || row.code || row.course_name || row.module_name || "—")}</td><td>${esc(row.course_name || row.module_name || row.course_code || "—")}</td><td>${esc(row.deficiency_type || "—")}</td><td>${esc(row.deficiency_status || "—")}</td><td>${esc(row.remarks || "—")}</td></tr>`).join("");
        const deficiencies = `<section class="result-semester"><h3>Repeat or Carry Modules</h3><div class="portal-table-wrap"><table class="portal-table result-table"><thead><tr><th>Code</th><th>Module</th><th>Type</th><th>Status</th><th>Remarks</th></tr></thead><tbody>${deficiencyRows || `<tr><td colspan="5" class="result-empty">No repeat or carry modules are recorded.</td></tr>`}</tbody></table></div></section>`;
        return `${yearButtons(data.years, "modules", year => year.semesters.reduce((sum, semester) => sum + semester.results.length, 0))}
            ${resultBlocks || `<div class="portal-empty"><strong>No published examination results yet.</strong><p>Results appear here only after official publication.</p></div>`}
            ${deficiencies}
            <div class="result-note"><strong>Result codes:</strong> TF = Technical Failure, ABS = Absent. A blank SUP column means no supplementary examination mark was recorded.</div>`;
    }

    function renderCoursework() {
        const data = state.coursework;
        if (!data) return `<div class="portal-error"><strong>Coursework scores are temporarily unavailable.</strong><p>Refresh to try again. Scores appear after the lecturer's marks are approved.</p></div>`;
        const chosen = state.selectedYear === "all" ? data.years : data.years.filter(year => year.id === state.selectedYear);
        const blocks = chosen.map(year => `<div class="result-year-block">
          <div class="result-year-heading"><div><small>Coursework Scores</small><h2>${esc(year.name)}</h2></div><span>${esc(year.studyYearLabel.split(" - ")[0])}</span></div>
          ${year.semesters.map(semester => {
            const labels = ["INDIVIDUAL","GROUP","TEST1","TEST2"];
            const rows = semester.courses.map(course => `<tr><td class="result-code">${esc(course.code)}</td><td>${esc(course.moduleName)}</td><td>${number(course.credits, 1)}</td>${labels.map(label => {
              const assessment = course.assessments.find(item => item.label === label);
              return `<td>${assessment && assessment.marks !== null ? `${number(assessment.marks, 2)}` : "—"}</td>`;
            }).join("")}<td class="result-strong">${number(course.courseworkScore, 2)}${course.courseworkScore !== null ? ` / ${number(course.courseworkMaximum, 2)}` : ""}</td><td><span class="result-remark ${course.courseworkScore !== null ? "pass" : ""}">${esc(course.remarks||"Incomplete")}</span></td></tr>`).join("");
            return `<section class="result-semester"><h3>${esc(semester.name || `Semester ${semester.number}`)}</h3><div class="portal-table-wrap"><table class="portal-table result-table coursework-table"><thead><tr><th>Code</th><th>Module Name</th><th>Credits</th>${labels.map(label => `<th>${esc(label)}</th>`).join("")}<th>Coursework</th><th>Remarks</th></tr></thead><tbody>${rows || `<tr><td colspan="${5 + labels.length}" class="result-empty">No registered modules for this semester.</td></tr>`}</tbody></table></div></section>`;
          }).join("")}
        </div>`).join("");
        return `${yearButtons(data.years, "modules", year => year.semesters.reduce((sum, semester) => sum + semester.courses.length, 0))}
          ${blocks || `<div class="portal-empty"><strong>No coursework records are available yet.</strong><p>Coursework is listed for courses you registered in the selected academic year.</p></div>`}
          <div class="result-note"><strong>About these scores:</strong> Lecturer-submitted coursework appears during HOD review. Programme minimums determine Pass or Below minimum. <a href="student-coursework.html">Open assignments, uploads and requests</a>. Official final grades remain on Examination Results. If a mark appears incorrect, contact the module lecturer or HOD.</div>`;
    }

    function render() {
        const data = state.activeTab === "coursework" ? state.coursework : state.data;
        const years = data?.years || [];
        if (!years.some(year => year.id === state.selectedYear) && state.selectedYear !== "all") state.selectedYear = years.at(-1)?.id || "all";
        const meta = state.coursework || state.data || {};
        const pageContent = state.activeTab === "coursework" ? renderCoursework() : renderResults();
        byId("portalContent").innerHTML = `
          <div class="result-meta">
            <div><span>Current Year</span><strong>${esc(meta.currentAcademicYear)}</strong></div>
            <div><span>Last Login</span><strong>${esc(dateTime(meta.lastLoginAt))}</strong></div>
            <div><span>Today</span><strong>${esc(today())}</strong></div>
          </div>
          <div class="result-tabs" role="tablist" aria-label="Academic scores">
            <button type="button" role="tab" aria-selected="${state.activeTab === "results"}" class="${state.activeTab === "results" ? "active" : ""}" data-score-tab="results">Examination Results</button>
            <button type="button" role="tab" aria-selected="${state.activeTab === "coursework"}" class="${state.activeTab === "coursework" ? "active" : ""}" data-score-tab="coursework">Coursework Scores</button>
          </div>
          ${pageContent}`;

        document.querySelectorAll("[data-year-id]").forEach(button => button.addEventListener("click", () => {
            state.selectedYear = button.dataset.yearId;
            render();
        }));
        document.querySelectorAll("[data-score-tab]").forEach(button => button.addEventListener("click", () => {
            state.activeTab = button.dataset.scoreTab;
            state.selectedYear = "all";
            render();
        }));
    }

    async function load() {
        byId("portalContent").innerHTML = `<div class="portal-state"><div class="portal-spinner"></div><h3>Loading Examination Results</h3><p>Please wait while published results are prepared.</p></div>`;
        try {
            const authenticated = await window.IDMCAuth.requireAuth();
            if (!authenticated) return;
            const [resultsResponse, courseworkResponse] = await Promise.all([
              window.IDMCAPI.get("/student-results/me").catch(() => null),
              window.IDMCAPI.get("/student-results/me/coursework").catch(() => null),
            ]);
            const academicResponse = await window.IDMCAPI.get("/students/me/results").catch(() => null);
            state.data = resultsResponse?.data || null;
            state.coursework = courseworkResponse?.data || null;
            state.deficiencies = academicResponse?.data?.deficiencies || [];
            const initialData = state.activeTab === "coursework" ? state.coursework : state.data;
            state.selectedYear = initialData?.years.at(-1)?.id || "all";
            const student = state.data?.student || state.coursework?.student;
            if (student) setIdentity(student);
            render();
        } catch (error) {
            byId("portalContent").innerHTML = `<div class="portal-error"><strong>Examination results are temporarily unavailable.</strong><div>${esc(error.message || "Please try again.")}</div><button class="portal-button" id="retryResults" type="button">Try Again</button></div>`;
            byId("retryResults")?.addEventListener("click", () => {
                window.IDMCAPI.clearCache?.();
                load();
            }, { once: true });
        }
    }

    byId("portalRefreshButton")?.addEventListener("click", load);
    document.addEventListener("DOMContentLoaded", load);
}());
