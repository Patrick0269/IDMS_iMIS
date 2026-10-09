(function () {
  "use strict";
  const esc = value => String(value ?? "—").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const table = (headers, rows) => rows.length
    ? `<div class="portal-table-wrap"><table class="portal-table"><thead><tr>${headers.map(x => `<th>${x}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : '<p>No accommodation records are available for your student account.</p>';
  async function init() {
    if (!await IDMCAuth.requireAuth()) return;
    try {
      const response = await IDMCAPI.get("/students/me/portal"), data = response.data || response;
      const hostels = new Map((data.hostels || []).map(row => [row.id, row]));
      const rooms = new Map((data.hostel_rooms || []).map(row => [row.id, row]));
      const beds = new Map((data.hostel_beds || []).map(row => [row.id, row]));
      const allocations = data.hostel_allocations || [];
      document.getElementById("accommodationAllocations").innerHTML = table(["Academic Year", "Hostel", "Room", "Bed", "Move In", "Move Out", "Status"], allocations.map(row => `<tr><td>${esc(row.academic_year)}</td><td>${esc(hostels.get(row.hostel_id)?.hostel_name)}</td><td>${esc(rooms.get(row.room_id)?.room_number)}</td><td>${esc(beds.get(row.bed_id)?.bed_number)}</td><td>${esc(row.move_in_date)}</td><td>${esc(row.move_out_date)}</td><td>${esc(row.allocation_status)}</td></tr>`));
      const fees = data.hostel_fees || [];
      document.getElementById("accommodationFees").innerHTML = table(["Academic Year", "Fee", "Amount", "Currency", "Status"], fees.map(row => `<tr><td>${esc(row.academic_year)}</td><td>${esc(row.fee_name)}</td><td>${esc(Number(row.amount || 0).toLocaleString("en-GB"))}</td><td>${esc(row.currency || "TZS")}</td><td>${esc(row.status)}</td></tr>`));
    } catch (error) {
      document.getElementById("accommodationAllocations").textContent = error.message || "Unable to load accommodation information.";
      document.getElementById("accommodationFees").textContent = "Accommodation fees are temporarily unavailable.";
    }
  }
  init();
})();
