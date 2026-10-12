import { createHmac, timingSafeEqual } from "node:crypto";
import { getSupabase } from "../config/database.js";
import { env } from "../config/env.js";

interface SignedObject { bucket: string; path: string; exp: number }
interface DownloadedObject { path: string; content_type: string; contents_base64: string; size: number }

function signingSecret(): string {
  if (!env.LOCAL_AUTH_JWT_SECRET) throw new Error("LOCAL_AUTH_JWT_SECRET is required for PostgreSQL file links.");
  return createHmac("sha256", env.LOCAL_AUTH_JWT_SECRET).update("idmc-postgres-storage-v1").digest("hex");
}

function signPayload(payload: SignedObject): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", signingSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyLocalStorageToken(token: string): SignedObject | null {
  try {
    const [encoded, supplied] = token.split(".");
    if (!encoded || !supplied) return null;
    const expected = createHmac("sha256", signingSecret()).update(encoded).digest();
    const actual = Buffer.from(supplied, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SignedObject;
    if (typeof payload.bucket !== "string" || typeof payload.path !== "string" || !Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await getSupabase().rpc(name, args);
  if (result.error) throw result.error;
  return result.data as T;
}

async function downloadObject(bucket: string, path: string): Promise<DownloadedObject | null> {
  return (await rpc<DownloadedObject | null>("idmc_local_storage_download", { p_bucket: bucket, p_path: path })) ?? null;
}

function errorResult(error: unknown) { return { message: error instanceof Error ? error.message : "PostgreSQL file operation failed", name: "PostgrestError" }; }

export function createLocalStorageCompatibility() {
  return {
    from(bucket: string) {
      return {
        async upload(path: string, body: ArrayBuffer | ArrayBufferView | Blob | File, options: { contentType?: string; upsert?: boolean } = {}) {
          try {
            const bytes = body instanceof Blob
              ? Buffer.from(await body.arrayBuffer())
              : ArrayBuffer.isView(body)
                ? Buffer.from(body.buffer, body.byteOffset, body.byteLength)
                : Buffer.from(body);
            const data = await rpc<{ path: string; fullPath: string }>("idmc_local_storage_put", {
              p_bucket: bucket, p_path: path, p_contents_base64: bytes.toString("base64"), p_content_type: options.contentType || "application/octet-stream", p_upsert: options.upsert === true,
            });
            return { data, error: null };
          } catch (error) { return { data: null, error: errorResult(error) }; }
        },
        async remove(paths: string[]) {
          try {
            const data = await rpc<string[]>("idmc_local_storage_remove", { p_bucket: bucket, p_paths: paths });
            return { data: (data || []).map(name => ({ name })), error: null };
          } catch (error) { return { data: null, error: errorResult(error) }; }
        },
        async download(path: string) {
          try {
            const object = await downloadObject(bucket, path);
            if (!object) throw new Error("File was not found in the local PostgreSQL store");
            const bytes = Buffer.from(object.contents_base64, "base64");
            return { data: new Blob([bytes], { type: object.content_type }), error: null };
          } catch (error) { return { data: null, error: errorResult(error) }; }
        },
        async createSignedUrl(path: string, expiresIn = 300) {
          try {
            if (!await downloadObject(bucket, path)) throw new Error("File was not found in the local PostgreSQL store");
            const seconds = Math.max(1, Math.min(Number(expiresIn) || 300, 3600));
            const token = signPayload({ bucket, path, exp: Math.floor(Date.now() / 1000) + seconds });
            const base = (env.PUBLIC_API_URL || `${env.FRONTEND_URL.replace(/\/$/, "")}/api/v1`).replace(/\/$/, "");
            return { data: { signedUrl: `${base}/storage/private/${encodeURIComponent(token)}`, path }, error: null };
          } catch (error) { return { data: null, error: errorResult(error) }; }
        },
      };
    },
  };
}

export async function readLocalStorageToken(token: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const verified = verifyLocalStorageToken(token);
  if (!verified) return null;
  const object = await downloadObject(verified.bucket, verified.path);
  if (!object) return null;
  return { bytes: Buffer.from(object.contents_base64, "base64"), contentType: object.content_type };
}
