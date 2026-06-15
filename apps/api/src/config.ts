import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const apiRootDir = path.resolve(currentDir, '..');
const repoRootDir = path.resolve(apiRootDir, '..', '..');

dotenv.config({ path: '/app/.env' });
dotenv.config({ path: path.join(repoRootDir, '.env') });
dotenv.config({ path: path.join(apiRootDir, '.env') });
dotenv.config();

const INSECURE_DEFAULTS = new Set(['change-me', 'dev-only-change-this-jwt-secret', 'dev-only-change-me']);

function required(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (!value) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  if (INSECURE_DEFAULTS.has(value.trim())) {
    throw new Error(`Environment variable ${key} is set to an insecure default value. Set a secure value before starting.`);
  }
  return value;
}

function normalizedEnv(key: string, fallback = ''): string {
  const raw = process.env[key] ?? fallback;
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'sim', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'nao', 'não', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePhoneList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n;]+/)
    .map((item) => item.replace(/\D/g, ''))
    .filter((item) => item.length >= 8);
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required('DATABASE_URL'),
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  openAiAdminKey: normalizedEnv('OPENAI_ADMIN_KEY', ''),
  openAiOrganizationId: normalizedEnv('OPENAI_ORG_ID', ''),
  openAiModel: normalizedEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
  openAiAgentModel: normalizedEnv('OPENAI_AGENT_MODEL', normalizedEnv('OPENAI_MODEL', 'gpt-4.1-mini')),
  openAiAgentTemperature: Number(process.env.OPENAI_AGENT_TEMPERATURE ?? 0.82),
  adminToken: required('ADMIN_TOKEN'),
  adminEmail: normalizedEnv('ADMIN_EMAIL', 'owner@finance-bot.local').toLowerCase(),
  adminPassword: normalizedEnv('ADMIN_PASSWORD', ''),
  adminJwtSecret: required('ADMIN_JWT_SECRET'),
  adminJwtExpiresMinutes: Number(process.env.ADMIN_JWT_EXPIRES_MINUTES ?? 720),
  defaultTimezone: process.env.DEFAULT_TIMEZONE ?? 'America/Sao_Paulo',
  asaasApiKey: normalizedEnv('ASAAS_API_KEY', ''),
  asaasBaseUrl: normalizedEnv('ASAAS_BASE_URL', 'https://api.asaas.com'),
  asaasWebhookToken: normalizedEnv('ASAAS_WEBHOOK_TOKEN', ''),
  whatsappToken: normalizedEnv('WHATSAPP_TOKEN', ''),
  whatsappPhoneNumberId: normalizedEnv('WHATSAPP_PHONE_NUMBER_ID', ''),
  whatsappVerifyToken: normalizedEnv('WHATSAPP_VERIFY_TOKEN', ''),
  whatsappAppSecret: normalizedEnv('WHATSAPP_APP_SECRET', ''),
  twilioAccountSid: normalizedEnv('TWILIO_ACCOUNT_SID', ''),
  twilioAuthToken: normalizedEnv('TWILIO_AUTH_TOKEN', ''),
  twilioWhatsappFrom: normalizedEnv('TWILIO_WHATSAPP_FROM', ''),
  twilioWhatsappTemplateSid: normalizedEnv('TWILIO_WHATSAPP_TEMPLATE_SID', ''),
  twilioTemplateOutside24hEnabled: toBool(process.env.TWILIO_TEMPLATE_OUTSIDE_24H_ENABLED, true),
  metaWhatsappTemplateName: normalizedEnv('META_WHATSAPP_TEMPLATE_NAME', ''),
  ownerWhatsappNumbers: parsePhoneList(process.env.OWNER_WHATSAPP_NUMBERS),
  ownerDailyReportEnabled: toBool(process.env.OWNER_DAILY_REPORT_ENABLED, true),
  ownerDailyReportHour: Math.max(0, Math.min(23, Number(process.env.OWNER_DAILY_REPORT_HOUR ?? 8))),
  ownerDailyReportMinute: Math.max(0, Math.min(59, Number(process.env.OWNER_DAILY_REPORT_MINUTE ?? 5))),
  proactiveAutomationEnabled: toBool(process.env.PROACTIVE_AUTOMATION_ENABLED, true),
  proactiveAutomationIntervalMinutes: Number(process.env.PROACTIVE_AUTOMATION_INTERVAL_MINUTES ?? 5),
  proactiveAutomationStartupDelaySeconds: Number(process.env.PROACTIVE_AUTOMATION_STARTUP_DELAY_SECONDS ?? 20),
  proactiveAutomationCustomerLimit: Number(process.env.PROACTIVE_AUTOMATION_CUSTOMER_LIMIT ?? 1000),
  costUsdBrlRate: Number(process.env.COST_USD_BRL_RATE ?? 5.5),
  costOpenAiMonthlyUsd: Number(process.env.COST_OPENAI_MONTHLY_USD ?? 0),
  costTwilioMonthlyUsd: Number(process.env.COST_TWILIO_MONTHLY_USD ?? 0),
  costSupabaseMonthlyUsd: Number(process.env.COST_SUPABASE_MONTHLY_USD ?? 25),
  costInfraMonthlyUsd: Number(process.env.COST_INFRA_MONTHLY_USD ?? 0),
  costOtherMonthlyUsd: Number(process.env.COST_OTHER_MONTHLY_USD ?? 0),
  pluggyClientId: normalizedEnv('PLUGGY_CLIENT_ID', ''),
  pluggyClientSecret: normalizedEnv('PLUGGY_CLIENT_SECRET', ''),
  pluggyWebhookSecret: normalizedEnv('PLUGGY_WEBHOOK_SECRET', ''),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};
