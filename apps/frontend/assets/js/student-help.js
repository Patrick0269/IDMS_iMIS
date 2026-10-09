(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const date = value => value ? new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Dar_es_Salaam", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
  const message = (value, error = false) => { const box = $("helpMessage"); box.hidden = !value; box.textContent = value || ""; box.className = `portal-state${error ? " portal-error" : ""}`; };
  async function load() {
    const response = await IDMCAPI.get("/students/me/portal"), data = response.data || response;
    const categories = data.helpdesk_categories || [];
    $("helpCategory").innerHTML = '<option value="">General support</option>' + categories.map(item => `<option value="${esc(item.id)}">${esc(item.category_name)}</option>`).join("");
    const tickets = data.helpdesk_tickets || [];
    $("helpHistory").innerHTML = tickets.length
      ? `<div class="portal-table-wrap"><table class="portal-table"><thead><tr><th>Ticket</th><th>Opened</th><th>Subject</th><th>Priority</th><th>Status</th><th>Response</th></tr></thead><tbody>${tickets.map(row => `<tr><td>${esc(row.ticket_number || "—")}</td><td>${esc(date(row.created_at))}</td><td>${esc(row.subject || "—")}</td><td>${esc(row.priority || "—")}</td><td>${esc(row.status || "—")}</td><td>${esc(row.resolution_summary || "—")}</td></tr>`).join("")}</tbody></table></div>`
      : "You have not submitted a helpdesk ticket yet.";
  }
  $("helpForm").addEventListener("submit", async event => {
    event.preventDefault(); const form = event.currentTarget, button = form.querySelector("button"); button.disabled = true; message("Submitting your ticket…");
    try { await IDMCAPI.post("/students/me/helpdesk", Object.fromEntries(new FormData(form).entries())); form.reset(); message("Your helpdesk ticket has been submitted."); await load(); }
    catch (error) { message(error.message || "Unable to submit this helpdesk ticket.", true); }
    finally { button.disabled = false; }
  });
  async function init() { if (!await IDMCAuth.requireAuth()) return; try { await load(); } catch (error) { $("helpHistory").textContent = error.message || "Unable to load support history."; } }
  init();
})();
