import { pool } from '../db/pool.js';

type ModelRate = {
  inputUsdPer1m: number;
  cachedInputUsdPer1m: number;
  outputUsdPer1m: number;
};

type UsageRow = {
  model: string;
  input_tokens: string;
  output_tokens: string;
  cached_input_tokens: string;
};

const MODEL_RATES: Array<{ match: RegExp; rates: ModelRate }> = [
  {
    match: /\bgpt-4\.1-mini\b/i,
    rates: { inputUsdPer1m: 0.8, cachedInputUsdPer1m: 0.2, outputUsdPer1m: 3.2 }
  },
  {
    match: /\bgpt-4\.1-nano\b/i,
    rates: { inputUsdPer1m: 0.2, cachedInputUsdPer1m: 0.05, outputUsdPer1m: 0.8 }
  },
  {
    match: /\bgpt-4\.1\b/i,
    rates: { inputUsdPer1m: 3, cachedInputUsdPer1m: 0.75, outputUsdPer1m: 12 }
  }
];

const DEFAULT_RATES: ModelRate = { inputUsdPer1m: 0.8, cachedInputUsdPer1m: 0.2, outputUsdPer1m: 3.2 };

let schemaReady: Promise<void> | null = null;

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function getNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function resolveModelRates(model: string): ModelRate {
  const found = MODEL_RATES.find((entry) => entry.match.test(model));
  return found ? found.rates : DEFAULT_RATES;
}

async function ensureUsageSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ai_usage_events (
          id BIGSERIAL PRIMARY KEY,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cached_input_tokens INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_ai_usage_events_provider_created_at
        ON ai_usage_events (provider, created_at DESC)
      `);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }

  await schemaReady;
}

export async function recordOpenAiUsageFromResponse(response: unknown, fallbackModel: string): Promise<void> {
  try {
    const obj = response as Record<string, unknown> | null;
    if (!obj || typeof obj !== 'object') return;

    const usage = obj.usage as Record<string, unknown> | undefined;
    const modelRaw = typeof obj.model === 'string' && obj.model.trim().length > 0
      ? obj.model
      : fallbackModel;
    const model = modelRaw.trim();

    const inputTokens = Math.max(
      0,
      Math.round(getNumber(usage?.input_tokens ?? usage?.inputTokens))
    );
    const outputTokens = Math.max(
      0,
      Math.round(getNumber(usage?.output_tokens ?? usage?.outputTokens))
    );

    const inputDetails = usage?.input_tokens_details as Record<string, unknown> | undefined;
    const inputDetailsCamel = usage?.inputTokensDetails as Record<string, unknown> | undefined;
    const cachedInputTokens = Math.max(
      0,
      Math.round(
        getNumber(
          inputDetails?.cached_tokens ??
          inputDetails?.cachedTokens ??
          inputDetailsCamel?.cached_tokens ??
          inputDetailsCamel?.cachedTokens
        )
      )
    );

    if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) return;

    await ensureUsageSchema();
    await pool.query(
      `INSERT INTO ai_usage_events (provider, model, input_tokens, output_tokens, cached_input_tokens)
       VALUES ('openai', $1, $2, $3, $4)`,
      [model, inputTokens, outputTokens, cachedInputTokens]
    );
  } catch {
    // Best effort: never fail webhook due to usage logging.
  }
}

export async function estimateOpenAiLocalCostMtd(startIso: string, endIso: string): Promise<{
  mtdUsd: number;
  note: string;
}> {
  try {
    await ensureUsageSchema();
    const res = await pool.query<UsageRow>(
      `SELECT model,
              COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
              COALESCE(SUM(cached_input_tokens), 0)::text AS cached_input_tokens
         FROM ai_usage_events
        WHERE provider = 'openai'
          AND created_at >= $1::timestamptz
          AND created_at <= $2::timestamptz
        GROUP BY model`,
      [startIso, endIso]
    );

    if (res.rows.length === 0) {
      return { mtdUsd: 0, note: 'Estimativa local sem eventos de uso no período' };
    }

    let total = 0;
    for (const row of res.rows) {
      const rates = resolveModelRates(row.model);
      const inputTokens = Math.max(0, Number(row.input_tokens));
      const outputTokens = Math.max(0, Number(row.output_tokens));
      const cachedInputTokens = Math.max(0, Number(row.cached_input_tokens));
      const billableInputTokens = Math.max(inputTokens - cachedInputTokens, 0);

      const modelCost =
        (billableInputTokens / 1_000_000) * rates.inputUsdPer1m +
        (cachedInputTokens / 1_000_000) * rates.cachedInputUsdPer1m +
        (outputTokens / 1_000_000) * rates.outputUsdPer1m;

      total += modelCost;
    }

    return {
      mtdUsd: round6(total),
      note: 'Estimativa local por tokens do bot (não inclui uso fora deste servidor)'
    };
  } catch {
    return { mtdUsd: 0, note: 'Falha ao estimar custo local OpenAI' };
  }
}
