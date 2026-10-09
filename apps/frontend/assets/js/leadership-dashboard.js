(function () {
  "use strict";
  const role = document.body.dataset.leadershipRole || "";
  const expected = role.toUpperCase();
  const adminRoles = ["SUPER_ADMIN", "ADMIN", "SYSTEM_ADMIN"];
  const roleNames = { principal: "PRINCIPAL", deputy_principal: "DEPUTY_PRINCIPAL", director: "DIRECTOR" };
  const money = value => new Intl.NumberFormat("en-TZ", { style: "currency", currency: "TZS", maximumFractionDigits: 0 }).format(Number(value || 0));
  const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));

  function showLinks() {
    const links = document.getElementById("lead-links");
    const list = role === "principal" ? [
      ["Published results and comments", "principal-results.html"], ["Approval Center", "approval-center.html"], ["Expense requests and finance approvals", "finance-portal.html#expensesTab"], ["Payroll", "payroll.html"],
      ["Staff and HR", "hr.html"], ["Student records", "students.html"], ["Admissions", "admissions.html"],
      ["Reports", "reports.html"], ["Graduation", "graduation.html"]
    ] : role === "deputy_principal" ? [
      ["Examination workspace", "examination-portal.html"], ["Results review", "staff-portal.html"],
      ["Timetable and teaching", "timetable.html"], ["Student requests", "student-requests.html"],
      ["Quality assurance", "quality-assurance.html"], ["Reports", "reports.html"]
    ] : [
      ["Finance overview", "finance-portal.html"], ["Institutional reports", "reports.html"],
      ["Admissions trends", "admissions.html"], ["Quality assurance", "quality-assurance.html"],
      ["Student management overview", "students.html"]
    ];
    links.innerHTML = list.map(([label, href]) => `<a href="${href}">${escapeHtml(label)} →</a>`).join("");
  }

  function buildInstitutionShell(user) {
    const main = document.querySelector(".lead-wrap");
    if (!main || main.dataset.shellReady) return;
    main.dataset.shellReady = "true";
    const labels = { principal: "Principal", deputy_principal: "Deputy Principal · Academic", director: "Director" };
    const navigation = role === "principal" ? [
      ["Overview","OV","#overview"],["Approvals","AP","approval-center.html"],["Academics","AC","student-requests.html"],
      ["Finance","FN","finance-portal.html#expensesTab"],["Staff","HR","hr.html"],["Reports","RP","reports.html"],["Students","ST","students.html"]
    ] : role === "deputy_principal" ? [
      ["Overview","OV","#overview"],["Verify results","RS","#approval-queue"],["Exams","EX","examination-portal.html"],
      ["Timetable","TT","timetable.html"],["Lecturers","ST","staff-portal.html"],["At-risk students","AR","students.html"],["Quality","QA","quality-assurance.html"]
    ] : [
      ["Overview","OV","#overview"],["Finance summary","FN","finance-portal.html"],["Enrolment trend","EN","#distribution"],
      ["Compliance","QA","quality-assurance.html"],["Risks","RK","reports.html"],["Budget","BG","finance-portal.html"],["Board reports","RP","reports.html"]
    ];
    const shell = document.createElement("div"); shell.className = "lead-app-shell";
    const bar = document.createElement("header"); bar.className = "lead-app-bar";
    bar.innerHTML = `<div class="lead-app-brand"><span class="lead-app-mark">IDMC</span><span><strong>IDMC iMIS</strong><small>Institute of Development and Medical Sciences</small></span></div><div class="lead-app-user"><strong>${escapeHtml(labels[role] || labels.principal)}</strong><span>${escapeHtml(user.fullName || user.full_name || user.email || "Signed in")}</span></div><div class="lead-app-tools"><button id="lead-refresh" type="button">Refresh</button><button id="lead-logout" type="button">Log out</button><button class="lead-mobile-toggle" id="lead-mobile-toggle" type="button" aria-expanded="true">Menu</button></div>`;
    const sidebar = document.createElement("aside"); sidebar.className = "lead-sidebar";
    sidebar.innerHTML = `<div class="lead-sidebar-label">Workspace</div><nav aria-label="${escapeHtml(labels[role] || "Leadership")} navigation">${navigation.map(([label, code, href], index) => `<a href="${href}" class="${index === 0 ? "active" : ""}"><span>${code}</span>${escapeHtml(label)}</a>`).join("")}<a href="dashboard.html" class="lead-logout"><span>HM</span>Institution dashboard</a></nav>`;
    main.before(shell); shell.append(bar, sidebar, main); main.id = "overview";
    const toggle = bar.querySelector("#lead-mobile-toggle");
    toggle.addEventListener("click", () => { const hidden = sidebar.classList.toggle("is-collapsed"); toggle.setAttribute("aria-expanded", String(!hidden)); });
    sidebar.querySelectorAll('a[href^="#"]').forEach(link => link.addEventListener("click", () => { sidebar.querySelectorAll("a").forEach(item => item.classList.toggle("active", item === link)); }));
    const title = main.querySelector(".lead-title"); if (title) title.id = "overview-title";
    const queue = main.querySelector("#lead-result-queue")?.closest(".lead-panel"); if (queue) queue.id = "approval-queue";
    const distribution = main.querySelector("#lead-distribution")?.closest(".lead-panel"); if (distribution) distribution.id = "distribution";
    const header = main.querySelector(".lead-title");
    if (header && !header.querySelector(".lead-role-shortcuts")) {
      const shortcuts = document.createElement("div"); shortcuts.className = "lead-role-shortcuts";
      shortcuts.innerHTML = `<a href="principal-portal.html">Principal</a><a href="deputy-principal-portal.html">Deputy Principal</a><a href="director-portal.html">Director</a>`;
      header.append(shortcuts);
    }
  }

  function stageForRole() {
    if (role === "principal") return { status: "PUBLISHED", endpoint: "principal-comment", permission: "results.principal.comment", button: "Comment to HOD" };
    if (role === "deputy_principal") return { status: "EXAMINATION_REVIEWED", endpoint: "deputy-review", permission: "results.deputy.review", button: "Complete academic review" };
    return null;
  }

  function renderQueue(rows, canAct) {
    const host = document.getElementById("lead-result-queue");
    const stage = stageForRole();
        const mine = stage ? rows.filter(row => row.result_status === stage.status || role === "principal" && row.result_status === "LOCKED") : rows;
    if (!mine.length) {
      host.innerHTML = '<p class="empty">No result items available. Open the published results workspace for all pages.</p>';
      return;
    }
    const actionColumn = canAct && stage;
    host.innerHTML = `<div style="overflow:auto"><table class="queue-table"><thead><tr><th>Student</th><th>Course</th><th>Academic period</th><th>Status</th>${actionColumn ? "<th>Action</th>" : ""}</tr></thead><tbody>${mine.map(row => `<tr><td><strong>${escapeHtml(row.student_number || "Student")}</strong><br>${escapeHtml(row.student_name || "")}</td><td>${escapeHtml(row.course_label || "—")}</td><td>${escapeHtml(row.academic_year || "—")}<br>${escapeHtml(row.semester_name || "")}</td><td>${escapeHtml(row.result_status)}</td>${actionColumn ? `<td><button class="queue-action" data-result-id="${escapeHtml(row.id)}">${escapeHtml(stage.button)}</button></td>` : ""}</tr>`).join("")}</tbody></table></div>`;
    host.querySelectorAll("[data-result-id]").forEach(button => button.addEventListener("click", async () => {
      if(role === "principal") { window.location.href="principal-results.html?result="+encodeURIComponent(button.dataset.resultId);return; }
      button.disabled = true;
      try {
        await window.IDMCAPI.post(`/workflows/course-results/${encodeURIComponent(button.dataset.resultId)}/${stage.endpoint}`, {});
        button.closest("tr").remove();
        if (!host.querySelector("tbody tr")) host.innerHTML = '<p class="empty">No result items available. Open the published results workspace for all pages.</p>';
        set("lead-message", "Result decision saved. The next authorized reviewer can now continue the chain.");
        await loadMetrics();
      } catch (error) { set("lead-message", error.message || "Could not save the decision."); button.disabled = false; }
    }));
  }

  async function loadMetrics() {
    try {
      const payload = await window.IDMCAPI.get("/leadership/dashboard");
      const data = payload.data || payload;
      set("metric-students", data.students.total); set("metric-active", data.students.active);
      set("metric-new", data.students.newPendingActivation); set("metric-withdrawn", `${data.students.withdrawn} / ${data.students.suspended}`);
      set("metric-revenue", money(data.finance.monthRevenue)); set("metric-expenditure", money(data.finance.monthExpenditure));
      set("metric-arrears", money(data.finance.outstandingFees));
      set("metric-attendance", data.attendance.studentRecordsThisPeriod); set("metric-staff-attendance", data.attendance.staffRecordsThisPeriod);
      set("lead-updated", `Updated ${new Date(data.generatedAt).toLocaleString()} · attendance counts cover this month’s recorded rows.`);
      const summary = document.getElementById("lead-result-summary");
      summary.innerHTML = role === "principal" ? '<a href="principal-results.html">View published results and send comments to HOD →</a>' : `Waiting HOD <strong>${data.results.waitingHod}</strong> · Examinations <strong>${data.results.waitingExamination}</strong> · Deputy <strong>${data.results.waitingDeputy}</strong> · Principal <strong>${data.results.waitingPrincipal}</strong> · Registrar <strong>${data.results.waitingRegistrar}</strong> · Delayed over 14 days <strong>${data.results.delayedOver14Days}</strong>`;
      const approvalSummary = document.getElementById("lead-approval-summary");
      approvalSummary.innerHTML = `Pending finance expense approval <strong>${data.approvals.expenses}</strong> · Payroll ready for review <strong>${data.approvals.payroll}</strong> · Refund requests <strong>${data.approvals.refunds}</strong>`;
      const distribution = document.getElementById("lead-distribution");
      const programmeRows = data.studentDistribution.byProgramme.map(item => `<tr><td>${escapeHtml(item.programme)}</td><td>${escapeHtml(item.total)}</td></tr>`).join("");
      const yearRows = data.studentDistribution.byAdmissionYear.map(item => `<tr><td>${escapeHtml(item.year)}</td><td>${escapeHtml(item.total)}</td></tr>`).join("");
      distribution.innerHTML = `<div class="lead-grid" style="margin:0;grid-template-columns:1fr 1fr"><div><strong>Programme</strong><table class="queue-table"><tbody>${programmeRows || "<tr><td>No programme records</td></tr>"}</tbody></table></div><div><strong>Admission year</strong><table class="queue-table"><tbody>${yearRows || "<tr><td>No admission years</td></tr>"}</tbody></table></div></div>`;
      const queuePayload = await window.IDMCAPI.get(role === "principal" ? "/workflows/course-results/principal-workspace?limit=100&offset=0" : "/workflows/course-results/leadership-queue");
      const queue = role === "principal" ? (queuePayload.data?.items || []) : (queuePayload.data || []);
      const canAct = Boolean(stageForRole() && await window.IDMC_RBAC_API.hasPermission(stageForRole().permission));
      renderQueue(queue, canAct);
      set("lead-message", "Dashboard connected to institutional records.");
    } catch (error) {
      set("lead-message", error.message || "Dashboard data could not be loaded. Confirm backend and migration status.");
      document.getElementById("lead-result-queue").textContent = "Result queue is unavailable until backend access and permissions are ready.";
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    if (!(await window.IDMCAuth.requireAuth())) return;
    const user = window.IDMCAuth.getUser() || {};
    const codes = (user.roles || []).map(item => String(item.roleCode || item.role_code || "").toUpperCase());
    if (!codes.includes(roleNames[role]) && !codes.some(code => adminRoles.includes(code))) {
      window.location.replace("dashboard.html"); return;
    }
    if (!(await window.IDMC_RBAC_API.ensureRBACLoaded()) || !(await window.IDMC_RBAC_API.hasPermission("leadership.dashboard.view"))) {
      set("lead-message", "Your role is not assigned the leadership dashboard permission."); return;
    }
    const name = user.fullName || user.full_name || user.email || "Leadership user";
    set("lead-welcome", `Welcome, ${name}. Review the metrics and decisions available to your role.`);
    buildInstitutionShell(user);
    showLinks();
    document.querySelectorAll("#lead-refresh").forEach(button => button.addEventListener("click", loadMetrics));
    document.querySelectorAll("#lead-logout").forEach(button => button.addEventListener("click", () => window.IDMCAuth.logout()));
    await loadMetrics();
  });
})();
