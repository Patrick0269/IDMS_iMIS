(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const setMessage = (message, error = false) => {
    const box = $("securityMessage");
    box.hidden = !message;
    box.textContent = message;
    box.className = `portal-state${error ? " portal-error" : ""}`;
  };
  async function loadHistory() {
    const response = await IDMCAPI.get("/students/me/portal"), data = response.data || response;
    const rows = data.security_logs || [];
    $("securityHistory").innerHTML = rows.length
      ? `<div class="portal-table-wrap"><table class="portal-table"><thead><tr><th>Date and Time</th><th>Event</th><th>Result</th><th>Device or Browser</th><th>IP Address</th></tr></thead><tbody>${rows.map(row => `<tr><td>${esc(row.created_at ? new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Dar_es_Salaam", dateStyle: "medium", timeStyle: "short" }).format(new Date(row.created_at)) : "—")}</td><td>${esc(row.event_code || "—")}</td><td>${esc(row.success ? "Successful" : "Failed")}</td><td>${esc(row.user_agent || "—")}</td><td>${esc(row.ip_address || "—")}</td></tr>`).join("")}</tbody></table></div>`
      : "No security history is available.";
  }
  async function init() {
    const profile = await IDMCAuth.requireAuth();
    if (!profile) return;
    if (profile.mustChangePassword) {
      $("passwordForm").querySelector('[name="currentPassword"]')?.focus();
      return;
    }
    try { await loadHistory(); } catch (error) { $("securityHistory").textContent = error.message || "Unable to load security history."; }
  }
  $("passwordForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget, fields = Object.fromEntries(new FormData(form).entries());
    if (fields.newPassword !== fields.confirmPassword) { setMessage("Passwords do not match.", true); return; }
    const submit = form.querySelector("button"); submit.disabled = true; setMessage("Changing password…");
    try {
      const firstLoginSetup = IDMCAuth.getUser()?.mustChangePassword === true;
      const endpoint = firstLoginSetup ? "/auth/change-password" : "/students/me/change-password";
      await IDMCAPI.post(endpoint, { currentPassword: fields.currentPassword, newPassword: fields.newPassword });
      form.reset();
      if (firstLoginSetup) {
        const profile = await IDMCAuth.getCurrentUser();
        if (profile.mustChangePassword) throw new Error("Password changed, but account setup is not yet confirmed. Please refresh and check again.");
        setMessage("Password changed. Opening your Student Portal…");
        window.top.location.replace("student-portal.html");
        return;
      }
      setMessage("Password changed successfully.");
    }
    catch (error) { setMessage(error.message || "Password could not be changed.", true); }
    finally { submit.disabled = false; }
  });
  init();
})();
