import { createApplicationSupabaseClient } from "../../../config/database.js";

// Share the routed database client with other backend modules.
export const institutionDb = createApplicationSupabaseClient();
