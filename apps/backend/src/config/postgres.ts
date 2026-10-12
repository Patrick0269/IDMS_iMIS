import { Client, Pool, type PoolClient } from "pg";
import { env } from "./env.js";

export interface HyperdriveBinding {
  connectionString: string;
}

type QueryClient = Pick<PoolClient, "query">;

let workerConnectionString: string | undefined;
let localPool: Pool | undefined;

export function isPostgresConfigured(): boolean {
  return Boolean(workerConnectionString || env.DATABASE_URL);
}

/**
 * Supply the Cloudflare Hyperdrive connection for the current Worker request.
 * A Worker client is opened and closed per operation; Hyperdrive owns the
 * long-lived connection pool on its side.
 */
export function setWorkerPostgresBinding(binding: HyperdriveBinding): void {
  if (!binding?.connectionString?.startsWith("postgres")) {
    throw new Error("A PostgreSQL Hyperdrive binding is required.");
  }
  workerConnectionString = binding.connectionString;
}

function connectionString(): string {
  const value = workerConnectionString || env.DATABASE_URL;
  if (!value) {
    throw new Error("PostgreSQL is not configured. Set DATABASE_URL or bind HYPERDRIVE.");
  }
  return value;
}

/** Node server pool for local development and non-Worker deployments. */
export function getPostgresPool(): Pool {
  if (!localPool) {
    if (workerConnectionString) {
      throw new Error("Use withPostgresClient() inside a Cloudflare Worker.");
    }
    localPool = new Pool({
      connectionString: connectionString(),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      keepAlive: true,
    });
    localPool.on("error", (error) => {
      console.error("Unexpected idle PostgreSQL client error", error);
    });
  }
  return localPool;
}

/** Execute one database operation using the runtime-appropriate connection. */
export async function withPostgresClient<T>(operation: (client: QueryClient) => Promise<T>): Promise<T> {
  if (workerConnectionString) {
    const client = new Client({ connectionString: connectionString() });
    await client.connect();
    try {
      return await operation(client);
    } finally {
      await client.end();
    }
  }

  const client = await getPostgresPool().connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

export async function checkPostgres(): Promise<{ version: string; latencyMs: number }> {
  const startedAt = Date.now();
  const result = await withPostgresClient((client) => client.query<{ version: string }>("SELECT version() AS version"));
  return { version: result.rows[0]?.version ?? "unknown", latencyMs: Date.now() - startedAt };
}

export async function closePostgresPool(): Promise<void> {
  const pool = localPool;
  localPool = undefined;
  if (pool) await pool.end();
}
