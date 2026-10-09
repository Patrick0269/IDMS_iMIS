import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

type WorkflowNotice = {
  recipientUserId: string | null | undefined;
  recipientStudentId?: string | null;
  type: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
};

/** Queue an in-app notice for active users holding one of the requested roles. */
export async function queueRoleWorkflowNotification(
  db: SupabaseClient,
  roleCodes: string[],
  notice: Omit<WorkflowNotice, "recipientUserId" | "recipientStudentId"> & { excludeUserId?: string | null; departmentId?: string | null },
): Promise<void> {
  try {
    const normalizedRoles = [...new Set(roleCodes.map(code => code.toUpperCase()))];
    if (!normalizedRoles.length) return;
    const roles = await db.from("roles").select("id,role_code").in("role_code", normalizedRoles).eq("status", "ACTIVE");
    if (roles.error) throw roles.error;
    const roleIds = (roles.data ?? []).map((role: any) => role.id).filter(Boolean);
    if (!roleIds.length) return;
    let assignmentsQuery = db.from("user_roles").select("user_id").in("role_id", roleIds).eq("status", "ACTIVE");
    assignmentsQuery = assignmentsQuery.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
    const assignments = await assignmentsQuery;
    if (assignments.error) throw assignments.error;
    let userIds = [...new Set((assignments.data ?? []).map((row: any) => row.user_id).filter((id: string) => id && id !== notice.excludeUserId))];
    if (notice.departmentId && normalizedRoles.includes("HOD")) {
      const [scopes, staff] = await Promise.all([
        db.from("user_scopes").select("user_id").eq("scope_type", "DEPARTMENT").eq("department_id", notice.departmentId),
        db.from("staff").select("user_id").eq("department_id", notice.departmentId).eq("employment_status", "ACTIVE"),
      ]);
      if (scopes.error) throw scopes.error;
      if (staff.error) throw staff.error;
      const departmentUsers = new Set([...(scopes.data ?? []), ...(staff.data ?? [])].map((row: any) => row.user_id).filter(Boolean));
      userIds = userIds.filter(id => departmentUsers.has(id));
    }
    if (!userIds.length) return;
    const rows = userIds.slice(0, 500).map(recipientUserId => ({
      notification_number: `WF-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`,
      recipient_user_id: recipientUserId,
      recipient_student_id: null,
      notification_type: notice.type.slice(0, 50),
      title: notice.title.slice(0, 200),
      body: notice.body,
      priority: "NORMAL",
      status: "PENDING",
      metadata: notice.metadata ?? {},
    }));
    const inserted = await db.from("notifications").insert(rows);
    if (inserted.error) throw inserted.error;
  } catch (error) {
    console.warn("Role workflow notification could not be queued", error instanceof Error ? error.message : error);
  }
}

/** Best-effort in-app notice; notification failure must not undo an approved workflow action. */
export async function queueWorkflowNotification(db: SupabaseClient, notice: WorkflowNotice): Promise<void> {
  if (!notice.recipientUserId && !notice.recipientStudentId) return;
  const result = await db.from("notifications").insert({
    notification_number: `WF-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    recipient_user_id: notice.recipientUserId ?? null,
    recipient_student_id: notice.recipientStudentId ?? null,
    notification_type: notice.type.slice(0, 50),
    title: notice.title.slice(0, 200),
    body: notice.body,
    priority: "NORMAL",
    status: "PENDING",
    metadata: notice.metadata ?? {},
  });
  if (result.error) console.warn("Workflow notification could not be queued", result.error.message);
}

export async function queueStudentWorkflowNotification(
  db: SupabaseClient,
  studentId: string,
  notice: Omit<WorkflowNotice, "recipientUserId" | "recipientStudentId">,
): Promise<void> {
  const student = await db.from("students").select("user_id").eq("id", studentId).maybeSingle();
  if (student.error) {
    console.warn("Student workflow notification target could not be resolved", student.error.message);
    return;
  }
  await queueWorkflowNotification(db, {
    ...notice,
    recipientUserId: student.data?.user_id,
    recipientStudentId: studentId,
  });
}
