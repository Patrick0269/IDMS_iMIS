(function () {
  const message = document.getElementById("applicantMessage");
  const showMessage = (text, kind = "") => {
    message.textContent = text;
    message.className = `message ${kind}`.trim();
    message.hidden = false;
  };
  const apiBase = String(window.IDMC_CONFIG?.API_BASE_URL || "/api/v1").replace(/\/+$/, "");

  const params = new URLSearchParams(window.location.search);
  if (params.has("verified") || window.location.hash.includes("type=signup")) {
    showMessage("Your email confirmation link has been opened. You can now sign in to your applicant account.", "success");
  }

  document.getElementById("applicantLoginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.getElementById("applicantLoginButton");
    button.disabled = true;
    showMessage("Signing in…");
    try {
      const data = new FormData(form);
      await window.IDMCAuth.supabaseLogin(data.get("email"), data.get("password"));
      const profile = await window.IDMCAuth.getCurrentUser();
      const roles = profile?.roles || profile?.user?.roles || [];
      const applicantRole = roles.find((role) => String(role.roleCode || role.role_code || role.code || "").toUpperCase() === "APPLICANT");
      if (!applicantRole) {
        window.IDMCAuth.clearSession();
        throw new Error("This account is not an applicant account. Please use Staff / Student Login.");
      }
      window.IDMCAuth.setActiveRole(applicantRole.id || applicantRole.roleId || applicantRole.role_id);
      window.location.replace("/applicant-portal.html");
    } catch (error) {
      showMessage(error.message || "Unable to sign in. Check your email and password.", "error");
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("applicantRegisterForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.getElementById("applicantRegisterButton");
    const values = Object.fromEntries(new FormData(form).entries());
    if (values.password !== values.confirmPassword) {
      showMessage("The passwords do not match.", "error");
      return;
    }
    button.disabled = true;
    showMessage("Creating your account…");
    try {
      const response = await fetch(`${apiBase}/auth/applicant-register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.success === false) throw new Error(payload.message || payload.error || "Unable to create applicant account.");
      form.reset();
      if (payload.data?.verificationEmailSent === false) {
        const resendForm = document.getElementById("applicantResendForm");
        resendForm.elements.email.value = values.email;
        resendForm.hidden = false;
        showMessage(payload.message, "error");
      } else {
        showMessage(payload.message || "Account created. Check your email and confirm your address before signing in.", "success");
      }
    } catch (error) {
      const resendForm = document.getElementById("applicantResendForm");
      resendForm.elements.email.value = values.email;
      resendForm.hidden = false;
      showMessage(error.message || "Unable to create applicant account.", "error");
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById("applicantResendForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.getElementById("applicantResendButton");
    button.disabled = true;
    try {
      const response = await fetch(apiBase + "/auth/applicant-verification-resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.elements.email.value })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.success === false) throw new Error(payload.message || "Unable to request a verification email.");
      showMessage(payload.message || "If this address has an unverified applicant account, a new verification email will be sent.", "success");
    } catch (error) {
      showMessage(error.message || "Unable to request a verification email.", "error");
    } finally {
      button.disabled = false;
    }
  });})();
