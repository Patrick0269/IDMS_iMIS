(function () {
  "use strict";
  var form = document.getElementById("admissionsRecoveryForm");
  if (!form || !window.IDMCAPI) return;
  var button = document.getElementById("sendStudentResetLink");
  var message = document.getElementById("admissionsRecoveryMessage");
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    message.textContent = "";
    if (!form.reportValidity()) return;
    var payload = {
      registrationNumber: String(form.elements.registrationNumber.value || "").trim(),
      birthYear: Number(form.elements.birthYear.value)
    };
    button.disabled = true;
    button.textContent = "Verifying student details…";
    try {
      var result = await IDMCAPI.post("/admissions/students/password-reset", payload);
      message.textContent = result.message || "The request to send a reset link has been received.";
      message.className = "success-text";
      form.reset();
    } catch (error) {
      message.textContent = error.message || "We could not send the link. Check the details or try again later.";
      message.className = "error-text";
    } finally {
      button.disabled = false;
      button.textContent = "Send password reset link";
    }
  });
})();
