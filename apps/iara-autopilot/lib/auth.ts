import { env } from "@/lib/env";

export function assertInternalApiKey(req: Request): void {
  const key = env.INTERNAL_API_KEY;
  if (!key) throw new Error("unauthorized");

  const header = req.headers.get("x-internal-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!header || header !== key) {
    throw new Error("unauthorized");
  }
}

export function assertCronSecret(req: Request): void {
  const secret = env.CRON_SECRET;
  if (!secret) throw new Error("unauthorized_cron");

  const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const cron = req.headers.get("x-vercel-cron-secret");
  const provided = auth || cron;

  if (!provided || provided !== secret) {
    throw new Error("unauthorized_cron");
  }
}
