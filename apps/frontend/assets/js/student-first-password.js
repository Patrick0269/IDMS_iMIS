(function () {
  "use strict";

  const form = document.getElementById("form");
  const message = document.getElementById("message");
  const button = document.getElementById("save");
  const progress = document.getElementById("progress");
  const progressText = document.getElementById("progressText");
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

  document.getElementById("logout").addEventListener("click", function () {
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

  (async function initialize() {
    setProgress(true, "Tunathibitisha akaunti yako…");
    try {
      const profile = await IDMCAuth.requireAuth();
      if (!profile) return;
      if (!profile.mustChangePassword) {
        IDMCAuth.redirectAfterLogin();
        return;
      }
      ready = true;
      setProgress(false);
    } catch (error) {
      setProgress(false);
      button.disabled = true;
      showMessage(error.message || "Imeshindikana kuthibitisha akaunti. Ingia tena ujaribu.", "error");
    }
  })();
})();
