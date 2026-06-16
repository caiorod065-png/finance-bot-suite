import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  OPENAI_API_KEY: z.string().min(10).default("sk-placeholder-change-me"),
  OPENAI_MODEL: z.string().default("gpt-4o"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),

  SUPABASE_URL: z.string().url().default("https://placeholder.supabase.co"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10).default("supabase-placeholder-change-me"),

  WHATSAPP_VERIFY_TOKEN: z.string().optional(),

  CRON_SECRET: z.string().min(16),
  INTERNAL_API_KEY: z.string().min(16),

  QUALITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.72),
  CANDIDATE_MIN_IMPROVEMENT: z.coerce.number().min(0).max(1).default(0.06),
  ANALYSIS_WINDOW_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(180),
  RAG_TOP_K: z.coerce.number().int().min(1).max(50).default(8),
  MAX_SIMULATION_CASES: z.coerce.number().int().min(3).max(200).default(24),

  IARA_PROMPT_BASE: z.string().optional(),

  VERCEL_TOKEN: z.string().optional(),
  VERCEL_PROJECT_ID: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  VERCEL_ENV_TARGET: z.enum(["production", "preview"]).default("production"),
  VERCEL_DEPLOY_HOOK_URL: z.preprocess(v => v === '' ? undefined : v, z.string().url().optional()),
  AUTOPILOT_AUTO_DEPLOY: z.preprocess(v => v === '' ? undefined : v, z.enum(["true", "false"]).optional()).default("false"),

  VALIDATOR_AGENT_ENDPOINTS: z.string().optional(),
  VALIDATOR_AGENT_BEARER: z.string().optional()
});

const parsed = envSchema.parse(process.env);

export const env = parsed;

export function assertRuntimeEnv(): void {
  const missing: string[] = [];
  if (env.OPENAI_API_KEY.includes("placeholder")) missing.push("OPENAI_API_KEY");
  if (env.SUPABASE_URL.includes("placeholder.supabase.co")) missing.push("SUPABASE_URL");
  if (env.SUPABASE_SERVICE_ROLE_KEY.includes("placeholder")) missing.push("SUPABASE_SERVICE_ROLE_KEY");

  if (missing.length) {
    throw new Error(`Missing required runtime env vars: ${missing.join(", ")}`);
  }
}
