#!/usr/bin/env node

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:8080';
const adminToken = process.env.ADMIN_TOKEN ?? '';

if (!adminToken) {
  console.error('ADMIN_TOKEN ausente. Exemplo: ADMIN_TOKEN=... node scripts/migrate-plan-pricing.mjs --dry-run');
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    includeFree: false,
    skipCanceled: true,
    customerLimit: undefined,
    planCodes: undefined
  };

  for (const token of argv) {
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (token === '--include-free') {
      args.includeFree = true;
      continue;
    }
    if (token === '--include-canceled') {
      args.skipCanceled = false;
      continue;
    }
    if (token.startsWith('--limit=')) {
      const raw = token.slice('--limit='.length);
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.customerLimit = Math.floor(parsed);
      }
      continue;
    }
    if (token.startsWith('--plans=')) {
      const raw = token.slice('--plans='.length).trim();
      const list = raw
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
      if (list.length > 0) {
        args.planCodes = list;
      }
      continue;
    }
  }

  return args;
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${path}: ${JSON.stringify(body).slice(0, 600)}`);
  }
  return body;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const payload = {
    skipCanceled: args.skipCanceled,
    includeFree: args.includeFree,
    dryRun: args.dryRun,
    customerLimit: args.customerLimit,
    planCodes: args.planCodes
  };

  const data = await requestJson('/admin/subscriptions/migrate-pricing', {
    method: 'POST',
    headers: {
      'x-admin-token': adminToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const result = data?.result ?? {};
  console.log('\n[migrate-plan-pricing]');
  console.log(`dryRun: ${Boolean(result.dryRun)}`);
  console.log(`scanned: ${Number(result.scanned ?? 0)}`);
  console.log(`wouldUpdate: ${Number(result.wouldUpdate ?? 0)}`);
  console.log(`updated: ${Number(result.updated ?? 0)}`);
  console.log(`skipped: ${Number(result.skipped ?? 0)}`);
  console.log(`filters: ${JSON.stringify(result.filters ?? {}, null, 2)}`);

  const sample = Array.isArray(result.sample) ? result.sample.slice(0, 10) : [];
  if (sample.length > 0) {
    console.log('\n[sample]');
    for (const row of sample) {
      console.log(
        `- ${row.customerId} | ${row.planCode} | ${row.action} | base ${row.before?.baseMonthlyFeeCents} -> ${row.expected?.baseMonthlyFeeCents}`
      );
    }
  }
}

main().catch((error) => {
  console.error('\nFalha ao migrar preços/limites de planos.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

