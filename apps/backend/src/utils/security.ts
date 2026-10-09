type RoleAssignment = Record<string, any>;

/** Escape PostgreSQL ILIKE metacharacters so user supplied text is literal. */
export function escapeIlikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`);
}

export function parseBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  return authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? null;
}

export function resolveActiveRoleId(assignments: RoleAssignment[] | null | undefined, requestedRoleId?: string | null, now = new Date()): string | null {
  const active = (assignments ?? []).filter(assignment => assignmentIsActive(assignment, now) && typeof assignment.role_id === "string");
  if (requestedRoleId) return active.find(assignment => assignment.role_id === requestedRoleId)?.role_id ?? null;
  const admins = new Set(["ADMIN", "SUPER_ADMIN", "SYSTEM_ADMIN"]);
  active.sort((left, right) => {
    const leftAdmin = admins.has(String(left.roles?.role_code ?? "").toUpperCase());
    const rightAdmin = admins.has(String(right.roles?.role_code ?? "").toUpperCase());
    if (leftAdmin !== rightAdmin) return leftAdmin ? -1 : 1;
    return String(left.assigned_at ?? "").localeCompare(String(right.assigned_at ?? ""));
  });
  return active[0]?.role_id ?? null;
}

export function scopeRoleAssignments(assignments: RoleAssignment[] | null | undefined, requestedRoleId?: string | null, now = new Date()): RoleAssignment[] {
  const rows = assignments ?? [];
  if (!rows.some(assignment => typeof assignment.role_id === "string")) return rows;
  const roleId = resolveActiveRoleId(rows, requestedRoleId, now);
  return roleId ? rows.filter(assignment => assignment.role_id === roleId) : [];
}

function assignmentIsActive(userRole: RoleAssignment, now: Date): boolean {
  return userRole.status === "ACTIVE" && userRole.roles?.status === "ACTIVE" && (!userRole.expires_at || new Date(userRole.expires_at) > now);
}

export function rolesGrantPermission(data: RoleAssignment[] | null | undefined, permissionCode: string, now = new Date()): boolean {
  return (data ?? []).some(userRole => assignmentIsActive(userRole, now) && (userRole.roles?.role_permissions ?? []).some((item: RoleAssignment) => item.permissions?.status === "ACTIVE" && item.permissions?.permission_code === permissionCode));
}

export function rolesGrantRole(data: RoleAssignment[] | null | undefined, roleCodes: string[], now = new Date()): boolean {
  return (data ?? []).some(userRole => assignmentIsActive(userRole, now) && roleCodes.includes(userRole.roles?.role_code));
}
