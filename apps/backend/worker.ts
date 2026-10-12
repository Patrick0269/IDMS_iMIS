import { createServer } from "node:http";
import { httpServerHandler } from "cloudflare:node";
import app from "./src/app.js";
import { getSupabase } from "./src/config/database.js";
import { setWorkerPostgresBinding, withPostgresClient, type HyperdriveBinding } from "./src/config/postgres.js";

interface WorkerEnvironment {
  HYPERDRIVE?: HyperdriveBinding;
}

const server = createServer(app);
server.listen(8787);

const httpHandler = httpServerHandler({ port: 8787 });

export default {
  ...httpHandler,
  async fetch(request: Request, env: WorkerEnvironment, context: ExecutionContext) {
    if (env.HYPERDRIVE) setWorkerPostgresBinding(env.HYPERDRIVE);
    return httpHandler.fetch(request, env, context);
  },
  scheduled(_controller, env: WorkerEnvironment, context: ExecutionContext) {
    if (env.HYPERDRIVE) {
      setWorkerPostgresBinding(env.HYPERDRIVE);
      context.waitUntil(withPostgresClient((client) => client.query("SELECT idmc_ap_calendar_tick()")));
      return;
    }
    context.waitUntil(getSupabase().rpc("idmc_ap_calendar_tick").then(({ error }) => {
      if (error) console.warn("Academic scheduler: " + error.message);
    }));
  },
};
