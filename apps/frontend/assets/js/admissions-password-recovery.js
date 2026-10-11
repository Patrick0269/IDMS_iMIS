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
    button.textContent = "Inathibitisha taarifa…";
    try {
      var result = await IDMCAPI.post("/admissions/students/password-reset", payload);
      message.textContent = result.message || "Ombi la kutuma link limepokelewa.";
      message.className = "success-text";
      form.reset();
    } catch (error) {
      message.textContent = error.message || "Imeshindikana kutuma link. Hakiki taarifa au jaribu tena baadaye.";
      message.className = "error-text";
    } finally {
      button.disabled = false;
      button.textContent = "Tuma link ya kubadilisha password";
    }
  });
})();
