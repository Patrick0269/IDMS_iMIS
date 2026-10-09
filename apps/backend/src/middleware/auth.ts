import type { NextFunction, Request, Response } from "express";
import { getSupabase } from "../config/database.js";
import { escapeIlikeLiteral, parseBearerToken } from "../utils/security.js";

export interface AuthenticatedUser {
  id: string;
  authUserId: string;
  userNumber: string;
  email: string;
  firstName: string;
  lastName: string;
  status: string;
  activeRoleId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      authUser?: {
        id: string;
        email: string | undefined;
        emailVerified: boolean;
      };
    }
  }
}

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authorization = req.headers.authorization;
    if (!authorization) {
      res.status(401).json({
        success: false,
        message: "Authorization header is required"
      });
      return;
    }

    const token = parseBearerToken(authorization);
    if (!token) {
      res.status(401).json({
        success: false,
        message: "Invalid authorization format"
      });
      return;
    }

    const supabase = getSupabase();

    const {
      data: authData,
      error: authError
    } = await supabase.auth.getUser(token);

    if (authError || !authData.user) {
      res.status(401).json({
        success: false,
        message: "Invalid or expired authentication token"
      });
      return;
    }

    const authUser = authData.user;
    const passwordChangeRequired = authUser.app_metadata?.idmc_student_first_login === true;
    const safePath = req.originalUrl.split("?")[0]?.replace(/\/+$/, "");
    if (passwordChangeRequired && !((req.method === "GET" && /\/auth\/me$/.test(safePath || "")) || (req.method === "POST" && /\/auth\/change-password$/.test(safePath || "")))) {
      res.status(403).json({ success: false, code: "PASSWORD_CHANGE_REQUIRED", message: "Change your temporary student password before continuing." });
      return;
    }

    let {
      data: applicationUser,
      error: userError
    } = await supabase
      .from("users")
      .select(`
        id,
        auth_user_id,
        user_number,
        email,
        first_name,
        last_name,
        status
      `)
      .eq("auth_user_id", authUser.id)
      .maybeSingle();

    if (userError) {
      next(userError);
      return;
    }

    /*
     * Older repairs sometimes changed an Auth user while leaving the same
     * application profile attached to its email.  Heal only an unambiguous
     * existing profile; never auto-create or grant a role in middleware.
     */
    if (!applicationUser && authUser.email && authUser.email_confirmed_at) {
      const emailPattern = escapeIlikeLiteral(authUser.email);
      const { data: emailMatches, error: emailLookupError } = await supabase
        .from("users")
        .select(`
          id,
          auth_user_id,
          user_number,
          email,
          first_name,
          last_name,
          status
        `)
        .ilike("email", emailPattern)
        .limit(2);

      if (emailLookupError) {
        next(emailLookupError);
        return;
      }

      if (emailMatches?.length === 1) {
        const candidate = emailMatches[0];
        if (!candidate) {
          res.status(403).json({ success: false, message: "Authenticated account is not registered in IDMC iMIS" });
          return;
        }
        // A verified email must never take over a profile already linked to a
        // different Auth identity. Only unclaimed legacy profiles are healable.
        if (candidate.auth_user_id && candidate.auth_user_id !== authUser.id) {
          res.status(403).json({ success: false, message: "Authenticated account is not registered in IDMC iMIS" });
          return;
        }
        const { data: repaired, error: repairError } = await supabase
          .from("users")
          .update({ auth_user_id: authUser.id, updated_at: new Date().toISOString() })
          .eq("id", candidate.id)
          .is("auth_user_id", null)
          .select(`
            id,
            auth_user_id,
            user_number,
            email,
            first_name,
            last_name,
            status
          `)
          .single();

        if (repairError) {
          next(repairError);
          return;
        }
        if (!repaired) {
          res.status(403).json({ success: false, message: "Authenticated account is not registered in IDMC iMIS" });
          return;
        }
        applicationUser = repaired;
      }
    }

    if (!applicationUser) {
      res.status(403).json({
        success: false,
        message: "Authenticated account is not registered in IDMC iMIS"
      });
      return;
    }

    if (applicationUser.status !== "ACTIVE") {
      res.status(403).json({
        success: false,
        message: `User account is ${applicationUser.status}`
      });
      return;
    }

    const requestedRoleId = String(req.get("x-idmc-active-role") ?? "").trim();

    req.authUser = {
      id: authUser.id,
      email: authUser.email,
      emailVerified: Boolean(authUser.email_confirmed_at)
    };

    req.user = {
      id: applicationUser.id,
      authUserId: applicationUser.auth_user_id,
      userNumber: applicationUser.user_number,
      email: applicationUser.email,
      firstName: applicationUser.first_name,
      lastName: applicationUser.last_name,
      status: applicationUser.status,
      activeRoleId: requestedRoleId || null
    };

    next();
  } catch (error) {
    next(error);
  }
}
