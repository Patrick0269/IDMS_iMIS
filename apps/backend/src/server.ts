import app from "./app.js";
import { env } from "./config/env.js";
import { logInfo } from "./utils/logger.js";

import { getSupabase } from "./config/database.js";
let academicTickRunning = false;
async function academicTick() {
 if (academicTickRunning) return;
 academicTickRunning = true;
 try { const result = await getSupabase().rpc('idmc_ap_calendar_tick'); if (result.error) console.warn('Academic scheduler: '+result.error.message); }
 catch (error:any) { console.warn('Academic scheduler: '+error.message); }
 finally { academicTickRunning = false; }
}
const academicTimer = setInterval(academicTick, 60_000); academicTimer.unref();
const server = app.listen(env.PORT, () => {
  void academicTick();
  logInfo(
    `IDMS iMIS API running on http://localhost:${env.PORT}`
  );

  logInfo(
    `Health check: http://localhost:${env.PORT}/api/v1/health`
  );
});

// Keep connections reusable on slow or high-latency networks while still
// placing a hard upper bound on stalled requests.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 60_000;

function shutdown(signal: string) {
  logInfo(`${signal} received. Shutting down server...`);

  clearInterval(academicTimer);
  server.close(() => {
    logInfo("HTTP server closed.");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
