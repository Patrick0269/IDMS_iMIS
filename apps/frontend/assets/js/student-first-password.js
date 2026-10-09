(async function () {
  const message = document.getElementById("message"), button = document.getElementById("save");
  document.getElementById("logout").onclick = () => IDMCAuth.logout();
  try { const profile = await IDMCAuth.requireAuth(); if (!profile) return; if (!profile.mustChangePassword) { IDMCAuth.redirectAfterLogin(); return; } }
  catch (e) { message.textContent = e.message; button.disabled = true; }
  document.getElementById("form").onsubmit = async function (event) {
    event.preventDefault(); const currentPassword = document.getElementById("current").value, newPassword = document.getElementById("next").value;
    if (newPassword !== document.getElementById("confirm").value) { message.textContent = "Password mpya hazifanani."; return; }
    if (newPassword === currentPassword || newPassword.length < 10 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/\d/.test(newPassword)) { message.textContent = "Tumia password tofauti yenye characters 10, herufi kubwa, ndogo na namba."; return; }
    button.disabled = true;
    try { await IDMCAPI.post("/auth/change-password", { currentPassword, newPassword }); await IDMCAuth.refreshSession(); await IDMCAuth.getCurrentUser(); window.location.replace("student-portal.html"); }
    catch (e) { message.textContent = e.message || "Password haijabadilishwa."; button.disabled = false; }
  };
})();