import { Router, type Request, type Response, type NextFunction } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/rbac.js";
import { getSupabase } from "../../config/database.js";

const router = Router();
router.use(authenticate);

router.get("/dashboard", requirePermission("leadership.dashboard.view"), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const delayedBefore = new Date(Date.now() - 14 * 86400000).toISOString();
    const snapshot = await getSupabase().rpc("idmc_leadership_dashboard_snapshot", {
      p_month_start: monthStart,
      p_delayed_before: delayedBefore,
    });

    if (snapshot.error) {
      const missingSnapshotFunction = snapshot.error.code === "PGRST202"
        || snapshot.error.code === "42883"
        || /idmc_leadership_dashboard_snapshot.*(not found|does not exist)|function .* does not exist/i.test(snapshot.error.message || "");
      if (missingSnapshotFunction) {
        return res.status(503).json({
          success: false,
          message: "Leadership dashboard summary is unavailable until its aggregation migration is applied.",
        });
      }
      throw snapshot.error;
    }

    return res.json({ success: true, data: { ...snapshot.data, generatedAt: now.toISOString() } });
  } catch (error) {
    next(error);
  }
});

export default router;
