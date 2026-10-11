(function () {
  "use strict";

  const portals = {
    hod: { title: "Head of Department", role: ["HOD", "DEPUTY_HOD"], description: "Department teaching, results, attendance and student-request workspaces. Records and actions remain limited by your department permissions.", modules: [
      ["Department requests", "Review student requests assigned to your department.", "student-requests.html", ["student_requests.view_department", "student_requests.decide_department"]],
      ["Course allocation", "Assign active lecturers to teaching courses in your department.", "hod-course-allocation.html", ["lecturer.assignments.manage"]],
      ["Publish results", "Publish submitted departmental results and read Principal comments.", "hod-results.html", ["results.hod.publish"]],
      ["Intake & Academic Progression", "Review permitted student progression and manage intake result windows.", "intake-progression.html", ["results.window.manage", "results.hod.publish", "student_requests.view_department"]],
      ["Timetable", "Review course schedules and timetable records.", "timetable.html", ["timetable.view"]],
      ["Attendance", "Review attendance records available to your department.", "attendance.html", ["attendance.view"]],
      ["Department reports", "Open institutional reports allowed for your account.", "reports.html", ["reports.view"]]
    ] },
    hr: { title: "Human Resources", role: ["HR_OFFICER", "HR_MANAGER", "HUMAN_RESOURCES"], description: "Staff records, employment services and human resources workspaces.", modules: [
      ["Staff register", "Manage staff records, qualifications and employment history.", "staff.html", ["staff.view", "staff.manage"]],
      ["Staff operations", "Open the HR workspace for staff services and administration.", "staff-operations.html", ["hr.view"]],
      ["Leave management", "Review staff leave and related decisions.", "hr.html", ["leave.view", "leave.manage"]],
      ["Staff attendance", "Review attendance records for staff.", "hr.html", ["staff.attendance.view"]],
      ["Payroll", "Open payroll periods, components and staff payroll records.", "payroll.html", ["payroll.view"]],
      ["Reports", "View institutional reports available to your account.", "reports.html", ["reports.view"]]
    ] },
    procurement: { title: "Procurement", role: ["PROCUREMENT_OFFICER"], description: "Procurement requests, suppliers and purchasing records.", modules: [
      ["Procurement workspace", "Manage supplier, request and purchase order records.", "procurement.html", ["procurement.view", "procurement.manage"]],
      ["Inventory and stores", "Coordinate approved purchases with stock records.", "inventory.html", ["inventory.view"]],
      ["Assets", "Review institutional asset records and assignments.", "assets.html", ["assets.view"]],
      ["Finance", "Continue approved finance work in the finance workspace.", "finance-portal.html", ["finance.portal.view"]],
      ["Reports", "View reports available to your account.", "reports.html", ["reports.view"]]
    ] },
    stores: { title: "Stores and Inventory", role: ["STORE_OFFICER"], description: "Stock records and connected procurement and asset workspaces.", modules: [
      ["Inventory", "Review items, categories and stock transactions.", "inventory.html", ["inventory.view", "inventory.manage"]],
      ["Procurement", "Check supplier and purchase order records.", "procurement.html", ["procurement.view"]],
      ["Assets", "Review assets and assignments connected to institutional stock.", "assets.html", ["assets.view"]],
      ["Reports", "View reports available to your account.", "reports.html", ["reports.view"]]
    ] },
    operations: { title: "Operations", role: ["OPERATIONS_OFFICER"], description: "Operational services linked to facilities, assets, inventory and procurement.", modules: [
      ["Operations workspace", "Open operational records and services.", "operations.html", ["operations.view", "operations.manage"]],
      ["Assets and maintenance", "Review assets, maintenance and assignments.", "assets.html", ["assets.view"]],
      ["Inventory", "Review stock records and transactions.", "inventory.html", ["inventory.view"]],
      ["Procurement", "Follow purchasing requests and orders.", "procurement.html", ["procurement.view"]],
      ["Hostel", "Open accommodation services.", "hostel.html", ["hostel.view"]],
      ["Reports", "View reports available to your account.", "reports.html", ["reports.view"]]
    ] },
    qa: { title: "Quality Assurance", role: ["QUALITY_ASSURANCE", "QA_OFFICER"], description: "Quality reviews, findings, follow-up and institutional reporting.", modules: [
      ["Quality workspace", "Review standards, quality reviews and findings.", "quality-assurance.html", ["qa.view", "qa.manage"]],
      ["Research records", "Open research records where permitted.", "research.html", ["research.view"]],
      ["Reports", "View quality and institutional reports available to your account.", "reports.html", ["reports.view"]]
    ] },
    research: { title: "Research", role: ["RESEARCH_OFFICER"], description: "Research projects and related institutional records.", modules: [
      ["Research workspace", "Review and manage research project records.", "research.html", ["research.view", "research.manage"]],
      ["Quality assurance", "Open quality review records where permitted.", "quality-assurance.html", ["qa.view"]],
      ["Reports", "View research and institutional reports available to your account.", "reports.html", ["reports.view"]]
    ] },
    communications: { title: "Communications", role: ["COMMUNICATIONS_OFFICER"], description: "Institutional announcements and communication records.", modules: [
      ["Communications workspace", "Open communication records and related tools.", "communications.html", ["communications.view", "communications.manage"]],
      ["Announcements", "Prepare and review institutional announcements.", "announcements.html", ["communications.view"]],
      ["Documents", "Open records in the institutional document registry.", "documents.html", ["documents.view"]],
      ["Reports", "View reports available to your account.", "reports.html", ["reports.view"]]
    ] },
    documents: { title: "Documents Registry", role: ["DOCUMENTS_OFFICER"], description: "Institutional documents, metadata and controlled access records.", modules: [
      ["Document registry", "Review institutional documents and their records.", "documents.html", ["documents.view", "documents.manage"]],
      ["Communications", "Open related institutional communication records.", "communications.html", ["communications.view"]],
      ["Reports", "View reports available to your account.", "reports.html", ["reports.view"]]
    ] },
    helpdesk: { title: "Help Desk", role: ["HELPDESK_OFFICER"], description: "Service tickets, assignment and resolution workspaces.", modules: [
      ["Helpdesk tickets", "Review and work on service desk tickets.", "helpdesk.html", ["helpdesk.view", "helpdesk.manage"]],
      ["Documents", "Open supporting document records where permitted.", "documents.html", ["documents.view"]],
      ["Reports", "View reports available to your account.", "reports.html", ["reports.view"]]
    ] },
    auditor: { title: "Auditor Workspace", role: ["AUDITOR"], description: "Read-only audit, security and institutional reporting records.", modules: [
      ["Audit logs", "Review recorded audit events. Actions remain read-only.", "audit-logs.html", ["audit.view"]],
      ["Reports", "Review reports assigned to your account.", "reports.html", ["reports.view"]]
    ] },
    reports: { title: "Reports and Analytics", role: ["REPORTS_OFFICER", "REPORTING_OFFICER"], description: "Institutional reporting and available analytics workspaces.", modules: [
      ["Reports", "Open available report definitions and results.", "reports.html", ["reports.view", "reports.run"]],
      ["Audit logs", "Review audit events where the account has read access.", "audit-logs.html", ["audit.view"]]
    ] }
  };

  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
  const adminRoles = ["ADMIN", "SUPER_ADMIN", "SYSTEM_ADMIN"];
  const portalRoutes = { ADMIN:"dashboard.html",SUPER_ADMIN:"dashboard.html",SYSTEM_ADMIN:"dashboard.html",PRINCIPAL:"principal-portal.html",DEPUTY_PRINCIPAL:"deputy-principal-portal.html",DIRECTOR:"director-portal.html",STUDENT:"student-portal.html",APPLICANT:"applicant-portal.html",FINANCE_OFFICER:"finance-portal.html",ACCOUNTANT:"finance-portal.html",FINANCE_MANAGER:"finance-portal.html",ADMISSIONS_OFFICER:"admission-portal.html",HOD:"hod-portal.html",DEPUTY_HOD:"hod-portal.html",REGISTRAR:"registry-portal.html",ACADEMIC_OFFICER:"registry-portal.html",EXAMINATION_OFFICER:"examination-portal.html",EXAMINATIONS_OFFICER:"examination-portal.html",EXAM_OFFICER:"examination-portal.html",HR_OFFICER:"hr-portal.html",HR_MANAGER:"hr-portal.html",HUMAN_RESOURCES:"hr-portal.html",PROCUREMENT_OFFICER:"procurement-portal.html",STORE_OFFICER:"inventory-portal.html",OPERATIONS_OFFICER:"operations-portal.html",QUALITY_ASSURANCE:"qa-portal.html",QA_OFFICER:"qa-portal.html",RESEARCH_OFFICER:"research-portal.html",COMMUNICATIONS_OFFICER:"communications-portal.html",DOCUMENTS_OFFICER:"documents-portal.html",HELPDESK_OFFICER:"helpdesk-portal.html",AUDITOR:"auditor-portal.html",REPORTS_OFFICER:"reports-portal.html",REPORTING_OFFICER:"reports-portal.html",DISCIPLINE_OFFICER:"discipline.html",COUNSELLOR:"student-welfare.html",WELFARE_OFFICER:"student-welfare.html",TRANSPORT_OFFICER:"transport.html",BUDGET_OFFICER:"budget-management.html",RISK_OFFICER:"risk-register.html",PLANNING_OFFICER:"strategic-planning.html",BOARD_SECRETARY:"management-meetings.html",GRIEVANCE_OFFICER:"grievances.html",ACCREDITATION_OFFICER:"accreditation-management.html",LIBRARIAN:"library-portal.html",LECTURER:"lecturer-portal.html",ALUMNI:"alumni-portal.html",STAFF:"staff-portal.html" };
  const roleCode = role => String(role?.roleCode || role?.role_code || "").toUpperCase();
  const portalPage = role => portalRoutes[roleCode(role)] || "access-denied.html";
  const assignedPortals = roles => roles.map(role => ({ role, code:roleCode(role), page:portalPage(role), name:role.roleName || role.role_name || role.roleCode || role.role_code || "Portal" })).filter(item => item.page !== "access-denied.html");

  document.addEventListener("DOMContentLoaded", async () => {
    const slug = document.body.dataset.rolePortal;
    const config = portals[slug];
    const root = document.getElementById("rolePortalRoot");
    if (!config || !root || !window.IDMCAuth || !(await window.IDMCAuth.requireAuth())) return;
    const user = window.IDMCAuth.getUser() || {};
    const roles = user.roles || [];
    let activeRoleId = window.IDMCAuth.getActiveRoleId();
    let activeRole = roles.find(item => String(item.id) === String(activeRoleId));
    let activeCode = String(activeRole?.roleCode || activeRole?.role_code || "").toUpperCase();
    const portalsForUser = assignedPortals(roles);
    if (!config.role.includes(activeCode)) {
      const matchingRole = roles.find(item => config.role.includes(roleCode(item)));
      if (matchingRole) {
        try {
          window.IDMCAuth.setActiveRole(matchingRole.id);
          activeRole = matchingRole;
          activeRoleId = matchingRole.id;
          activeCode = roleCode(matchingRole);
        } catch (error) {
          console.error("Unable to activate the role required by this portal", error);
        }
      }
    }
    const activePortal = portalPage(activeRole);
    if (!activeRole) {
      root.innerHTML = '<p class="rp-empty">Your account has no active role. Contact an administrator to review your access.</p>'; return;
    }
    if (!config.role.includes(activeCode)) {
      window.location.replace("dashboard.html"); return;
    }
    const rbac = window.IDMC_RBAC_API;
    const loaded = rbac && await rbac.ensureRBACLoaded();
    if (!loaded) { root.innerHTML = '<p class="rp-empty">Access permissions could not be loaded. Refresh this page or contact an administrator.</p>'; return; }
    const intakeProgressionRoles = ["ACADEMIC_OFFICER", "ADMISSIONS_OFFICER", "HOD", "DEPUTY_HOD", "LECTURER"];
    const modules = config.modules.filter(item => item[2] === "intake-progression.html"
      ? intakeProgressionRoles.includes(activeCode)
      : item[3].some(permission => rbac.hasPermission(permission)) || adminRoles.includes(activeCode));
    const profileUser = user.user || user;
    const name = profileUser.fullName || profileUser.full_name || profileUser.displayName || [profileUser.firstName, profileUser.middleName, profileUser.lastName].filter(Boolean).join(" ") || profileUser.email || "Signed in";
    if (slug === "hod") {
      const nav = modules.map((item, index) => `<a class="hod-nav-link" href="${esc(item[2])}"><span class="hod-nav-index">0${index + 1}</span><span>${esc(item[0])}</span></a>`).join("");
      root.innerHTML = `<div class="hod-shell"><aside class="hod-sidebar" id="hodSidebar"><a class="hod-brand" href="hod-portal.html"><span class="rp-mark">IDMS</span><span><strong>IDMS iMIS</strong><small>Academic Office</small></span></a><div class="hod-sidebar-label">DEPARTMENT</div><nav class="hod-nav"><a class="hod-nav-link active" href="hod-portal.html"><span class="hod-nav-index">01</span><span>Overview</span></a>${nav}</nav><a class="hod-back-link" href="dashboard.html">← Institutional dashboard</a></aside><button class="hod-backdrop" id="hodBackdrop" type="button" aria-label="Close navigation" hidden></button><section class="hod-main"><header class="hod-topbar"><button class="rp-button hod-menu" id="hodMenu" type="button" aria-label="Open navigation" aria-controls="hodSidebar" aria-expanded="false">☰</button><div class="hod-crumb">Academic affairs <span>/</span> Department</div><div class="rp-actions"><span class="rp-user">${esc(name)}</span><button class="rp-button" id="rpRefresh" type="button">Refresh</button><button class="rp-button" id="rpLogout" type="button">Log out</button></div></header><main class="hod-content"><section class="hod-welcome"><div><span class="rp-eyebrow">Department workflow</span><h1>Good day, ${esc(config.title)}</h1><p>${esc(config.description)}</p></div><div class="hod-period" id="hodScopeLabel">Your department</div></section><div class="hod-message" id="hodLoadMessage" role="status">Loading current department figures…</div><section class="hod-metrics" id="hodMetrics" aria-label="Department overview"></section><section class="hod-workflow"><div><h2>Academic results workflow</h2><p>Lecturer submits → HOD publishes → Principal views and comments → HOD receives feedback</p></div><a class="rp-link" href="hod-results.html">Open result publication →</a></section><div class="hod-section-heading"><div><span class="rp-eyebrow">Authorised workspaces</span><h2>Department work</h2></div></div>${modules.length ? `<section class="hod-workspaces">${modules.map((item, index) => `<article class="hod-work-card"><span class="hod-card-number">${String(index + 1).padStart(2, "0")}</span><h3>${esc(item[0])}</h3><p>${esc(item[1])}</p><a href="${esc(item[2])}">Open workspace <span aria-hidden="true">→</span></a></article>`).join("")}</section>` : '<p class="rp-empty">No HOD modules are enabled for this account. Ask an administrator to review the HOD role permissions.</p>'}<footer class="rp-footer">IDMS iMIS · Department access is restricted by your staff record and role permissions.</footer></main></section></div>`;
      const loadOverview = async () => {
        const message = document.getElementById("hodLoadMessage"), metrics = document.getElementById("hodMetrics");
        try {
          const response = await window.IDMCAPI.get("/student-requests/department-dashboard", { cache: "no-store" });
          const data = response.data || {};
          const values = [["Department staff", data.teachers ?? 0, "Active staff"], ["Active modules", data.modules ?? 0, "Courses in department"], ["Students", data.students ?? 0, "Active or pending activation"], ["Awaiting result verification", data.pendingMarks ?? 0, "Submitted results"], ["Open student requests", data.openRequests ?? 0, "Require department review"], ["Pass rate", data.passRate == null ? "—" : `${data.passRate}%`, "Current result records"]];
          metrics.innerHTML = values.map(item => `<article class="hod-metric"><span>${esc(item[0])}</span><strong>${esc(item[1])}</strong><small>${esc(item[2])}</small></article>`).join("");
          message.textContent = "Department summary refreshed from institutional records."; message.className = "hod-message success";
          if (data.departmentName) document.getElementById("hodScopeLabel").textContent = data.departmentName;
        } catch (error) { metrics.innerHTML = ""; message.textContent = error.message || "Department summary could not be loaded."; message.className = "hod-message error"; }
      };
      const sidebar = document.getElementById("hodSidebar"), menuButton = document.getElementById("hodMenu"), backdrop = document.getElementById("hodBackdrop");
      const closeSidebar = () => { sidebar.classList.remove("open"); backdrop.hidden = true; menuButton.setAttribute("aria-expanded", "false"); document.body.classList.remove("hod-menu-open"); };
      menuButton.addEventListener("click", () => { const open = !sidebar.classList.contains("open"); sidebar.classList.toggle("open", open); backdrop.hidden = !open; menuButton.setAttribute("aria-expanded", String(open)); document.body.classList.toggle("hod-menu-open", open); });
      backdrop.addEventListener("click", closeSidebar);
      sidebar.addEventListener("click", event => { if (event.target.closest("a")) closeSidebar(); });
      document.addEventListener("keydown", event => { if (event.key === "Escape") closeSidebar(); });
      document.getElementById("rpRefresh").addEventListener("click", loadOverview);
      loadOverview();
    } else {
      root.innerHTML = `<header class="rp-top"><div class="rp-head"><a class="rp-brand" href="dashboard.html"><span class="rp-mark">IDMS</span><span><strong>IDMS iMIS</strong><small>Institute of Development and Medical Sciences</small></span></a><div class="rp-actions"><span class="rp-user">${esc(name)}</span><button class="rp-button" id="rpLogout" type="button">Log out</button></div></div></header><main><section class="rp-intro"><span class="rp-eyebrow">Institutional workspace</span><h1>${esc(config.title)}</h1><p>${esc(config.description)}</p></section><h2 class="rp-section-title">Your workspaces</h2><p class="rp-status">Only modules enabled for your account are listed.</p>${modules.length ? `<section class="rp-grid">${modules.map(item => `<article class="rp-card"><h3>${esc(item[0])}</h3><p>${esc(item[1])}</p><a class="rp-link" href="${esc(item[2])}">Open workspace →</a></article>`).join("")}</section>` : '<p class="rp-empty">No workspace modules are assigned to this account. Contact an administrator to review your role permissions.</p>'}<footer class="rp-footer">IDMS iMIS · Access is controlled by your institutional role and permissions.</footer></main>`;
    }
    const brand = root.querySelector(".rp-brand, .hod-brand");
    if (brand && activePortal !== "access-denied.html") brand.href = activePortal;
    const backLink = root.querySelector(".hod-back-link");
    if (backLink) {
      const isAdmin = roles.some(role => adminRoles.includes(roleCode(role)));
      backLink.href = isAdmin ? "dashboard.html" : activePortal;
      backLink.textContent = isAdmin ? "Admin Dashboard" : "Back to my portal";
    }
    if (portalsForUser.length > 1) {
      if (slug === "hod") {
        const sidebar = root.querySelector(".hod-sidebar"), back = sidebar?.querySelector(".hod-back-link");
        if (sidebar && back) {
          const label = document.createElement("div"); label.className = "hod-sidebar-label"; label.textContent = "MY PORTALS";
          const portalNav = document.createElement("nav"); portalNav.className = "hod-nav"; portalNav.setAttribute("aria-label", "My Portals");
          portalsForUser.forEach((item, index) => { const link = document.createElement("a"); link.className = "hod-nav-link"; link.href = item.page; link.addEventListener("click", () => { try { window.IDMCAuth.setActiveRole(item.role.id); } catch (error) { console.error("Unable to switch portal role", error); } }); const number = document.createElement("span"); number.className = "hod-nav-index"; number.textContent = String(index + 1).padStart(2, "0"); const title = document.createElement("span"); title.textContent = item.name; link.append(number, title); portalNav.append(link); });
          sidebar.insertBefore(label, back); sidebar.insertBefore(portalNav, back);
        }
      } else {
        const intro = root.querySelector(".rp-intro");
        if (intro) {
          const section = document.createElement("section"); section.className = "rp-my-portals"; section.setAttribute("aria-label", "My Portals");
          const heading = document.createElement("h2"); heading.className = "rp-section-title"; heading.textContent = "My Portals";
          const list = document.createElement("div"); list.className = "rp-portal-links";
          portalsForUser.forEach(item => { const link = document.createElement("a"); link.className = "rp-portal-link"; link.href = item.page; link.addEventListener("click", () => { try { window.IDMCAuth.setActiveRole(item.role.id); } catch (error) { console.error("Unable to switch portal role", error); } }); const title = document.createElement("span"); title.textContent = item.name; const state = document.createElement("small"); state.textContent = item.page === activePortal ? "Current portal" : "Open portal"; link.append(title, state); list.append(link); });
          section.append(heading, list); intro.after(section);
        }
      }
    }
    const actions = root.querySelector(".rp-actions");
    if (actions) {
      const profile = user.staffProfile || {};
      const avatar = document.createElement(profile.profilePhotoUrl || profileUser.profilePhotoUrl ? "img" : "span");
      avatar.className = "rp-profile-avatar";
      if (avatar.tagName === "IMG") {
        avatar.src = profile.profilePhotoUrl || profileUser.profilePhotoUrl;
        avatar.alt = `${name} profile photo`;
        avatar.addEventListener("error", () => { avatar.replaceWith(document.createTextNode("ID")); });
      } else {
        avatar.textContent = name.split(/\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase() || "ID";
      }
      const heading = document.createElement("span");
      heading.className = "rp-profile-summary";
      heading.textContent = [name, profile.employeeNumber || profileUser.staffNumber || "Staff number unavailable", activeRole.roleName || activeCode, profile.departmentName || profileUser.departmentName].filter(Boolean).join(" · ");
      actions.insertBefore(avatar, actions.firstChild);
      actions.insertBefore(heading, actions.firstChild);
      const profileLink = document.createElement("a");
      profileLink.className = "rp-button";
      profileLink.href = "profile.html";
      profileLink.textContent = "My profile";
      actions.insertBefore(profileLink, actions.querySelector("#rpLogout"));
      if (roles.length > 1) {
        const switcher = document.createElement("select");
        switcher.className = "rp-role-switcher";
        switcher.setAttribute("aria-label", "Switch role");
        switcher.innerHTML = roles.map(role => `<option value="${esc(role.id)}" ${String(role.id) === String(activeRoleId) ? "selected" : ""}>${esc(role.roleName || role.roleCode || role.role_code || "Role")}</option>`).join("");
        switcher.addEventListener("change", () => {
          try {
            window.IDMCAuth.setActiveRole(switcher.value);
            window.location.replace(window.IDMCAuth.getLandingPage());
          } catch (error) {
            switcher.value = activeRoleId;
            alert(error.message || "Unable to switch role.");
          }
        });
        actions.insertBefore(switcher, profileLink);
      }
    }
    document.getElementById("rpLogout").addEventListener("click", () => window.IDMCAuth.logout());
  });
})();
