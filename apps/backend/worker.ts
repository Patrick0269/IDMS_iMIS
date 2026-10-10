import { createServer } from "node:http";
import { httpServerHandler } from "cloudflare:node";
import app from "./src/app.js";
import { getSupabase } from "./src/config/database.js";

const server = createServer(app);
server.listen(8787);

const httpHandler = httpServerHandler({ port: 8787 });

export default {
  ...httpHandler,
  scheduled(_controller, _env, context) {
    context.waitUntil(
      getSupabase()
        .rpc("idmc_ap_calendar_tick")
        .then(({ error }) => {
          if (error) console.warn("Academic scheduler: " + error.message);
        })
        .catch((error) => {
          console.warn("Academic scheduler: " + (error instanceof Error ? error.message : String(error)));
        }),
    );
  },
};