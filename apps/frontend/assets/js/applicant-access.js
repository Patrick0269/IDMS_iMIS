(function () {
  const message = document.getElementById("applicantMessage");
  const showMessage = (text, kind = "") => {
    message.textContent = text;
    message.className = `message ${kind}`.trim();
    message.hidden = false;
  };
  const apiBase = String(window.IDMC_CONFIG?.API_BASE_URL || "/api/v1").replace(/\/+$/, "");

  const params = new URLSearchParams(window.location.search);
  async function completeEmailConfirmation() {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const accessToken = hash.get("access_token");
    const confirmationType = hash.get("type");
    const authError = hash.get("error_description") || hash.get("error");
    if (authError) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
      showMessage(authError.replace(/\+/g, " "), "error");
      return;
    }
    if (!accessToken || (confirmationType && confirmationType !== "signup")) {
      if (params.has("verified")) showMessage("Your email confirmation link has been opened. Sign in to continue.", "success");
      return;
    }

    const session = {
      access_token: accessToken,
      refresh_token: hash.get("refresh_token") || null,
      token_type: hash.get("token_type") || "bearer",
      expires_in: Number(hash.get("expires_in")) || null,
      expires_at: Number(hash.get("expires_at")) || null
    };
    history.replaceState(null, "", window.location.pathname + window.location.search);
    try {
      window.IDMCAuth.saveSession(session);
      showMessage("Email verified. Opening your applicant account…", "success");
      const profile = await window.IDMCAuth.getCurrentUser();
      const roles = profile?.roles || profile?.user?.roles || [];
      const applicantRole = roles.find(role => String(role.roleCode || role.role_code || role.code || "").toUpperCase() === "APPLICANT");
      if (!applicantRole) throw new Error("Email verified, but an applicant portal role was not found. Contact Admissions.");
      window.IDMCAuth.setActiveRole(applicantRole.id || applicantRole.roleId || applicantRole.role_id);
      window.location.replace("/applicant-portal.html");
    } catch (error) {
      window.IDMCAuth.clearSession();
      showMessage(error.message || "Your email was verified, but we could not open your account. Please sign in.", "error");
    }
  }
  void completeEmailConfirmation();

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
        showMessage(payload.message || "Account created. Open the verification link sent to your email; it will sign you in automatically.", "success");
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
