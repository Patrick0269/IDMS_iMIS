(function () {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const form = $("#dataDeletionForm");
  if (!form || !window.IDMCAuth || !window.IDMC_RBAC_API || !window.IDMCAPI) return;
  const preview = $("#deletionPreview"), message = $("#deletionMessage");
  const phrase = $("#deletionPhrase"), execute = $("#executeDeletion");
  let previewKey = "";
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const selected = () => [...form.querySelectorAll('input[name="deleteGroup"]:checked')].map((x) => x.value).sort();
  const phraseFor = (groups) => groups.includes("everything") ? "DELETE EVERYTHING" : "DELETE SELECTED DATA";
  const selectionKey = () => JSON.stringify(selected());
  function refreshButton() {
    const groups = selected();
    execute.disabled = !groups.length || !previewKey || previewKey !== selectionKey() || phrase.value.trim() !== phraseFor(groups);
    execute.textContent = groups.includes("everything") ? "Delete everything" : "Delete selected data";
    phrase.placeholder = groups.length ? `Type ${phraseFor(groups)}` : "Select data groups first";
  }

  document.addEventListener("DOMContentLoaded", async () => {
    try {
      if (!(await window.IDMCAuth.requireAuth())) return;
      await window.IDMC_RBAC_API.ensureRBACLoaded();
      if (!(await window.IDMC_RBAC_API.hasPermission("system.data.purge"))) {
        document.body.innerHTML = '<main style="max-width:720px;margin:12vh auto;padding:24px;font-family:Arial,sans-serif"><h1>Admin access required</h1><p>Your account is not permitted to use the data deletion portal.</p><a href="dashboard.html">Return to Dashboard</a></main>';
        return;
      }
      $("#deletionSignedIn").textContent = "Administrator signed in";
      form.querySelectorAll('input[name="deleteGroup"]').forEach((input) => input.addEventListener("change", () => {
        if (input.value === "everything" && input.checked) form.querySelectorAll('input[name="deleteGroup"]').forEach((other) => { if (other !== input) other.checked = false; });
        else if (input.checked) { const all = form.querySelector('input[value="everything"]'); if (all) all.checked = false; }
        previewKey = "";
        message.textContent = "Selection changed. Preview again before deletion.";
        refreshButton();
      }));
      phrase.addEventListener("input", refreshButton);

      $("#previewDeletion").addEventListener("click", async () => {
        const groups = selected();
        if (!groups.length) { preview.textContent = "Select at least one group first."; return; }
        previewKey = "";
        refreshButton();
        preview.textContent = "Counting records in the active system database…";
        message.textContent = "";
        try {
          const result = await window.IDMCAPI.post("/admin-data-reset/preview", { categories: groups });
          const tables = result.data?.tables || {};
          const rows = Object.entries(tables).sort(([a], [b]) => a.localeCompare(b));
          const total = rows.reduce((sum, [, count]) => sum + Number(count || 0), 0);
          const isEverything = groups.includes("everything");
          preview.innerHTML = `<strong>${total.toLocaleString()} database record(s) in ${rows.length} table(s) are in the selected groups.</strong><div style="max-height:300px;overflow:auto"><table><thead><tr><th>Table</th><th>Records</th></tr></thead><tbody>${rows.map(([name, count]) => `<tr><td>${escapeHtml(name)}</td><td>${Number(count).toLocaleString()}</td></tr>`).join("")}</tbody></table></div><p>${isEverything ? "All operational public database tables and non-admin Auth users will be cleared." : "Only the selected groups will be cleared; linked records outside those groups may prevent deletion safely."} The submitting admin, other ADMIN/SUPER_ADMIN accounts and institutional configuration are retained. Student IDMC/2026/00001 is deleted when Students or Delete everything is selected. Storage files are not included.</p>`;
          previewKey = selectionKey();
          refreshButton();
        } catch (error) {
          preview.textContent = error.message || "Could not preview the selected data.";
        }
      });

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        refreshButton();
        if (execute.disabled) return;
        const groups = selected();
        const everything = groups.includes("everything");
        const confirmText = everything
          ? "Delete all operational system data, all non-admin user accounts and student IDMC/2026/00001? Admin accounts and institutional configuration will remain. This cannot be undone."
          : "Delete all records in the selected groups? This cannot be undone from the application.";
        if (!window.confirm(confirmText)) return;
        execute.disabled = true;
        message.className = "status";
        message.textContent = "Deleting records. Keep this page open…";
        try {
          const result = await window.IDMCAPI.post(
            "/admin-data-reset/execute",
            { categories: groups, confirmation: phrase.value.trim() },
            { timeoutMs: 90000 },
          );
          const data = result.data || {};
          const failedAuth = Array.isArray(data.authDeletionFailures) ? data.authDeletionFailures : [];
          preview.innerHTML = `<strong>${Number(data.totalDeleted || 0).toLocaleString()} database record(s) deleted.</strong><pre style="white-space:pre-wrap;max-height:220px;overflow:auto">${escapeHtml(JSON.stringify(data.deletedRows || {}, null, 2))}</pre><p>Non-admin Auth accounts deleted: ${Number(data.authAccountsDeleted || 0).toLocaleString()}. Admin accounts and institutional configuration were retained. IDMC/2026/00001 was deleted if its student records were selected.${failedAuth.length ? `<br><strong>Auth account cleanup incomplete:</strong><br>${failedAuth.map(escapeHtml).join("<br>")}` : ""}</p>`;
          message.className = failedAuth.length ? "status error" : "status success";
          message.textContent = result.message || "Selected data deletion completed.";
          if (!failedAuth.length) {
            form.querySelectorAll('input[name="deleteGroup"]').forEach((x) => { x.checked = false; });
            phrase.value = "";
          }
          previewKey = "";
        } catch (error) {
          message.className = "status error";
          const detail = error.message || "Deletion failed. The database transaction was rolled back.";
          message.textContent = error.requestId
            ? `${detail} Support reference: ${error.requestId}. No records were deleted.`
            : `${detail} No records were deleted.`;
          previewKey = "";
        } finally { refreshButton(); }
      });
    } catch (error) {
      message.className = "status error";
      message.textContent = error.message || "Unable to verify admin access.";
    }
  });
})();
