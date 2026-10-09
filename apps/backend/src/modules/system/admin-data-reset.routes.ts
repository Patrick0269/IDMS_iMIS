import { Router } from "express";
import { env } from "../../config/env.js";
import { getSupabase } from "../../config/database.js";
import { authenticate } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/rbac.js";

const router = Router();
const categories = new Set(["admissions", "students", "academics", "finance", "staff", "operations", "communications", "audit", "accounts", "everything"]);
const projectReference = () => {
  const host = new URL(env.SUPABASE_URL).hostname;
  return host.endsWith(".supabase.co") ? host.split(".")[0] : process.env.SUPABASE_PROJECT_REF || "";
};

router.use(authenticate, requirePermission("system.data.purge"));

router.post("/preview", async (req, res, next) => {
  try {
    const selected: string[] = Array.isArray(req.body?.categories) ? [...new Set<string>(req.body.categories.map((x: unknown) => String(x)))] : [];
    if (!selected.length || selected.some((x: string) => !categories.has(x))) return res.status(400).json({ success: false, message: "Select at least one valid data group." });
    const result = await getSupabase().rpc("admin_data_reset_preview", { p_categories: selected });
    if (result.error) throw result.error;
    return res.json({ success: true, data: { categories: selected, tables: result.data ?? {} } });
  } catch (error) { return next(error); }
});

router.post("/execute", async (req, res, next) => {
  try {
    const selected: string[] = Array.isArray(req.body?.categories) ? [...new Set<string>(req.body.categories.map((x: unknown) => String(x)))] : [];
    if (!selected.length || selected.some((x: string) => !categories.has(x))) return res.status(400).json({ success: false, message: "Select at least one valid data group." });
    const confirmation = selected.includes("everything") ? "DELETE EVERYTHING" : "DELETE SELECTED DATA";
    if (String(req.body?.confirmation ?? "").trim() !== confirmation) return res.status(400).json({ success: false, message: `Type ${confirmation} exactly to continue.` });
    const reference = projectReference();
    if (!reference) return res.status(503).json({ success: false, message: "The active Supabase project could not be identified from the backend configuration." });
    const result = await getSupabase().rpc("admin_data_reset_execute", { p_categories: selected, p_project_reference: reference, p_actor_user_id: req.user!.id });
    if (result.error) throw result.error;
    const data = result.data ?? {};
    let authAccountsDeleted = 0;
    const authDeletionFailures: string[] = [];
    if (selected.includes("everything") || selected.includes("accounts")) {
      const db = getSupabase();
      const preserved = new Set<string>((data.preservedAuthUserIds ?? []).map((id: unknown) => String(id)));
      preserved.add(req.user!.authUserId);
      const toDelete: string[] = [];
      let page = 1;
      const perPage = 1000;
      for (;;) {
        const listed = await db.auth.admin.listUsers({ page, perPage });
        if (listed.error) { authDeletionFailures.push(`Unable to list Auth users: ${listed.error.message}`); break; }
        const users = listed.data.users ?? [];
        toDelete.push(...users.filter(user => !preserved.has(user.id)).map(user => user.id));
        if (users.length < perPage) break;
        page++;
      }
      for (const authUserId of toDelete) {
        const removed = await db.auth.admin.deleteUser(authUserId);
        if (removed.error) authDeletionFailures.push(`${authUserId}: ${removed.error.message}`);
        else authAccountsDeleted++;
      }
    }
    const responseData = { ...data, authAccountsDeleted, authDeletionFailures };
    const message = authDeletionFailures.length
      ? `Database reset completed. ${authDeletionFailures.length} Auth account(s) need manual cleanup; admin accounts and institutional configuration remain.`
      : "Selected data was deleted. Admin accounts and institutional configuration were preserved.";
    return res.json({ success: true, data: responseData, message });
  } catch (error) { return next(error); }
});

export default router;
