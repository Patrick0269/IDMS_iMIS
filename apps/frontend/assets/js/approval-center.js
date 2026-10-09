(function () {
  "use strict";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
  const admins = ["ADMIN", "SUPER_ADMIN", "SYSTEM_ADMIN"];
  document.addEventListener("DOMContentLoaded", async () => {
    const root = document.getElementById("approvalCenterRoot");
    if (!root || !window.IDMCAuth || !(await window.IDMCAuth.requireAuth())) return;
    const user = window.IDMCAuth.getUser() || {};
    const roles = (user.roles || []).map(role => String(role.roleCode || role.role_code || "").toUpperCase());
    if (!roles.includes("PRINCIPAL") && !roles.some(role => admins.includes(role))) { window.location.replace("dashboard.html"); return; }
    const rbac = window.IDMC_RBAC_API;
    if (!rbac || !(await rbac.ensureRBACLoaded()) || !rbac.hasPermission("leadership.dashboard.view")) {
      root.innerHTML = '<main><p class="rp-empty">Your account does not have access to the Principal Approval Center.</p></main>'; return;
    }
    const entries = [
      { title:"Published results and comments", note:"HOD publishes directly. View results and send comments to the department HOD.", href:"principal-results.html", permission:"results.principal.comment" },
      { title:"Finance expenses", note:"Open the Finance expense workflow to review requests and their approval history.", href:"finance-portal.html#expensesTab", key:["approvals","expenses"], permission:"finance.expenses.approve" },
      { title:"Payroll", note:"Review payroll periods in the existing payroll workspace.", href:"payroll.html", key:["approvals","payroll"], permission:"payroll.view" },
      { title:"Refund requests", note:"Review refunds in Finance with the existing finance permissions.", href:"refunds.html", key:["approvals","refunds"], permission:"finance.refunds.view" },
      { title:"Procurement", note:"Review procurement requests in the purchasing workspace.", href:"procurement.html", permission:"procurement.view" },
      { title:"Staff leave", note:"Review leave requests in the HR workspace.", href:"leave.html", permission:"leave.view" },
      { title:"Graduation", note:"Open graduation eligibility and approval records.", href:"graduation.html", permission:"graduation.view" },
      { title:"Student requests and programme changes", note:"Review deferment, programme-change and student-service requests in their existing workflow.", href:"student-requests.html", permission:"student_requests.view_department" },
      { title:"Document reviews", note:"Review institutional documents and their approval status.", href:"documents.html", permission:"documents.view" },
      { title:"Disciplinary cases", note:"Open restricted case records and review assigned decisions.", href:"discipline.html", permission:"discipline.view" }
    ];
    const visible = entries.filter(entry => rbac.hasPermission(entry.permission) || roles.some(role => admins.includes(role)));
    const name = user.fullName || user.full_name || user.displayName || user.email || "Principal";
    root.innerHTML = `<header class="rp-top"><div class="rp-head"><a class="rp-brand" href="principal-portal.html"><span class="rp-mark">IDMC</span><span><strong>IDMC iMIS</strong><small>Principal workspace</small></span></a><div class="rp-actions"><span class="rp-user">${esc(name)}</span><button class="rp-button" id="approvalLogout" type="button">Log out</button></div></div></header><main><section class="rp-intro"><span class="rp-eyebrow">Leadership decisions</span><h1>Approval Center</h1><p>Open an existing review form to inspect records, add comments and make a decision under its current workflow.</p></section><p id="approvalCenterStatus" class="rp-status" role="status">Loading current queue summaries…</p><section id="approvalCenterCards" class="rp-grid"></section><footer class="rp-footer">Queue totals come from institutional records when available. Each decision is saved and audited by its existing module.</footer></main>`;
    document.getElementById("approvalLogout").addEventListener("click", () => window.IDMCAuth.logout());
    const cards = document.getElementById("approvalCenterCards");
    cards.innerHTML = visible.map(entry => `<article class="rp-card"><h3>${esc(entry.title)}</h3><p>${esc(entry.note)}</p><span class="rp-status" data-summary="${esc(entry.key ? entry.key.join(".") : "")}">Queue count is not available here.</span><a class="rp-link" href="${esc(entry.href)}">Open review workspace →</a></article>`).join("") || '<p class="rp-empty">No approval workspaces are assigned to this account.</p>';
    try {
      const response = await window.IDMCAPI.get("/leadership/dashboard");
      const data = response.data || response;
      cards.querySelectorAll("[data-summary]").forEach(node => {
        const path = node.dataset.summary.split(".");
        if (!path[0]) return;
        const value = path.reduce((current, key) => current && current[key], data);
        node.textContent = Number.isFinite(Number(value)) ? `${Number(value)} item(s) in the current queue summary.` : "Queue count is not available here.";
      });
      document.getElementById("approvalCenterStatus").textContent = `Queue summary refreshed ${new Date(data.generatedAt || Date.now()).toLocaleString()}. Open a workspace to review individual records.`;
    } catch (error) {
      document.getElementById("approvalCenterStatus").textContent = `Queue totals are temporarily unavailable. You can still open a permitted review workspace. ${error.message || ""}`;
    }
  });
})();
