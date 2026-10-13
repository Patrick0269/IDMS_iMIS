(function () {
  const message = document.getElementById("applicantMessage");
  const showMessage = (text, kind = "") => {
    message.textContent = text;
    message.className = `message ${kind}`.trim();
    message.hidden = false;
  };
  const apiBase = String(window.IDMC_CONFIG?.API_BASE_URL || "/api/v1").replace(/\/+$/, "");
  const dateOfBirthInput = document.getElementById("applicantDateOfBirth");
  if (dateOfBirthInput) {
    const today = new Date();
    dateOfBirthInput.max = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  }
  const requestError = (response, payload, fallback) => {
    const error = new Error(payload?.message || payload?.error || fallback);
    error.status = response.status;
    error.requestId = response.headers?.get("x-request-id") || payload?.requestId || null;
    return error;
  };
  const userError = (error, fallback) => window.IDMCAuth?.toUserMessage?.(error) || error?.message || fallback;

  const params = new URLSearchParams(window.location.search);
  const googleErrorMessages = {
    cancelled: "Google sign-in was cancelled. You can try again or sign in with email and password.",
    account_exists: "An IDMS account already uses this email. Sign in to that account or contact Admissions to link it safely.",
    unavailable: "Google sign-in is not configured yet. Contact Admissions or ICT, or use email and password.",
    invalid: "The Google sign-in response could not be verified. Please try again.",
    failed: "Google sign-in could not be completed. Please try again or use email and password."
  };
  const googleError = params.get("google_error");
  if (googleError) {
    history.replaceState(null, "", window.location.pathname);
    showMessage(googleErrorMessages[googleError] || googleErrorMessages.failed, "error");
  }
  async function completeEmailConfirmation() {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const accessToken = hash.get("access_token");
    const confirmationType = hash.get("type");
    const authError = hash.get("error_description") || hash.get("error");
    if (authError) {
      history.replaceState(null, "", window.location.pathname);
      showMessage(authError.replace(/\+/g, " "), "error");
      return;
    }
    const tokenHash = params.get("token_hash");
    if (tokenHash) {
      const tokenType = params.get("type") || "signup";
      history.replaceState(null, "", window.location.pathname);
      if (!["signup", "magiclink"].includes(tokenType)) {
        showMessage("This verification link is invalid. Request a new verification email.", "error");
        return;
      }
      showMessage("Verifying your email address…");
      try {
        const response = await fetch(`${apiBase}/auth/applicant-verification-confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(tokenType === "signup" ? { token_hash: tokenHash } : { token_hash: tokenHash, type: tokenType })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.success === false || !payload.data?.access_token) {
          throw requestError(response, payload, "This verification link is invalid or has expired. Request a new one.");
        }
        await openApplicantSession(payload.data);
      } catch (error) {
        showMessage(userError(error, "Unable to verify your email address. Request a new link."), "error");
      }
      return;
    }
    if (!accessToken || (confirmationType && !["signup", "magiclink", "google"].includes(confirmationType))) {
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
    history.replaceState(null, "", window.location.pathname);
    await openApplicantSession(session, confirmationType === "google" && hash.get("new_applicant") === "1");
  }

  async function openApplicantSession(session, isNewApplicant = false) {
    try {
      window.IDMCAuth.saveSession(session);
      showMessage(isNewApplicant ? "Google verified your email. Opening your new applicant profile…" : "Opening your applicant account…", "success");
      const profile = await window.IDMCAuth.getCurrentUser();
      const roles = profile?.roles || profile?.user?.roles || [];
      const applicantRole = roles.find(role => String(role.roleCode || role.role_code || role.code || "").toUpperCase() === "APPLICANT");
      if (!applicantRole) throw new Error("Email verified, but an applicant portal role was not found. Contact Admissions.");
      window.IDMCAuth.setActiveRole(applicantRole.id || applicantRole.roleId || applicantRole.role_id);
      window.location.replace("/applicant-portal.html");
    } catch (error) {
      window.IDMCAuth.clearSession();
      showMessage(userError(error, "Your email was verified, but we could not open your account. Please sign in."), "error");
    }
  }
  void completeEmailConfirmation();

  ["applicantGoogleLogin", "applicantGoogleRegister"].forEach((id) => {
    const button = document.getElementById(id);
    button?.addEventListener("click", () => { window.location.assign(`${apiBase}/auth/google/applicant/start`); });
  });

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
      showMessage(userError(error, "Unable to sign in. Check your email and password."), "error");
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
      if (!response.ok || payload.success === false) throw requestError(response, payload, "Unable to create applicant account.");
      form.reset();
      form.hidden = true;
      document.getElementById("registerHeading").textContent = "Registration received";
      document.getElementById("applicantLoginForm").elements.email.value = values.email;
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
      showMessage(userError(error, "Unable to create applicant account."), "error");
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById("applicantRecoveryForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget, button = document.getElementById("applicantRecoveryButton");
    button.disabled = true;
    try {
      const response = await fetch(`${apiBase}/auth/password-reset`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountType: "applicant", email: form.elements.email.value })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.success === false) throw requestError(response, payload, "Unable to request a password reset.");
      showMessage(payload.message || "If the address matches an active applicant account, a secure reset link will be sent. Check Inbox and Spam/Junk.", "success");
    } catch (error) {
      showMessage(userError(error, "Unable to request a password reset. Please try again later."), "error");
    } finally { button.disabled = false; }
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
      if (!response.ok || payload.success === false) throw requestError(response, payload, "Unable to request a verification email.");
      showMessage(payload.message || "If this address has an unverified applicant account, a new verification email will be sent.", "success");
    } catch (error) {
      showMessage(userError(error, "Unable to request a verification email."), "error");
    } finally {
      button.disabled = false;
    }
  });})();
