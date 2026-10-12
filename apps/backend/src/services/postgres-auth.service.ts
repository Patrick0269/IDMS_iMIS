import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { getSupabase } from "../config/database.js";
import { env } from "../config/env.js";

export interface LocalAuthUser {
  id: string;
  email: string;
  encrypted_password: string;
  email_confirmed_at: string | null;
  raw_app_meta_data: Record<string, unknown>;
  raw_user_meta_data: Record<string, unknown>;
  banned_until: string | null;
  deleted_at: string | null;
}

const TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

function requiredSecret(): string {
  if (env.AUTH_PROVIDER !== "postgres" || !env.LOCAL_AUTH_JWT_SECRET) {
    throw new Error("PostgreSQL Auth is not enabled or LOCAL_AUTH_JWT_SECRET is missing.");
  }
  return env.LOCAL_AUTH_JWT_SECRET;
}

function expiresInSeconds(): number {
  const match = env.JWT_EXPIRES_IN.match(/^\s*(\d+)\s*([smhd])?\s*$/i);
  if (!match) return TOKEN_TTL_SECONDS;
  const amount = Number(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  const factor = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  return Math.min(Math.max(amount * factor, 60), 24 * 60 * 60);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabase().rpc(name, args);
  if (error) throw error;
  return data as T;
}

export async function getLocalAuthUserById(id: string): Promise<LocalAuthUser | null> {
  return (await rpc<LocalAuthUser | null>("idmc_local_auth_user_by_id", { p_user_id: id })) ?? null;
}

export async function getLocalAuthUserByEmail(email: string): Promise<LocalAuthUser | null> {
  return (await rpc<LocalAuthUser | null>("idmc_local_auth_user_by_email", { p_email: email.trim().toLowerCase() })) ?? null;
}

export async function createLocalAuthUser(input: {
  id: string; email: string; password: string; emailConfirmed?: boolean | undefined;
  userMetadata?: Record<string, unknown> | undefined; appMetadata?: Record<string, unknown> | undefined;
}): Promise<LocalAuthUser> {
  const passwordHash = await bcrypt.hash(input.password, 12);
  return rpc<LocalAuthUser>("idmc_local_auth_create_user", {
    p_user_id: input.id,
    p_email: input.email.trim().toLowerCase(),
    p_password_hash: passwordHash,
    p_email_confirmed: input.emailConfirmed ?? false,
    p_user_meta: input.userMetadata ?? {},
    p_app_meta: input.appMetadata ?? {},
  });
}

export async function updateLocalAuthCredentials(input: {
  id: string; password?: string; appMetadata?: Record<string, unknown>; emailConfirmed?: boolean;
}): Promise<LocalAuthUser | null> {
  return rpc<LocalAuthUser | null>("idmc_local_auth_update_credentials", {
    p_user_id: input.id,
    p_password_hash: input.password ? await bcrypt.hash(input.password, 12) : null,
    p_app_meta: input.appMetadata ?? null,
    p_email_confirmed: input.emailConfirmed ?? null,
  });
}

export async function updateLocalAuthUser(input: {
  id: string; email?: string | undefined; password?: string | undefined; appMetadata?: Record<string, unknown> | undefined;
  userMetadata?: Record<string, unknown> | undefined; emailConfirmed?: boolean | undefined;
}): Promise<LocalAuthUser | null> {
  return rpc<LocalAuthUser | null>("idmc_local_auth_update_profile", {
    p_user_id: input.id,
    p_email: input.email?.trim().toLowerCase() ?? null,
    p_password_hash: input.password ? await bcrypt.hash(input.password, 12) : null,
    p_app_meta: input.appMetadata ?? null,
    p_user_meta: input.userMetadata ?? null,
    p_email_confirmed: input.emailConfirmed ?? null,
  });
}

export async function deleteLocalAuthUser(id: string): Promise<boolean> {
  return rpc<boolean>("idmc_local_auth_delete_user", { p_user_id: id });
}

export async function issueLocalAuthAction(userId: string, action: "signup" | "magiclink" | "recovery"): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + (action === "recovery" ? 60 : 60 * 24) * 60 * 60 * 1000);
  const stored = await rpc<boolean>("idmc_local_auth_issue_action", {
    p_user_id: userId, p_token_hash: tokenHash(token), p_action_type: action, p_expires_at: expiresAt.toISOString(),
  });
  if (!stored) throw new Error("Could not issue the account action link.");
  return token;
}

export async function consumeLocalAuthAction(token: string, action: "signup" | "magiclink" | "recovery"): Promise<LocalAuthUser | null> {
  if (!token || token.length > 256) return null;
  return rpc<LocalAuthUser | null>("idmc_local_auth_consume_action", { p_token_hash: tokenHash(token), p_action_type: action });
}

export async function completeLocalPasswordRecovery(token: string, password: string): Promise<boolean> {
  if (password.length < 10 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
    throw Object.assign(new Error("Password must have at least 10 characters, upper-case, lower-case and a number."), { statusCode: 400 });
  }
  const user = await consumeLocalAuthAction(token, "recovery");
  if (!user) return false;
  const updated = await updateLocalAuthCredentials({ id: user.id, password });
  if (!updated) return false;
  const db = getSupabase();
  const changedAt = new Date().toISOString();
  const profile = await db.from("users").update({ password_changed_at: changedAt, updated_at: changedAt })
    .eq("auth_user_id", user.id).select("id").maybeSingle();
  if (profile.error) console.warn("Password reset succeeded but the profile timestamp could not be updated.");
  else if (profile.data?.id) {
    const audit = await db.from("security_logs").insert({ user_id: profile.data.id, event_code: "PASSWORD_RESET", success: true, details: { source: "email-recovery" } });
    if (audit.error) console.warn("Password reset succeeded but its security log could not be recorded.");
  }
  return true;
}

function issueAccessToken(user: LocalAuthUser, expiresIn = expiresInSeconds()): string {
  return jwt.sign({
    role: "authenticated",
    email: user.email,
    app_metadata: user.raw_app_meta_data ?? {},
    user_metadata: user.raw_user_meta_data ?? {},
    aal: "aal1",
    is_anonymous: false,
  }, requiredSecret(), {
    algorithm: "HS256",
    subject: user.id,
    audience: "authenticated",
    issuer: "idmc-imis",
    expiresIn,
  });
}

async function createSession(user: LocalAuthUser) {
  const refreshToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
  const stored = await rpc<boolean>("idmc_local_auth_issue_refresh", {
    p_user_id: user.id,
    p_token_hash: tokenHash(refreshToken),
    p_expires_at: expiresAt.toISOString(),
  });
  if (!stored) throw new Error("Could not issue a PostgreSQL Auth session.");
  const accessToken = issueAccessToken(user);
  const expiresIn = expiresInSeconds();
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: expiresIn,
    expires_at: nowSeconds + expiresIn,
  };
}

export async function createLocalAuthSession(user: LocalAuthUser) {
  return createSession(user);
}

export async function signInLocalAuth(email: string, password: string) {
  const user = await getLocalAuthUserByEmail(email);
  if (!user || user.deleted_at || !user.encrypted_password || !await bcrypt.compare(password, user.encrypted_password)) {
    throw new Error("Invalid login credentials");
  }
  if (user.banned_until && new Date(user.banned_until).getTime() > Date.now()) throw new Error("Invalid login credentials");
  if (!user.email_confirmed_at) throw new Error("Invalid login credentials");
  const touched = await rpc<boolean>("idmc_local_auth_touch_login", { p_user_id: user.id });
  if (!touched) throw new Error("Invalid login credentials");
  return createSession(user);
}

export async function refreshLocalAuthSession(refreshToken: string) {
  if (!refreshToken || refreshToken.length > 256) throw new Error("Invalid refresh token");
  const id = await rpc<string | null>("idmc_local_auth_consume_refresh", { p_token_hash: tokenHash(refreshToken) });
  if (!id) throw new Error("Invalid or expired refresh token");
  const user = await getLocalAuthUserById(id);
  if (!user || user.deleted_at || (user.banned_until && new Date(user.banned_until).getTime() > Date.now())) {
    throw new Error("Invalid or expired refresh token");
  }
  return createSession(user);
}

export async function revokeLocalAuthSession(refreshToken: string): Promise<void> {
  if (refreshToken && refreshToken.length <= 256) {
    await rpc<boolean>("idmc_local_auth_revoke_refresh", { p_token_hash: tokenHash(refreshToken) });
  }
}

export async function verifyLocalAccessToken(token: string): Promise<{ id: string; email: string; emailVerified: boolean } | null> {
  try {
    const decoded = jwt.verify(token, requiredSecret(), {
      algorithms: ["HS256"], issuer: "idmc-imis", audience: "authenticated",
    }) as JwtPayload;
    if (!decoded.sub) return null;
    const user = await getLocalAuthUserById(decoded.sub);
    if (!user || user.deleted_at || (user.banned_until && new Date(user.banned_until).getTime() > Date.now())) return null;
    return { id: user.id, email: user.email, emailVerified: Boolean(user.email_confirmed_at) };
  } catch {
    return null;
  }
}

function asSupabaseUser(user: LocalAuthUser | null): Record<string, unknown> | null {
  if (!user) return null;
  return {
    id: user.id, aud: "authenticated", role: "authenticated", email: user.email,
    email_confirmed_at: user.email_confirmed_at, confirmed_at: user.email_confirmed_at,
    app_metadata: user.raw_app_meta_data ?? {}, user_metadata: user.raw_user_meta_data ?? {},
    created_at: null, updated_at: null, last_sign_in_at: null, phone: "", identities: [],
  };
}

/** Narrow compatibility surface for existing services while their Auth calls are moved to PostgreSQL. */
export function createLocalAuthCompatibility() {
  const admin = {
    async getUserById(id: string) {
      try { return { data: { user: asSupabaseUser(await getLocalAuthUserById(id)) }, error: null }; }
      catch (error) { return { data: { user: null }, error }; }
    },
    async createUser(input: { email: string; password?: string; email_confirm?: boolean; user_metadata?: Record<string, unknown>; app_metadata?: Record<string, unknown> }) {
      try {
        const user = await createLocalAuthUser({ id: randomUUID(), email: input.email, password: input.password ?? "", emailConfirmed: input.email_confirm, userMetadata: input.user_metadata, appMetadata: input.app_metadata });
        return { data: { user: asSupabaseUser(user) }, error: null };
      } catch (error) { return { data: { user: null }, error }; }
    },
    async updateUserById(id: string, input: { email?: string; password?: string; email_confirm?: boolean; app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> }) {
      try {
        const user = await updateLocalAuthUser({ id, email: input.email, password: input.password, emailConfirmed: input.email_confirm, appMetadata: input.app_metadata, userMetadata: input.user_metadata });
        return { data: { user: asSupabaseUser(user) }, error: null };
      } catch (error) { return { data: { user: null }, error }; }
    },
    async deleteUser(id: string) {
      try { return { data: { user: { id } }, error: await deleteLocalAuthUser(id) ? null : new Error("Auth user not found") }; }
      catch (error) { return { data: { user: null }, error }; }
    },
    async listUsers(options: { page?: number; perPage?: number } = {}) {
      try {
        const page = Math.max(1, Number(options.page) || 1);
        const perPage = Math.min(1000, Math.max(1, Number(options.perPage) || 1000));
        const users = await rpc<LocalAuthUser[]>("idmc_local_auth_list_users", { p_page: page, p_per_page: perPage });
        return { data: { users: users.map(user => asSupabaseUser(user)), nextPage: users.length === perPage ? page + 1 : null, lastPage: users.length === perPage ? page + 1 : page, total: null }, error: null };
      } catch (error) { return { data: { users: [] }, error }; }
    },
    async generateLink(input: { type: "signup" | "magiclink" | "recovery"; email: string; password?: string; options?: { data?: Record<string, unknown>; redirectTo?: string } }) {
      try {
        let user = await getLocalAuthUserByEmail(input.email);
        if (!user && input.type === "signup" && input.password) {
        user = await createLocalAuthUser({ id: randomUUID(), email: input.email, password: input.password, emailConfirmed: false, userMetadata: input.options?.data });
        }
        if (!user) throw new Error("Auth user not found");
        const token = await issueLocalAuthAction(user.id, input.type);
        const defaultPage = input.type === "recovery" ? "set-password.html" : "applicant-access.html";
        const actionUrl = new URL(input.options?.redirectTo || `${env.FRONTEND_URL.replace(/\/$/, "")}/${defaultPage}`);
        actionUrl.searchParams.set("token_hash", token);
        actionUrl.searchParams.set("type", input.type);
        return { data: { user: asSupabaseUser(user), properties: { hashed_token: token, action_link: actionUrl.toString(), verification_type: input.type } }, error: null };
      } catch (error) { return { data: { user: null, properties: null }, error }; }
    },
  };
  const auth = {
    admin,
    async getUser(token: string) {
      const identity = await verifyLocalAccessToken(token);
      return { data: { user: identity ? asSupabaseUser(await getLocalAuthUserById(identity.id)) : null }, error: identity ? null : new Error("Invalid access token") };
    },
    async signInWithPassword(input: { email: string; password: string }) {
      try {
        const session = await signInLocalAuth(input.email, input.password);
        const identity = await getLocalAuthUserByEmail(input.email);
        return { data: { user: asSupabaseUser(identity), session }, error: null };
      } catch (error) { return { data: { user: null, session: null }, error }; }
    },
    async verifyOtp(input: { token_hash: string; type: "signup" | "magiclink" }) {
      try {
        const identity = await consumeLocalAuthAction(input.token_hash, input.type);
        if (!identity) throw new Error("Verification link invalid or expired");
        return { data: { user: asSupabaseUser(identity), session: await createSession(identity) }, error: null };
      } catch (error) { return { data: { user: null, session: null }, error }; }
    },
    async refreshSession(input: { refresh_token: string }) {
      try { return { data: { session: await refreshLocalAuthSession(input.refresh_token) }, error: null }; }
      catch (error) { return { data: { session: null }, error }; }
    },
    async resend(input: { type: "signup"; email: string; options?: { emailRedirectTo?: string } }) {
      try {
        const user = await getLocalAuthUserByEmail(input.email);
        if (!user) throw new Error("Auth user not found");
        await issueLocalAuthAction(user.id, "signup");
        return { data: {}, error: null };
      } catch (error) { return { data: {}, error }; }
    },
    async resetPasswordForEmail(email: string) {
      try {
        const user = await getLocalAuthUserByEmail(email);
        if (!user) throw new Error("Auth user not found");
        await issueLocalAuthAction(user.id, "recovery");
        return { data: {}, error: null };
      } catch (error) { return { data: {}, error }; }
    },
    async setSession() { return { data: { session: null, user: null }, error: new Error("Use IDMC session endpoints") }; },
    async signOut() { return { error: null }; },
  };
  return auth;
}
