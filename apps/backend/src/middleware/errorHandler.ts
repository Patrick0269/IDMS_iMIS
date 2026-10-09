import type { NextFunction, Request, Response } from "express";
import { logError } from "../utils/logger.js";

type HttpError = Error & {
  statusCode?: number;
  status?: number;
  code?: string;
  details?: string;
};

const SAFE_MESSAGES: Record<string, { status: number; message: string }> = {
  "22P02": { status: 400, message: "One of the supplied identifiers is invalid." },
  "23502": { status: 400, message: "A required value is missing." },
  "23503": { status: 409, message: "This record depends on another record that is missing or still in use." },
  "23514": { status: 400, message: "A supplied value conflicts with a database rule or workflow limit. Check the supplied values and current record status." },
  "22007": { status: 400, message: "One of the supplied dates is invalid." },
  "22008": { status: 400, message: "One of the supplied dates is outside the supported range." },
  "PGRST204": { status: 503, message: "The database schema is missing a field required by this module. Check the migration and schema cache." },
  "PGRST202": { status: 503, message: "A required database function is missing. Check the module migration and schema cache." },
  "P0001": { status: 400, message: "The database rejected this academic operation. Check the linked academic records; the backend log contains the validation reason." },
  "23505": { status: 409, message: "The same record already exists." },
  "42501": { status: 403, message: "Your account is not permitted to complete this action." },
  "PGRST116": { status: 404, message: "The requested record was not found." },
  "42P01": { status: 503, message: "This module is waiting for its database update. Contact the system administrator." },
  "42703": { status: 503, message: "This module is not synchronized with the current database. Contact the system administrator." },
};

function safeFailure(err: HttpError | undefined, requestId: string | undefined) {
  const code = String(err?.code ?? "").toUpperCase();
  if (SAFE_MESSAGES[code]) return SAFE_MESSAGES[code];

  const text = String(err?.message ?? "").toLowerCase();
  if (/fetch failed|network|econn|timeout|timed out|socket/.test(text)) {
    return { status: 503, message: "The database service is temporarily unavailable. Please try again." };
  }

  return {
    status: 500,
    message: `The requested operation could not be completed. Please retry. Reference: ${requestId ?? "unavailable"}`,
  };
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  logError("request_failed", { requestId: req.requestId, method: req.method, path: req.originalUrl, error: err });
  const message = err instanceof Error ? err.message : "The requested operation could not be completed.";
  // Supabase/PostgREST failures are usually plain objects, not Error instances.
  const httpError = err && typeof err === "object" ? err as HttpError : undefined;
  const candidate = httpError?.statusCode ?? httpError?.status;
  const explicitStatus = typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : null;
  const safe = safeFailure(httpError, req.requestId);
  const statusCode = explicitStatus ?? safe.status;
  const publicMessage = err instanceof Error && explicitStatus !== null && statusCode < 500 ? message : safe.message;
  return res.status(statusCode).json({
    success: false,
    message: publicMessage,
    ...(httpError?.code && SAFE_MESSAGES[String(httpError.code).toUpperCase()] ? { errorCode: String(httpError.code).toUpperCase() } : {}),
    requestId: req.requestId,
  });
}
