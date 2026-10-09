import type { NextFunction, Request, Response } from "express";
import { getSupabase } from "../config/database.js";
import { scopeRoleAssignments, rolesGrantPermission, rolesGrantRole } from "../utils/security.js";

type RoleAssignment = Record<string, any>;

function assignmentsForActiveRole(req: Request, data: RoleAssignment[] | null): RoleAssignment[] {
  const scoped = scopeRoleAssignments(data, req.user?.activeRoleId);
  if (scoped[0]?.role_id) req.user!.activeRoleId = scoped[0].role_id;
  return scoped;
}

export function requirePermission(permissionCode: string) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required"
        });
        return;
      }

      const supabase = getSupabase();

      const { data, error } = await supabase
        .from("user_roles")
        .select(`
          id,
          role_id,
          status,
          assigned_at,
          expires_at,
          roles!inner (
            id,
            role_code,
            status,
            role_permissions!inner (
              permissions!inner (
                permission_code,
                status
              )
            )
          )
        `)
        .eq("user_id", req.user.id)
        .eq("status", "ACTIVE");

      if (error) {
        next(error);
        return;
      }

      const hasPermission = rolesGrantPermission(assignmentsForActiveRole(req, data as RoleAssignment[]), permissionCode);

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          message: `Permission denied: ${permissionCode}`
        });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Allow read-only workspace access when a user has either module's view grant. */
export function requireAnyPermission(...permissionCodes: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, message: "Authentication required" });
        return;
      }
      const { data, error } = await getSupabase()
        .from("user_roles")
        .select(`role_id,assigned_at,status,expires_at,roles!inner(status,role_permissions!inner(permissions!inner(permission_code,status)))`)
        .eq("user_id", req.user.id)
        .eq("status", "ACTIVE");
      if (error) return next(error);
      const scoped = assignmentsForActiveRole(req, data as RoleAssignment[]);
      const allowed = permissionCodes.some(code => rolesGrantPermission(scoped, code));
      if (!allowed) {
        res.status(403).json({ success: false, message: `Permission denied: ${permissionCodes.join(" or ")}` });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireRole(...roleCodes: string[]) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required"
        });
        return;
      }
      const supabase = getSupabase();

      const { data, error } = await supabase
        .from("user_roles")
        .select(`
          role_id,
          assigned_at,
          status,
          expires_at,
          roles!inner (
            role_code,
            status
          )
        `)
        .eq("user_id", req.user.id)
        .eq("status", "ACTIVE");

      if (error) {
        next(error);
        return;
      }

      const hasRole = rolesGrantRole(assignmentsForActiveRole(req, data as RoleAssignment[]), roleCodes);

      if (!hasRole) {
        res.status(403).json({
          success: false,
          message: "Required role not assigned"
        });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
