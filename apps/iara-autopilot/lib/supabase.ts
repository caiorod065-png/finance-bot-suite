import { createClient } from "@supabase/supabase-js";
import { assertRuntimeEnv, env } from "@/lib/env";

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

export function ensureSupabaseConfigured(): void {
  assertRuntimeEnv();
}
