#!/usr/bin/env node

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:8080';
const adminToken = process.env.ADMIN_TOKEN ?? '';
const generatedSuffix = String(Date.now()).slice(-8);
const sandboxFrom = process.env.SANDBOX_FROM ?? `55119990${generatedSuffix}`;
const sandboxName = process.env.SANDBOX_NAME ?? 'Cliente Sandbox';

if (!adminToken) {
  console.error('ADMIN_TOKEN ausente. Configure no .env antes de rodar.');
  process.exit(1);
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
    throw new Error(`${response.status} ${response.statusText} em ${path}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function postWebhookText(text) {
  return requestJson('/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: sandboxFrom,
      name: sandboxName,
      text
    })
  });
}

function printStep(title, payload) {
  const reply = payload?.replyText ?? JSON.stringify(payload);
  console.log(`\n[${title}]`);
  console.log(reply);
}

async function run() {
  console.log(`Sandbox local em ${apiBaseUrl}`);
  console.log(`Numero simulado: ${sandboxFrom}`);

  try {
    await requestJson('/health');
  } catch {
    throw new Error(
      `API indisponivel em ${apiBaseUrl}. Inicie com: cd apps/api && npm run dev`
    );
  }

  // Garante criação do cliente.
  const first = await postWebhookText('oi');
  printStep('mensagem inicial', first);

  const customers = await requestJson('/admin/customers', {
    headers: { 'x-admin-token': adminToken }
  });

  const customer = customers.find((item) => item.whatsappNumber === sandboxFrom);
  if (!customer?.id) {
    throw new Error('Cliente de sandbox não encontrado na listagem admin.');
  }

  await requestJson(`/admin/customers/${customer.id}/subscription/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': adminToken
    },
    body: JSON.stringify({
      paymentType: 'setup',
      gateway: 'sandbox',
      externalReference: `sandbox-setup-${Date.now()}`
    })
  });

  await requestJson(`/admin/customers/${customer.id}/subscription/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': adminToken
    },
    body: JSON.stringify({
      paymentType: 'monthly',
      gateway: 'sandbox',
      externalReference: `sandbox-monthly-${Date.now()}`
    })
  });

  printStep(
    'lancar gasto 1',
    await postWebhookText('hoje gastei 300 reais no supermercado para compra do mes')
  );
  printStep(
    'lancar gasto 2',
    await postWebhookText('gastei 120 no shopping agora')
  );
  printStep(
    'corrigir valor',
    await postWebhookText('corrige supermercado, era 300 e foi 253,50')
  );
  printStep(
    'apagar ultimo gasto',
    await postWebhookText('apaga meu ultimo gasto')
  );
  printStep(
    'resumo do mes',
    await postWebhookText('me passa o resumo do mes')
  );

  const tx = await requestJson(`/admin/customers/${customer.id}/transactions`, {
    headers: { 'x-admin-token': adminToken }
  });
  console.log(`\n[transacoes registradas] ${tx.length}`);

  const metrics = await requestJson('/admin/metrics', {
    headers: { 'x-admin-token': adminToken }
  });
  console.log(
    `[metricas] clientes ativos: ${metrics.activeCustomers} | clientes online 24h: ${metrics.customersOnline24h}`
  );
}

run().catch((error) => {
  console.error('\nFalha no sandbox local.');
  console.error(error.message);
  process.exit(1);
});
