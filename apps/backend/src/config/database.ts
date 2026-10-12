import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";
import { createLocalAuthCompatibility } from "../services/postgres-auth.service.js";
import { createLocalStorageCompatibility } from "../services/postgres-storage.service.js";

let legacySupabase: SupabaseClient | null = null;
let postgrest: SupabaseClient | null = null;
let applicationClient: SupabaseClient | null = null;
let localAuthCompatibility: ReturnType<typeof createLocalAuthCompatibility> | null = null;
let localStorageCompatibility: ReturnType<typeof createLocalStorageCompatibility> | null = null;

/**
 * Supabase JS always adds `/rest/v1` to its base URL. A standalone PostgREST
 * server exposes resources at `/` by default, so remove only that client
 * prefix before forwarding requests to our self-hosted PostgREST endpoint.
 */
function createStandalonePostgrestFetch(): typeof fetch {
  const postgrestOrigin = new URL(env.POSTGREST_URL!).origin;
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === postgrestOrigin && (url.pathname === "/rest/v1" || url.pathname.startsWith("/rest/v1/"))) {
      url.pathname = url.pathname.slice("/rest/v1".length) || "/";
    }
    return fetch(new Request(url, request));
  };
}

function getLegacySupabase(): SupabaseClient {
  if (!legacySupabase) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("The legacy Supabase provider is not configured.");
    }
    legacySupabase = createClient(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }
  return legacySupabase;
}

/** Shared database API client, routed to PostgREST when PostgreSQL is active. */
export function getSupabase(): SupabaseClient {
  if (!env.POSTGREST_URL || !env.POSTGREST_SERVICE_ROLE_KEY) {
    return getLegacySupabase();
  }

  if (!postgrest) {
    postgrest = createClient(
      env.POSTGREST_URL,
      env.POSTGREST_SERVICE_ROLE_KEY,
      {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { fetch: createStandalonePostgrestFetch() },
      },
    );
  }

  if (!applicationClient) {
    applicationClient = new Proxy(postgrest, {
      get(target, property, receiver) {
        if (property === "auth" && env.AUTH_PROVIDER === "postgres") {
          localAuthCompatibility ??= createLocalAuthCompatibility();
          return localAuthCompatibility;
        }
        if (property === "storage" && env.AUTH_PROVIDER === "postgres") {
          localStorageCompatibility ??= createLocalStorageCompatibility();
          return localStorageCompatibility;
        }
        if (property === "auth" || property === "storage") {
          if (env.AUTH_PROVIDER === "postgres") {
            throw new Error(`PostgreSQL ${String(property)} compatibility is not configured.`);
          }
          const legacy = getLegacySupabase();
          return Reflect.get(legacy, property, legacy);
        }
        const value = Reflect.get(target, property, target);
        // SupabaseClient methods use instance state; bind them to the real
        // client so running them through this compatibility proxy is safe.
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as SupabaseClient;
  }
  return applicationClient;
}

/** Create the same routed application client for secondary data modules. */
export function createApplicationSupabaseClient(): SupabaseClient {
  return getSupabase();
}

/*
 * Auth remains isolated from the shared service-role data client while it is
 * being moved to PostgreSQL. This prevents an interactive sign-in from
 * mutating the shared data client's authorization context.
 */
export function createSupabaseAuthClient(): SupabaseClient {
  if (env.AUTH_PROVIDER === "postgres") {
    localAuthCompatibility ??= createLocalAuthCompatibility();
    return { auth: localAuthCompatibility } as unknown as SupabaseClient;
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("The legacy Supabase Auth provider is not configured.");
  }
  return createClient(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } },
  );
}
