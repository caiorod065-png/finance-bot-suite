#!/usr/bin/env node

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:8080';
const adminToken = process.env.ADMIN_TOKEN ?? '';
const keepSuffixes = (process.env.KEEP_SUFFIXES ?? '1547,7750')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const dryRun = String(process.env.DRY_RUN ?? 'false').toLowerCase() === 'true';

if (!adminToken) {
  console.error('ADMIN_TOKEN ausente. Exemplo: ADMIN_TOKEN=... node scripts/cleanup-customers.mjs');
  process.exit(1);
}

function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function shouldKeep(number) {
  const digits = digitsOnly(number);
  return keepSuffixes.some((suffix) => digits.endsWith(suffix));
}

async function call(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      'x-admin-token': adminToken,
      ...(options.headers ?? {})
    }
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${path}: ${JSON.stringify(data).slice(0, 300)}`);
  }

  return data;
}

async function run() {
  const customers = await call('/admin/customers');
  const keep = customers.filter((item) => shouldKeep(item.whatsappNumber));
  const remove = customers.filter((item) => !shouldKeep(item.whatsappNumber));

  let deleted = 0;
  if (!dryRun) {
    for (const customer of remove) {
      await call(`/admin/customers/${customer.id}`, { method: 'DELETE' });
      deleted += 1;
    }
  }

  console.log(JSON.stringify({
    apiBaseUrl,
    dryRun,
    keepSuffixes,
    totalBefore: customers.length,
    keepCount: keep.length,
    removeCount: remove.length,
    deleted,
    keptCustomers: keep.map((item) => ({
      id: item.id,
      name: item.name,
      whatsappNumber: item.whatsappNumber
    }))
  }, null, 2));
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

