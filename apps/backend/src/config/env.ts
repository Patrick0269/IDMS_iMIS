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

  SUPABASE_URL: z
    .string()
    .url(),

  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1),

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
    .default("IDMC Integrated Management Information System"),

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
