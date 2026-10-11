(function () {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? "—").replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));
  const card = $("#adminDeletionDashboardCard");
  if (!card || !window.IDMCAuth || !window.IDMC_RBAC_API || !window.IDMCAPI) return;

  async function load() {
    const body = $("#adminDeletionRows"), message = $("#adminDeletionMessage");
    message.textContent = "Loading pending requests…";
    try {
      const response = await window.IDMCAPI.get("/students/deletion-requests");
      const rows = Array.isArray(response.data) ? response.data : [];
      $("#adminDeletionCount").textContent = `(${rows.length} pending)`;
      body.innerHTML = rows.length ? rows.map(request => {
        const student = request.students || {};
        const name = [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ");
        return `<tr><td style="padding:10px;border-bottom:1px solid #eee"><strong>${esc(student.student_number || student.registration_number)}</strong><br>${esc(name)}</td><td style="padding:10px;border-bottom:1px solid #eee">${esc(student.student_status)}</td><td style="padding:10px;border-bottom:1px solid #eee;max-width:320px">${esc(request.request_reason)}</td><td style="padding:10px;border-bottom:1px solid #eee">${esc(request.created_at ? new Date(request.created_at).toLocaleString() : "—")}</td><td style="padding:10px;border-bottom:1px solid #eee;white-space:nowrap"><button type="button" data-delete-decision="approve" data-request-id="${esc(request.id)}">Approve &amp; archive</button> <button type="button" data-delete-decision="reject" data-request-id="${esc(request.id)}">Reject</button></td></tr>`;
      }).join("") : '<tr><td colspan="5" style="padding:13px">No student deletion requests are awaiting approval.</td></tr>';
      message.textContent = `Queue refreshed ${new Date().toLocaleTimeString()}. Student records are archived only after approval.`;
      body.querySelectorAll("[data-delete-decision]").forEach(button => button.addEventListener("click", async () => {
        const isApprove = button.dataset.deleteDecision === "approve";
        let reason = "";
        if (!window.confirm(isApprove ? "Approve this request and archive the student? Academic, finance and audit records will be retained." : "Reject this deletion request? The student will remain active.")) return;
        if (!isApprove) {
          reason = window.prompt("Enter a reason for rejecting this request:")?.trim() || "";
          if (!reason) return;
        }
        button.disabled = true;
        try {
          const id = encodeURIComponent(button.dataset.requestId);
          await window.IDMCAPI.post(`/students/deletion-requests/${id}/${isApprove ? "approve" : "reject"}`, isApprove ? {} : { reason });
          message.textContent = isApprove ? "Request approved. Student archived; records retained." : "Request rejected. Student record remains unchanged.";
          await load();
        } catch (error) {
          message.textContent = error.message || "Unable to review the deletion request.";
          button.disabled = false;
        }
      }));
    } catch (error) {
      $("#adminDeletionCount").textContent = "";
      body.innerHTML = `<tr><td colspan="5" style="padding:13px;color:#9c2f35">${esc(error.message || "Unable to load deletion requests.")}</td></tr>`;
      message.textContent = "Sign in with an administrator account and try again. If the problem continues, contact your system administrator.";
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    if (!(await window.IDMCAuth.requireAuth())) return;
    try {
      await window.IDMC_RBAC_API.ensureRBACLoaded();
      if (!(await window.IDMC_RBAC_API.hasPermission("students.delete.approve"))) return;
      card.hidden = false;
      await load();
      $("#refreshAdminDeletionRequests").addEventListener("click", load);
    } catch (error) {
      $("#adminDeletionMessage").textContent = error.message || "Admin permissions could not be confirmed.";
    }
  });
})();
