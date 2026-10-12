import "dotenv/config";
import { z } from "zod";

const optionalText = z.preprocess(
  (input) => typeof input === "string" && input.trim() === "" ? undefined : input,
  z.string().min(1).optional()
);

const optionalUrl = z.preprocess(
  (input) => typeof input === "string" && input.trim() === "" ? undefined : input,
  z.string().url().optional()
);

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce.number().default(4000),

  // Direct PostgreSQL connection for native scheduler/maintenance operations.
  // Application table and RPC calls use POSTGREST_URL.
  DATABASE_URL: optionalText,

  // Self-managed PostgREST endpoint for PostgreSQL table/RPC access.
  POSTGREST_URL: optionalUrl,
  POSTGREST_SERVICE_ROLE_KEY: optionalText,

  // Keep the Supabase implementation as the default until the local Auth
  // tables and PostgreSQL API have been configured and verified.
  AUTH_PROVIDER: z.enum(["supabase", "postgres"]).default("supabase"),
  LOCAL_AUTH_JWT_SECRET: optionalText,
  PUBLIC_API_URL: optionalUrl,

  SUPABASE_URL: optionalUrl,
  SUPABASE_SERVICE_ROLE_KEY: optionalText,
  // Origin used only to recognize old Supabase Storage URLs already stored in
  // file metadata; PostgreSQL mode never makes requests to this origin.
  LEGACY_STORAGE_ORIGIN: optionalUrl,

  JWT_SECRET: z
    .string()
    .min(16),

  JWT_EXPIRES_IN: z
    .string()
    .default("8h"),

  CORS_ORIGIN: z
    .string()
    .default("http://127.0.0.1:5500"),

  SMTP_HOST: z
    .string()
    .min(1),

  SMTP_PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(587),

  SMTP_SECURE: z.preprocess(
    (value) => typeof value === "string" ? value.trim().toLowerCase() : value,
    z.enum(["true", "false"]).optional()
  ),

  SMTP_USER: z
    .string()
    .email(),

  SMTP_PASSWORD: optionalText,

  // Legacy alias accepted for existing deployments that still set SMTP_PASS.
  SMTP_PASS: optionalText,

  SMTP_FROM_NAME: z
    .string()
    .default("IDMS Integrated Management Information System"),

  SMTP_FROM_EMAIL: z
    .string()
    .email(),

  FRONTEND_URL: z
    .string()
    .url()
    .default("http://127.0.0.1:5500/apps/frontend"),

  PAYMENT_PROVIDER_CALLBACK_SECRET: z
    .string()
    .min(24)
    .optional(),

  NATIONAL_RESULTS_PROVIDER_URL: optionalUrl,
  NATIONAL_RESULTS_PROVIDER_API_KEY: optionalText,
}).superRefine((settings, context) => {
  if (Boolean(settings.POSTGREST_URL) !== Boolean(settings.POSTGREST_SERVICE_ROLE_KEY)) {
    context.addIssue({ code: "custom", path: ["POSTGREST_SERVICE_ROLE_KEY"], message: "Set POSTGREST_URL and POSTGREST_SERVICE_ROLE_KEY together." });
  }
  if (settings.AUTH_PROVIDER === "postgres" && (!settings.POSTGREST_URL || !settings.POSTGREST_SERVICE_ROLE_KEY || !settings.LOCAL_AUTH_JWT_SECRET)) {
    context.addIssue({ code: "custom", path: ["LOCAL_AUTH_JWT_SECRET"], message: "PostgreSQL Auth requires POSTGREST_URL, POSTGREST_SERVICE_ROLE_KEY and LOCAL_AUTH_JWT_SECRET." });
  }
  if (settings.AUTH_PROVIDER === "supabase" && (!settings.SUPABASE_URL || !settings.SUPABASE_SERVICE_ROLE_KEY)) {
    context.addIssue({ code: "custom", path: ["SUPABASE_URL"], message: "The Supabase Auth provider requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." });
  }
  if (!settings.SMTP_PASSWORD && !settings.SMTP_PASS) {
    context.addIssue({ code: "custom", path: ["SMTP_PASSWORD"], message: "Set SMTP_PASSWORD or SMTP_PASS." });
  }
}).transform(({ SMTP_PASS, SMTP_PASSWORD, ...settings }) => ({
  ...settings,
  // Prefer the canonical name if both are set; accept the legacy alias otherwise.
  SMTP_PASSWORD: SMTP_PASSWORD ?? SMTP_PASS ?? "",
  // Brevo 587 uses STARTTLS. Only port 465 should default to implicit TLS.
  SMTP_SECURE: settings.SMTP_SECURE === undefined
    ? settings.SMTP_PORT === 465
    : settings.SMTP_SECURE === "true",
}));

export const env = envSchema.parse(process.env);
