#!/usr/bin/env node

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:8080';
const adminToken = process.env.ADMIN_TOKEN ?? '';
const from = process.env.SANDBOX_FROM ?? `55117777${String(Date.now()).slice(-8)}`;
const name = process.env.SANDBOX_NAME ?? 'Teste Sprints';

if (!adminToken) {
  console.error('ADMIN_TOKEN ausente. Exemplo: ADMIN_TOKEN=... node scripts/sprints-regression-test.mjs');
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
    throw new Error(`${response.status} ${path}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

async function sendTwilioText(text) {
  const body = new URLSearchParams({
    From: `whatsapp:+${from}`,
    WaId: from,
    Body: text,
    ProfileName: name
  });
  const response = await fetch(`${apiBaseUrl}/webhooks/whatsapp/twilio`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const xml = await response.text();
  const match = xml.match(/<Message>([\s\S]*?)<\/Message>/i);
  return (match ? match[1] : xml)
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', '\'');
}

function printStep(label, content) {
  console.log(`\n[${label}]`);
  console.log(content);
}

function expectContains(text, expected, context) {
  if (!text.toLowerCase().includes(expected.toLowerCase())) {
    throw new Error(`Validação falhou em "${context}". Esperado conter: "${expected}". Resposta: "${text.slice(0, 260)}"`);
  }
}

async function run() {
  await requestJson('/health');

  await sendTwilioText('oi');
  const customers = await requestJson('/admin/customers', {
    headers: { 'x-admin-token': adminToken }
  });
  const customer = customers.find((item) => item.whatsappNumber === from);
  if (!customer?.id) {
    throw new Error('Cliente de teste não encontrado.');
  }

  await requestJson(`/admin/customers/${customer.id}/subscription/payments`, {
    method: 'POST',
    headers: {
      'x-admin-token': adminToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      paymentType: 'setup',
      gateway: 'sandbox',
      externalReference: `sprint-setup-${Date.now()}`
    })
  });

  await requestJson(`/admin/customers/${customer.id}/subscription/payments`, {
    method: 'POST',
    headers: {
      'x-admin-token': adminToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      paymentType: 'monthly',
      gateway: 'sandbox',
      externalReference: `sprint-monthly-${Date.now()}`
    })
  });

  await requestJson(`/admin/customers/${customer.id}/subscription/plan`, {
    method: 'POST',
    headers: {
      'x-admin-token': adminToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      planCode: 'family'
    })
  });

  const checks = [
    'meta 5000 para viagem até 31/12/2026',
    'minhas metas',
    'lembrete aluguel vence 20/03 lembrar 3 dias antes',
    'meus lembretes',
    'hoje gastei 120 no mercado',
    'insights do mês',
    'assinaturas',
    'previsão de saldo',
    'simular investimento 300 por mês por 24 meses a 1% ao mês',
    'meu plano',
    'meu score',
    'evolução do score',
    'meu streak',
    'minhas conquistas',
    'criar família',
    'limite família semanal 2000',
    'limites da família',
    'relatório mensal visual',
    'resumo da família'
  ];

  let familyCreatedReply = '';
  for (const message of checks) {
    const reply = await sendTwilioText(message);
    printStep(message, reply);
    if (message === 'criar família') {
      familyCreatedReply = reply;
      expectContains(reply, 'Código de convite', message);
    }
    if (message === 'meu score') {
      expectContains(reply, 'score financeiro', message);
    }
    if (message === 'evolução do score') {
      expectContains(reply, 'evolução semanal', message);
    }
    if (message === 'meu streak') {
      expectContains(reply, 'streak', message);
    }
    if (message === 'meu plano') {
      expectContains(reply, 'plano atual', message);
    }
    if (message === 'limite família semanal 2000') {
      expectContains(reply, 'limite familiar semanal', message);
    }
    if (message === 'limites da família') {
      expectContains(reply, 'limites familiares', message);
    }
  }

  await requestJson(`/admin/customers/${customer.id}/subscription/plan`, {
    method: 'POST',
    headers: {
      'x-admin-token': adminToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      planCode: 'essential'
    })
  });

  const lockedFamilyReply = await sendTwilioText('resumo da família');
  printStep('resumo da família (plano essencial)', lockedFamilyReply);
  expectContains(lockedFamilyReply, 'não está disponível', 'trava family_mode');

  await requestJson(`/admin/customers/${customer.id}/subscription/plan`, {
    method: 'POST',
    headers: {
      'x-admin-token': adminToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      planCode: 'family'
    })
  });

  const codeMatch = familyCreatedReply.match(/Código de convite:\s*([A-Z0-9]{6,12})/i);
  if (codeMatch) {
    const joinReply = await sendTwilioText(`entrar na família ${codeMatch[1]}`);
    printStep('entrar na família (self)', joinReply);
  }

  const [goals, reminders, insights] = await Promise.all([
    requestJson(`/admin/customers/${customer.id}/goals/progress`, {
      headers: { 'x-admin-token': adminToken }
    }),
    requestJson(`/admin/customers/${customer.id}/reminders`, {
      headers: { 'x-admin-token': adminToken }
    }),
    requestJson(`/admin/customers/${customer.id}/insights`, {
      headers: { 'x-admin-token': adminToken }
    })
  ]);

  console.log('\n[resumo]');
  console.log(
    JSON.stringify(
      {
        customerId: customer.id,
        goals: goals.length,
        reminders: reminders.length,
        recurringDetected: insights.recurring.length
      },
      null,
      2
    )
  );
}

run().catch((error) => {
  console.error('\nFalha no teste de regressão das sprints.');
  console.error(error.message);
  process.exit(1);
});
