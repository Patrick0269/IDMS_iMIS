(function () {
  "use strict";

  const form = document.getElementById("form");
  const message = document.getElementById("message");
  const button = document.getElementById("save");
  const progress = document.getElementById("progress");
  const progressText = document.getElementById("progressText");
  const logout = document.getElementById("logout");
  const retry = document.getElementById("retryValidation");
  let ready = false;
  let submitting = false;

  function setProgress(visible, text) {
    progress.hidden = !visible;
    if (text) progressText.textContent = text;
    button.disabled = visible;
  }

  function showMessage(text, kind) {
    message.textContent = text || "";
    message.className = kind || "";
  }

  logout.addEventListener("click", function () {
    IDMCAuth.logout();
  });

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (!ready || submitting) return;

    const currentPassword = document.getElementById("current").value;
    const newPassword = document.getElementById("next").value;
    const confirmedPassword = document.getElementById("confirm").value;

    if (!form.reportValidity()) return;
    if (newPassword !== confirmedPassword) {
      showMessage("Password mpya hazifanani.", "error");
      return;
    }
    if (newPassword === currentPassword || newPassword.length < 10 ||
        !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      showMessage("Tumia password tofauti yenye angalau herufi 10, herufi kubwa, ndogo na namba.", "error");
      return;
    }

    submitting = true;
    showMessage("");
    setProgress(true, "Tunabadilisha password yako…");
    try {
      await IDMCAPI.post("/auth/change-password", { currentPassword, newPassword });
      await IDMCAuth.refreshSession();
      await IDMCAuth.getCurrentUser();
      progressText.textContent = "Password imebadilishwa. Tunafungua Student Portal…";
      window.location.replace("student-portal.html");
    } catch (error) {
      submitting = false;
      setProgress(false);
      showMessage(error.message || "Password haijabadilishwa. Tafadhali jaribu tena.", "error");
    }
  });

  async function initialize() {
    retry.hidden = true;
    retry.disabled = true;
    setProgress(true, "Tunathibitisha akaunti yako…");
    try {
      // A successful login has just created this session. Validate it once on
      // this page; requireAuth() silently refreshes and retries, which hides a
      // persistent backend/session error behind an endless-looking spinner.
      const profile = await IDMCAuth.getCurrentUser();
      if (!profile.mustChangePassword) {
        IDMCAuth.redirectAfterLogin();
        return;
      }
      ready = true;
      setProgress(false);
      showMessage("");
    } catch (error) {
      setProgress(false);
      button.disabled = true;
      logout.textContent = "Rudi kwenye login";
      showMessage((error.message || "Imeshindikana kuthibitisha akaunti.") + " Ingia tena kwa namba yako ya usajili na password ya muda, kisha ujaribu tena.", "error");
      retry.hidden = false;
    } finally {
      retry.disabled = false;
    }
  }

  retry.addEventListener("click", initialize);
  initialize();
})();
