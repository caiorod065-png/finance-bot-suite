import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { estimateOpenAiLocalCostMtd } from './openai-usage.js';

type ProviderStatus = 'ok' | 'missing_config' | 'error';
type ProviderSource = 'api' | 'fixed' | 'local_estimate';

type ProviderCost = {
  provider: 'openai' | 'twilio' | 'supabase' | 'infra' | 'other';
  source: ProviderSource;
  status: ProviderStatus;
  mtdUsd: number;
  projectedUsd: number;
  monthlyUsd?: number;
  note?: string;
};

type PeriodInfo = {
  month: number;
  year: number;
  dayOfMonth: number;
  daysInMonth: number;
  startIso: string;
  endIso: string;
};

export type CostsOverview = {
  period: {
    year: number;
    month: number;
    dayOfMonth: number;
    daysInMonth: number;
    generatedAt: string;
  };
  fxUsdBrlRate: number;
  providers: ProviderCost[];
  totals: {
    mtdUsd: number;
    projectedUsd: number;
    mtdBrlCents: number;
    projectedBrlCents: number;
  };
  revenue: {
    mtdBrlCents: number;
    projectedBrlCents: number;
    mrrBrlCents: number;
  };
  profit: {
    mtdBrlCents: number;
    projectedBrlCents: number;
  };
};

export type PreviousMonthCostsSnapshot = {
  snapshotDate: string;
  overview: CostsOverview;
};

type SnapshotRow = {
  snapshot_date: string;
  payload: CostsOverview;
  created_at: string;
};

let schemaReady: Promise<void> | null = null;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toBrlCentsFromUsd(usd: number, fx: number): number {
  return Math.round(usd * fx * 100);
}

function monthInfo(now = new Date()): PeriodInfo {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(year, month, 0).getDate();
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month - 1, dayOfMonth, 23, 59, 59, 999);

  return {
    year,
    month,
    dayOfMonth,
    daysInMonth,
    startIso: start.toISOString(),
    endIso: end.toISOString()
  };
}

function projectionFromMtd(mtd: number, dayOfMonth: number, daysInMonth: number): number {
  if (dayOfMonth <= 0) return 0;
  return round2((mtd / dayOfMonth) * daysInMonth);
}

function fixedMtdFromMonthly(monthly: number, dayOfMonth: number, daysInMonth: number): number {
  if (monthly <= 0 || dayOfMonth <= 0 || daysInMonth <= 0) return 0;
  return round2((monthly / daysInMonth) * dayOfMonth);
}

function parseNumeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const obj = payload as Record<string, unknown>;

  const errorField = obj.error;
  if (typeof errorField === 'string' && errorField.trim()) {
    return errorField.trim();
  }

  if (errorField && typeof errorField === 'object') {
    const errorObj = errorField as Record<string, unknown>;
    if (typeof errorObj.message === 'string' && errorObj.message.trim()) {
      return errorObj.message.trim();
    }
    if (typeof errorObj.code === 'string' && errorObj.code.trim()) {
      return errorObj.code.trim();
    }
  }

  if (typeof obj.message === 'string' && obj.message.trim()) {
    return obj.message.trim();
  }

  return fallback;
}

function isLocalEstimateUnavailable(note: string): boolean {
  return note.toLowerCase().startsWith('falha ao estimar');
}

function genericOpenAiBillingUnavailableNote(localNote: string): string {
  return `Endpoint oficial de billing da OpenAI indisponível no momento. ${localNote}`;
}

function sumOpenAiCostValues(payload: unknown): number {
  let total = 0;

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }

    const obj = node as Record<string, unknown>;

    if (obj.amount && typeof obj.amount === 'object') {
      const amountObj = obj.amount as Record<string, unknown>;
      const value = parseNumeric(amountObj.value);
      if (value !== null) {
        total += value;
      }
    }

    for (const value of Object.values(obj)) {
      walk(value);
    }
  };

  walk(payload);
  return round2(total);
}

async function fetchOpenAiCostMtd(period: PeriodInfo): Promise<ProviderCost> {
  if (!config.openAiAdminKey) {
    const localEstimate = await estimateOpenAiLocalCostMtd(period.startIso, period.endIso);
    if (localEstimate.mtdUsd > 0) {
      return {
        provider: 'openai',
        source: 'local_estimate',
        status: 'ok',
        mtdUsd: localEstimate.mtdUsd,
        projectedUsd: projectionFromMtd(localEstimate.mtdUsd, period.dayOfMonth, period.daysInMonth),
        note: `OPENAI_ADMIN_KEY ausente. ${localEstimate.note}`
      };
    }
    if (config.costOpenAiMonthlyUsd > 0) {
      return fixedProviderCost(
        'openai',
        config.costOpenAiMonthlyUsd,
        period,
        'Fallback manual: OPENAI_ADMIN_KEY ausente'
      );
    }
    return {
      provider: 'openai',
      source: 'local_estimate',
      status: 'missing_config',
      mtdUsd: 0,
      projectedUsd: 0,
      note: 'OPENAI_ADMIN_KEY ausente e sem eventos locais para estimativa'
    };
  }

  if (!config.openAiApiKey) {
    if (config.costOpenAiMonthlyUsd > 0) {
      return fixedProviderCost(
        'openai',
        config.costOpenAiMonthlyUsd,
        period,
        'Fallback manual: OPENAI_API_KEY ausente'
      );
    }
    return {
      provider: 'openai',
      source: 'api',
      status: 'missing_config',
      mtdUsd: 0,
      projectedUsd: 0,
      note: 'OPENAI_API_KEY ausente'
    };
  }

  if (!config.openAiOrganizationId) {
    const localEstimate = await estimateOpenAiLocalCostMtd(period.startIso, period.endIso);
    if (localEstimate.mtdUsd > 0) {
      return {
        provider: 'openai',
        source: 'local_estimate',
        status: 'ok',
        mtdUsd: localEstimate.mtdUsd,
        projectedUsd: projectionFromMtd(localEstimate.mtdUsd, period.dayOfMonth, period.daysInMonth),
        note: `OPENAI_ORG_ID ausente. ${localEstimate.note}`
      };
    }
    if (config.costOpenAiMonthlyUsd > 0) {
      return fixedProviderCost(
        'openai',
        config.costOpenAiMonthlyUsd,
        period,
        'Fallback manual: OPENAI_ORG_ID ausente'
      );
    }
    return {
      provider: 'openai',
      source: 'local_estimate',
      status: 'missing_config',
      mtdUsd: 0,
      projectedUsd: 0,
      note: 'OPENAI_ORG_ID ausente e sem eventos locais para estimativa'
    };
  }

  const startTime = Math.floor(new Date(period.startIso).getTime() / 1000);
  const endTime = Math.floor(Date.now() / 1000);
  const url = new URL('https://api.openai.com/v1/organization/costs');
  url.searchParams.set('start_time', String(startTime));
  url.searchParams.set('end_time', String(endTime));
  url.searchParams.set('bucket_width', '1d');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.openAiAdminKey}`
  };
  if (config.openAiOrganizationId) {
    headers['OpenAI-Organization'] = config.openAiOrganizationId;
  }

  try {
    const response = await fetch(url, { headers });
    const rawText = await response.text();
    const data = rawText ? JSON.parse(rawText) : {};

    if (!response.ok) {
      const message = extractErrorMessage(data, `HTTP ${response.status}`);
      const localEstimate = await estimateOpenAiLocalCostMtd(period.startIso, period.endIso);
      if (!isLocalEstimateUnavailable(localEstimate.note)) {
        return {
          provider: 'openai',
          source: 'local_estimate',
          status: 'ok',
          mtdUsd: localEstimate.mtdUsd,
          projectedUsd: projectionFromMtd(localEstimate.mtdUsd, period.dayOfMonth, period.daysInMonth),
          note: genericOpenAiBillingUnavailableNote(localEstimate.note)
        };
      }
      if (config.costOpenAiMonthlyUsd > 0) {
        return fixedProviderCost('openai', config.costOpenAiMonthlyUsd, period, `Fallback manual: ${message}`);
      }
      return {
        provider: 'openai',
        source: 'api',
        status: 'error',
        mtdUsd: 0,
        projectedUsd: 0,
        note: `OpenAI billing indisponível no momento (${response.status}).`
      };
    }

    const mtdUsd = sumOpenAiCostValues(data);
    return {
      provider: 'openai',
      source: 'api',
      status: 'ok',
      mtdUsd,
      projectedUsd: projectionFromMtd(mtdUsd, period.dayOfMonth, period.daysInMonth)
    };
  } catch (error) {
    const localEstimate = await estimateOpenAiLocalCostMtd(period.startIso, period.endIso);
    if (!isLocalEstimateUnavailable(localEstimate.note)) {
      return {
        provider: 'openai',
        source: 'local_estimate',
        status: 'ok',
        mtdUsd: localEstimate.mtdUsd,
        projectedUsd: projectionFromMtd(localEstimate.mtdUsd, period.dayOfMonth, period.daysInMonth),
        note: genericOpenAiBillingUnavailableNote(localEstimate.note)
      };
    }
    if (config.costOpenAiMonthlyUsd > 0) {
      return fixedProviderCost(
        'openai',
        config.costOpenAiMonthlyUsd,
        period,
        `Fallback manual: ${error instanceof Error ? error.message : 'falha ao consultar OpenAI'}`
      );
    }
    return {
      provider: 'openai',
      source: 'api',
      status: 'error',
      mtdUsd: 0,
      projectedUsd: 0,
      note: error instanceof Error ? error.message : 'Falha ao consultar OpenAI'
    };
  }
}

async function fetchTwilioCostMtd(period: PeriodInfo): Promise<ProviderCost> {
  if (!config.twilioAccountSid || !config.twilioAuthToken) {
    if (config.costTwilioMonthlyUsd > 0) {
      return fixedProviderCost(
        'twilio',
        config.costTwilioMonthlyUsd,
        period,
        'Fallback manual: credenciais Twilio ausentes'
      );
    }
    return {
      provider: 'twilio',
      source: 'api',
      status: 'missing_config',
      mtdUsd: 0,
      projectedUsd: 0,
      note: 'TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN ausentes'
    };
  }

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Usage/Records/ThisMonth.json?Category=totalprice`;
  const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64');

  try {
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Basic ${auth}`
      }
    });
    const rawText = await response.text();
    const data = rawText ? JSON.parse(rawText) : {};

    if (!response.ok) {
      const message = extractErrorMessage(data, `HTTP ${response.status}`);
      if (config.costTwilioMonthlyUsd > 0) {
        return fixedProviderCost(
          'twilio',
          config.costTwilioMonthlyUsd,
          period,
          `Fallback manual: ${message}`
        );
      }
      return {
        provider: 'twilio',
        source: 'api',
        status: 'error',
        mtdUsd: 0,
        projectedUsd: 0,
        note: message
      };
    }

    const records = Array.isArray(data?.usage_records) ? data.usage_records : [];
    const priceValues = records
      .map((item: Record<string, unknown>) => parseNumeric(item.price))
      .filter((item: number | null): item is number => item !== null);
    const rawCost = priceValues.reduce((sum: number, item: number) => sum + item, 0);

    // Twilio costuma retornar custos como número negativo.
    const mtdUsd = round2(Math.abs(rawCost));
    return {
      provider: 'twilio',
      source: 'api',
      status: 'ok',
      mtdUsd,
      projectedUsd: projectionFromMtd(mtdUsd, period.dayOfMonth, period.daysInMonth)
    };
  } catch (error) {
    if (config.costTwilioMonthlyUsd > 0) {
      return fixedProviderCost(
        'twilio',
        config.costTwilioMonthlyUsd,
        period,
        `Fallback manual: ${error instanceof Error ? error.message : 'falha ao consultar Twilio'}`
      );
    }
    return {
      provider: 'twilio',
      source: 'api',
      status: 'error',
      mtdUsd: 0,
      projectedUsd: 0,
      note: error instanceof Error ? error.message : 'Falha ao consultar Twilio'
    };
  }
}

function fixedProviderCost(
  provider: 'openai' | 'twilio' | 'supabase' | 'infra' | 'other',
  monthlyUsd: number,
  period: PeriodInfo,
  note?: string
): ProviderCost {
  const monthly = Number.isFinite(monthlyUsd) && monthlyUsd > 0 ? monthlyUsd : 0;
  return {
    provider,
    source: 'fixed',
    status: monthly > 0 ? 'ok' : 'missing_config',
    monthlyUsd: round2(monthly),
    mtdUsd: fixedMtdFromMonthly(monthly, period.dayOfMonth, period.daysInMonth),
    projectedUsd: round2(monthly),
    note: monthly > 0 ? note : 'Custo fixo não configurado'
  };
}

async function revenueMtdAndMrr(period: PeriodInfo): Promise<{ mtdBrlCents: number; mrrBrlCents: number }> {
  const monthStart = `${period.year}-${String(period.month).padStart(2, '0')}-01`;
  const nextMonth = period.month === 12
    ? `${period.year + 1}-01-01`
    : `${period.year}-${String(period.month + 1).padStart(2, '0')}-01`;

  const paidRes = await pool.query<{ total_cents: string }>(
    `SELECT COALESCE(SUM(amount_cents), 0)::text AS total_cents
       FROM payments
      WHERE status = 'paid'
        AND COALESCE(paid_at, created_at) >= $1::date
        AND COALESCE(paid_at, created_at) < $2::date`,
    [monthStart, nextMonth]
  );

  const mrrRes = await pool.query<{ mrr_cents: string }>(
    `SELECT COALESCE(SUM(
              CASE
                WHEN referral_count >= referral_threshold THEN discounted_monthly_fee_cents
                ELSE base_monthly_fee_cents
              END
            ), 0)::text AS mrr_cents
       FROM subscriptions
      WHERE status = 'active'`
  );

  return {
    mtdBrlCents: Number(paidRes.rows[0]?.total_cents ?? '0'),
    mrrBrlCents: Number(mrrRes.rows[0]?.mrr_cents ?? '0')
  };
}

async function ensureCostsSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ops_cost_snapshots (
          id BIGSERIAL PRIMARY KEY,
          snapshot_date DATE NOT NULL UNIQUE,
          payload JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }

  await schemaReady;
}

export async function costOverview(): Promise<CostsOverview> {
  const period = monthInfo(new Date());
  const fxUsdBrlRate = Number.isFinite(config.costUsdBrlRate) && config.costUsdBrlRate > 0
    ? config.costUsdBrlRate
    : 5.5;

  const [openai, twilio, revenue] = await Promise.all([
    fetchOpenAiCostMtd(period),
    fetchTwilioCostMtd(period),
    revenueMtdAndMrr(period)
  ]);

  const supabase = fixedProviderCost('supabase', config.costSupabaseMonthlyUsd, period);
  const infra = fixedProviderCost('infra', config.costInfraMonthlyUsd, period);
  const other = fixedProviderCost('other', config.costOtherMonthlyUsd, period);

  const providers = [openai, twilio, supabase, infra, other];
  const mtdUsd = round2(providers.reduce((sum, item) => sum + item.mtdUsd, 0));
  const projectedUsd = round2(providers.reduce((sum, item) => sum + item.projectedUsd, 0));

  const projectedRevenueBrlCents = Math.max(
    Math.round((revenue.mtdBrlCents / Math.max(period.dayOfMonth, 1)) * period.daysInMonth),
    revenue.mrrBrlCents
  );

  const mtdCostBrlCents = toBrlCentsFromUsd(mtdUsd, fxUsdBrlRate);
  const projectedCostBrlCents = toBrlCentsFromUsd(projectedUsd, fxUsdBrlRate);

  return {
    period: {
      year: period.year,
      month: period.month,
      dayOfMonth: period.dayOfMonth,
      daysInMonth: period.daysInMonth,
      generatedAt: new Date().toISOString()
    },
    fxUsdBrlRate,
    providers,
    totals: {
      mtdUsd,
      projectedUsd,
      mtdBrlCents: mtdCostBrlCents,
      projectedBrlCents: projectedCostBrlCents
    },
    revenue: {
      mtdBrlCents: revenue.mtdBrlCents,
      projectedBrlCents: projectedRevenueBrlCents,
      mrrBrlCents: revenue.mrrBrlCents
    },
    profit: {
      mtdBrlCents: revenue.mtdBrlCents - mtdCostBrlCents,
      projectedBrlCents: projectedRevenueBrlCents - projectedCostBrlCents
    }
  };
}

export async function saveDailyCostSnapshot(): Promise<{ ok: true; snapshotDate: string; overview: CostsOverview }> {
  await ensureCostsSchema();
  const overview = await costOverview();
  const snapshotDate = `${overview.period.year}-${String(overview.period.month).padStart(2, '0')}-${String(overview.period.dayOfMonth).padStart(2, '0')}`;

  await pool.query(
    `INSERT INTO ops_cost_snapshots (snapshot_date, payload)
     VALUES ($1::date, $2::jsonb)
     ON CONFLICT (snapshot_date)
     DO UPDATE SET payload = EXCLUDED.payload, created_at = NOW()`,
    [snapshotDate, JSON.stringify(overview)]
  );

  return { ok: true, snapshotDate, overview };
}

export async function listCostSnapshots(limit = 30): Promise<Array<{
  snapshotDate: string;
  createdAt: string;
  totals: {
    mtdUsd: number;
    projectedUsd: number;
    mtdBrlCents: number;
    projectedBrlCents: number;
  };
  profit: {
    mtdBrlCents: number;
    projectedBrlCents: number;
  };
}>> {
  await ensureCostsSchema();
  const safeLimit = Math.min(120, Math.max(1, Math.trunc(limit)));

  const res = await pool.query<SnapshotRow>(
    `SELECT snapshot_date::text, payload, created_at::text
       FROM ops_cost_snapshots
      ORDER BY snapshot_date DESC
      LIMIT $1`,
    [safeLimit]
  );

  return res.rows.map((row) => ({
    snapshotDate: row.snapshot_date,
    createdAt: row.created_at,
    totals: row.payload?.totals ?? {
      mtdUsd: 0,
      projectedUsd: 0,
      mtdBrlCents: 0,
      projectedBrlCents: 0
    },
    profit: row.payload?.profit ?? {
      mtdBrlCents: 0,
      projectedBrlCents: 0
    }
  }));
}

export async function latestPreviousMonthCostsSnapshot(reference = new Date()): Promise<PreviousMonthCostsSnapshot | null> {
  await ensureCostsSchema();

  const year = reference.getFullYear();
  const month = reference.getMonth() + 1;
  const currentMonthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const previousMonthStart = month === 1
    ? `${year - 1}-12-01`
    : `${year}-${String(month - 1).padStart(2, '0')}-01`;

  const res = await pool.query<SnapshotRow>(
    `SELECT snapshot_date::text, payload, created_at::text
       FROM ops_cost_snapshots
      WHERE snapshot_date >= $1::date
        AND snapshot_date < $2::date
      ORDER BY snapshot_date DESC
      LIMIT 1`,
    [previousMonthStart, currentMonthStart]
  );

  const row = res.rows[0];
  if (!row?.payload) return null;

  return {
    snapshotDate: row.snapshot_date,
    overview: row.payload
  };
}
