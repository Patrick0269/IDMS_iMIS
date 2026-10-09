import { createSupabaseAuthClient, getSupabase } from "../config/database.js";

type ErrorWithStatus = Error & { statusCode: number };

function passwordError(message: string, statusCode: number): ErrorWithStatus {
  return Object.assign(new Error(message), { statusCode });
}

export async function changeAuthenticatedPassword(
  authUserId: string,
  currentPassword: string,
  newPassword: string,
  audit: { ipAddress?: string | undefined; userAgent?: string | undefined; source: string },
  createAuthClient: typeof createSupabaseAuthClient = createSupabaseAuthClient,
) {
  if (!currentPassword) throw passwordError("Enter your current password.", 400);
  if (newPassword.length < 10 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    throw passwordError("Password must have at least 10 characters, upper-case, lower-case and a number.", 400);
  }

  if (currentPassword === newPassword) throw passwordError("Choose a different password from your temporary/current password.", 400);
  const supabase = getSupabase();
  const { data: identity, error: identityError } = await supabase.auth.admin.getUserById(authUserId);
  const email = String(identity?.user?.email ?? "").trim().toLowerCase();
  if (identityError || !email) throw passwordError("Authenticated login identity could not be verified.", 401);

  const initialNumber = String(identity?.user?.app_metadata?.idmc_student_initial_number || "");
  if (initialNumber && newPassword.trim().toUpperCase() === initialNumber.toUpperCase()) throw passwordError("Your new password must not be your student number.", 400);

  // Re-authenticate on a disposable Auth client so a failed password change
  // cannot replace the service-role client's Auth context.
  const authClient = createAuthClient();
  const { error: currentPasswordError } = await authClient.auth.signInWithPassword({ email, password: currentPassword });
  if (currentPasswordError) throw passwordError("Current password is incorrect.", 401);

  const { error: updateError } = await supabase.auth.admin.updateUserById(authUserId, {
    password: newPassword,
    app_metadata: { ...identity.user!.app_metadata, idmc_student_first_login: false },
  });
  if (updateError) throw passwordError("Unable to change password. Contact the Registry.", 502);

  const changedAt = new Date().toISOString();
  const { data: profile, error: profileError } = await supabase.from("users")
    .update({ password_changed_at: changedAt, updated_at: changedAt })
    .eq("auth_user_id", authUserId)
    .select("id")
    .maybeSingle();
  if (profileError || !profile) {
    throw passwordError("Password changed, but the IDMC security record could not be updated. Contact the Registry.", 500);
  }

  const { error: auditError } = await supabase.from("security_logs").insert({
    user_id: profile.id,
    event_code: "PASSWORD_CHANGED",
    success: true,
    ip_address: audit.ipAddress || null,
    user_agent: audit.userAgent || null,
    details: { source: audit.source },
  });
  if (auditError) console.warn("Password changed but security history was not recorded.");
  return { changed: true, passwordChangedAt: changedAt };
}
