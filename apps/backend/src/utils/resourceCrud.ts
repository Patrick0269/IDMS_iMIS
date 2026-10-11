import type { NextFunction, Request, Response } from "express";
import { getSupabase } from "../config/database.js";
import { createAuditLog } from "../services/audit.service.js";
import { requirePermission } from "../middleware/rbac.js";
import { projectCrudResponse } from "./crud-response.js";
export { projectCrudResponse } from "./crud-response.js";

type FieldMap = Record<string, string>;

type CrudConfig = {
  moduleCode: string;
  entityType: string;
  table: string;
  permissionView: string;
  permissionManage: string;
  searchFields?: string[];
  filterFields?: string[];
  listFields?: string[];
  fields: FieldMap;
  defaultOrderField?: string;
  allowDelete?: boolean;
  allowCreate?: boolean;
  allowUpdate?: boolean;
  setCreatedBy?: boolean;
  setUpdatedBy?: boolean;
  validatePayload?: (payload: Record<string, unknown>, current?: Record<string, unknown>) => Promise<void>;
  validateDelete?: (current: Record<string, unknown>) => Promise<void>;
};

function valueOrUndefined(value: unknown): unknown {
  return value === "" ? null : value;
}

function mapBody(body: unknown, fields: FieldMap): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object");
  }

  const source = body as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [apiField, dbField] of Object.entries(fields)) {
    if (Object.prototype.hasOwnProperty.call(source, apiField)) {
      result[dbField] = valueOrUndefined(source[apiField]);
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(source, dbField)) {
      result[dbField] = valueOrUndefined(source[dbField]);
    }
  }

  return result;
}

function responseFields(config: CrudConfig): string[] {
  return [...new Set([
    "id",
    ...Object.values(config.fields),
    ...(config.searchFields ?? []),
    ...(config.filterFields ?? []),
    ...(config.listFields ?? []),
    ...(config.defaultOrderField ? [config.defaultOrderField] : []),
  ])].filter((field) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field));
}

function requireId(req: Request): string {
  const id = String(req.params.id ?? "").trim();
  if (!id) {
    const error = new Error("id is required") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  return id;
}

function actor(req: Request): string | null {
  return req.user?.id ?? null;
}

/**
 * True only when the fetched row actually has a locked_at column
 * (checked at runtime, not from a hardcoded table list) and that
 * column is set. Tables without a locked_at column -- and tables
 * whose locked_at means something else, like a background-worker
 * claim lock -- are unaffected because the column either is not
 * present or (for those) this function is never reached from a
 * generic CRUD route in the first place.
 */
function isRecordLocked(row: Record<string, unknown>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(row, "locked_at") &&
    Boolean(row.locked_at)
  );
}

async function audit(req: Request, config: CrudConfig, actionCode: string, entityId: string | null, oldValues: unknown, newValues: unknown) {
  try {
    await createAuditLog({
      actorUserId: actor(req),
      actionCode,
      moduleCode: config.moduleCode,
      entityType: config.entityType,
      entityId,
      oldValues,
      newValues,
      ipAddress: req.ip ?? null,
      requestId: req.requestId ?? null,
    });
  } catch (error) {
    console.warn("Audit logging failed", error);
  }
}

export function createCrudHandlers(config: CrudConfig) {
  const list = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pageRaw = Number(req.query.page ?? 1);
      const limitRaw = Number(req.query.limit ?? 25);
      const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
      const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? limitRaw : 25;
      const from = (page - 1) * limit;
      const to = from + limit - 1;

      // Keep collection and single-record payloads within the resource's declared fields.
      const listFields = responseFields(config);

      let query = getSupabase()
        .from(config.table)
        .select(listFields.join(","), { count: "exact" })
        .range(from, to);

      const search = String(req.query.search ?? "").trim().replace(/[,%()]/g, " ").replace(/\s+/g, " ").slice(0, 100);
      if (search && config.searchFields?.length) {
        query = query.or(
          config.searchFields
            .map((field) => `${field}.ilike.%${search}%`)
            .join(",")
        );
      }

      for (const field of config.filterFields ?? []) {
        const value = req.query[field];
        if (typeof value === "string" && value.trim()) {
          query = query.eq(field, value.trim());
        }
      }

      const orderField = config.defaultOrderField ?? "created_at";
      const sortFields = [...new Set([
        ...Object.values(config.fields),
        ...(config.searchFields ?? []),
        ...(config.filterFields ?? []),
        orderField,
      ])].filter((field) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field));
      const requestedSort = typeof req.query.sortBy === "string" ? req.query.sortBy : "";
      const sortBy = sortFields.includes(requestedSort) ? requestedSort : orderField;
      query = query.order(sortBy, { ascending: String(req.query.sortDirection ?? "").toLowerCase() === "asc" });

      const { data, error, count } = await query;
      if (error) throw error;

      return res.status(200).json({
        success: true,
        data: data ?? [],
        meta: { page, limit, total: count ?? 0, filterFields: config.filterFields ?? [], sortFields, defaultOrderField: orderField },
      });
    } catch (error) {
      next(error);
    }
  };

  const getById = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = requireId(req);
      const fields = responseFields(config);
      const { data, error } = await getSupabase()
        .from(config.table)
        .select(fields.join(","))
        .eq("id", id)
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        return res.status(404).json({ success: false, message: `${config.entityType} not found` });
      }

      return res.status(200).json({ success: true, data: projectCrudResponse(data as unknown as Record<string, unknown>, fields) });
    } catch (error) {
      next(error);
    }
  };

  const create = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = mapBody(req.body, config.fields);
      if (config.validatePayload) await config.validatePayload(payload);
      if (config.setCreatedBy && actor(req)) payload.created_by = actor(req);

      /*
       * Applicants require applicant_number in the database.
       * Applicant numbers are system-generated and must not be
       * manually entered by the applicant.
       */
      if (
        config.table === "applicants" &&
        !payload.applicant_number
      ) {
        const now = new Date();

        const year = String(now.getUTCFullYear());

        const randomPart =
          Math.random()
            .toString(36)
            .slice(2, 8)
            .toUpperCase();

        const timePart =
          String(Date.now()).slice(-8);

        payload.applicant_number =
          `APP-${year}-${timePart}-${randomPart}`;
      }

      if (!Object.keys(payload).length) {
        const error = new Error("No allowed fields supplied") as Error & { statusCode?: number };
        error.statusCode = 400;
        throw error;
      }

      const { data, error } = await getSupabase()
        .from(config.table)
        .insert(payload)
        .select("*")
        .single();

      if (error) throw error;

      await audit(req, config, `${config.entityType.toUpperCase()}_CREATE`, data.id ?? null, null, data);
      return res.status(201).json({ success: true, data: projectCrudResponse(data, responseFields(config)) });
    } catch (error) {
      next(error);
    }
  };

  const update = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = requireId(req);
      const payload = mapBody(req.body, config.fields);

      /*
       * Applicants require applicant_number in the database.
       * Applicant numbers are system-generated and must not be
       * manually entered by the applicant.
       */
      if (
        config.table === "applicants" &&
        !payload.applicant_number
      ) {
        const now = new Date();

        const year = String(now.getUTCFullYear());

        const randomPart =
          Math.random()
            .toString(36)
            .slice(2, 8)
            .toUpperCase();

        const timePart =
          String(Date.now()).slice(-8);

        payload.applicant_number =
          `APP-${year}-${timePart}-${randomPart}`;
      }

      if (!Object.keys(payload).length) {
        const error = new Error("No allowed fields supplied") as Error & { statusCode?: number };
        error.statusCode = 400;
        throw error;
      }

      const supabase = getSupabase();
      const currentResult = await supabase
        .from(config.table)
        .select("*")
        .eq("id", id)
        .maybeSingle();

      if (currentResult.error) throw currentResult.error;
      if (!currentResult.data) {
        return res.status(404).json({ success: false, message: `${config.entityType} not found` });
      }

      if (isRecordLocked(currentResult.data)) {
        return res.status(423).json({
          success: false,
          message: `${config.entityType} is locked and can no longer be modified.`,
        });
      }

      if (config.validatePayload) await config.validatePayload(payload, currentResult.data);
      if (config.setUpdatedBy && actor(req)) payload.updated_by = actor(req);

      const { data, error } = await supabase
        .from(config.table)
        .update(payload)
        .eq("id", id)
        .select("*")
        .single();

      if (error) throw error;

      await audit(req, config, `${config.entityType.toUpperCase()}_UPDATE`, id, currentResult.data, data);
      return res.status(200).json({ success: true, data: projectCrudResponse(data, responseFields(config)) });
    } catch (error) {
      next(error);
    }
  };

  const remove = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = requireId(req);
      const supabase = getSupabase();

      const currentResult = await supabase
        .from(config.table)
        .select("*")
        .eq("id", id)
        .maybeSingle();

      if (currentResult.error) throw currentResult.error;
      if (!currentResult.data) {
        return res.status(404).json({ success: false, message: `${config.entityType} not found` });
      }

      if (config.validateDelete) await config.validateDelete(currentResult.data);

      if (isRecordLocked(currentResult.data)) {
        return res.status(423).json({
          success: false,
          message: `${config.entityType} is locked and can no longer be deleted.`,
        });
      }

      const { error } = await supabase
        .from(config.table)
        .delete()
        .eq("id", id);

      if (error) throw error;

      await audit(req, config, `${config.entityType.toUpperCase()}_DELETE`, id, currentResult.data, null);
      return res.status(204).send();
    } catch (error) {
      next(error);
    }
  };

  return { list, getById, create, update, remove };
}

export function registerCrudResource(
  router: import("express").Router,
  config: CrudConfig,
  path: string
) {
  const handlers = createCrudHandlers(config);
  router.get(path, requirePermission(config.permissionView), handlers.list);
  router.get(`${path}/:id`, requirePermission(config.permissionView), handlers.getById);
  if (config.allowCreate !== false) router.post(path, requirePermission(config.permissionManage), handlers.create);
  if (config.allowUpdate !== false) router.patch(`${path}/:id`, requirePermission(config.permissionManage), handlers.update);
  if (config.allowDelete !== false) {
    router.delete(`${path}/:id`, requirePermission(config.permissionManage), handlers.remove);
  }
}


