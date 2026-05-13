import { env } from "@/lib/env";

export function assertInternalApiKey(req: Request): void {
  if (!env.INTERNAL_API_KEY) return;

  const header = req.headers.get("x-internal-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!header || header !== env.INTERNAL_API_KEY) {
    throw new Error("unauthorized");
  }
}

export function assertCronSecret(req: Request): void {
  if (!env.CRON_SECRET) return;

  const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const cron = req.headers.get("x-vercel-cron-secret");
  const provided = auth || cron;

  if (!provided || provided !== env.CRON_SECRET) {
    throw new Error("unauthorized_cron");
  }
}
