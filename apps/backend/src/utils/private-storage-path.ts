const BUCKET = "idmc-private-documents";

function isSafeObjectPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f?#]/.test(path)) return false;
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) return false;
  try {
    return parts.every(part => {
      const decoded = decodeURIComponent(part);
      return decoded !== "." && decoded !== ".." && !decoded.includes("/") && !decoded.includes("\\") && !/[\u0000-\u001f?#]/.test(decoded);
    });
  } catch {
    return false;
  }
}

export function privateStorageObjectPath(input: unknown, supabaseUrl: string, requiredPrefix?: string | string[]): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const value = input.trim();
  let path = value;

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const base = new URL(supabaseUrl);
      if (url.origin !== base.origin || url.username || url.password) return null;
      // Read the raw path before URL normalization; URL.pathname can erase encoded dot segments.
      const rawPath = value.match(/^https?:\/\/[^/?#]+(\/[^?#]*)/i)?.[1];
      if (!rawPath) return null;
      const match = rawPath.match(/^\/storage\/v1\/object\/(?:public|authenticated|sign)\/idmc-private-documents\/(.+)$/);
      if (!match) return null;
      path = decodeURIComponent(match[1]!);
    } catch {
      return null;
    }
  }

  if (!isSafeObjectPath(path) || path.split("/")[0] === BUCKET) return null;
  if (requiredPrefix) {
    const prefixes = Array.isArray(requiredPrefix) ? requiredPrefix : [requiredPrefix];
    if (!prefixes.some(prefix => path.startsWith(prefix))) return null;
  }
  return path;
}
