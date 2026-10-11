import type { NextFunction, Request, Response } from "express";
import { getSupabase } from "../config/database.js";
import { rolesGrantPermission, rolesGrantRole } from "../utils/security.js";

type RoleAssignment = Record<string, any>;

function assignmentGranting(req: Request, data: RoleAssignment[] | null, grants: (assignment: RoleAssignment) => boolean): RoleAssignment[] {
  const rows = data ?? [];
  const current = rows.find(assignment => assignment.role_id === req.user?.activeRoleId && grants(assignment));
  const selected = current ?? rows.find(grants);
  if (selected?.role_id) req.user!.activeRoleId = selected.role_id;
  return selected ? [selected] : [];
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

      const hasPermission = rolesGrantPermission(
        assignmentGranting(req, data as RoleAssignment[], assignment => rolesGrantPermission([assignment], permissionCode)),
        permissionCode
      );

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
      const scoped = assignmentGranting(req, data as RoleAssignment[], assignment => permissionCodes.some(code => rolesGrantPermission([assignment], code)));
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

      const hasRole = rolesGrantRole(
        assignmentGranting(req, data as RoleAssignment[], assignment => rolesGrantRole([assignment], roleCodes)),
        roleCodes
      );

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
