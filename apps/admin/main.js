const API = (() => {
  const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const isLocalAdminPort = window.location.port === '8081';
  if (isLocalHost && isLocalAdminPort) {
    return 'http://localhost:8080';
  }
  return window.location.origin;
})();

const els = {
  loginView: document.getElementById('loginView'),
  dashboardView: document.getElementById('dashboardView'),
  adminEmail: document.getElementById('adminEmail'),
  adminPassword: document.getElementById('adminPassword'),
  loginBtn: document.getElementById('loginBtn'),
  logoutBtn: document.getElementById('logoutBtn'),
  syncStatus: document.getElementById('syncStatus'),
  runRenewals: document.getElementById('runRenewals'),
  runProactive: document.getElementById('runProactive'),
  saveCostSnapshot: document.getElementById('saveCostSnapshot'),
  sessionInfo: document.getElementById('sessionInfo'),
  notice: document.getElementById('notice'),
  customerSearch: document.getElementById('customerSearch'),
  customers: document.getElementById('customers'),
  transactions: document.getElementById('transactions'),
  payments: document.getElementById('payments'),
  selectedCustomer: document.getElementById('selectedCustomer'),
  activeCustomers: document.getElementById('activeCustomers'),
  online1h: document.getElementById('online1h'),
  online24h: document.getElementById('online24h'),
  inactive7d: document.getElementById('inactive7d'),
  newToday: document.getElementById('newToday'),
  pastDue: document.getElementById('pastDue'),
  pendingSetup: document.getElementById('pendingSetup'),
  trialCustomers: document.getElementById('trialCustomers'),
  expensesMonth: document.getElementById('expensesMonth'),
  countAll: document.getElementById('countAll'),
  countActive: document.getElementById('countActive'),
  countPastDue: document.getElementById('countPastDue'),
  countPending: document.getElementById('countPending'),
  countTrial: document.getElementById('countTrial'),
  countCanceled: document.getElementById('countCanceled'),
  countInactive: document.getElementById('countInactive'),
  paySetup: document.getElementById('paySetup'),
  payMonthly: document.getElementById('payMonthly'),
  chargeSetup: document.getElementById('chargeSetup'),
  chargeMonthly: document.getElementById('chargeMonthly'),
  addReferral: document.getElementById('addReferral'),
  activateTrial: document.getElementById('activateTrial'),
  customerPlanSelect: document.getElementById('customerPlanSelect'),
  applyPlan: document.getElementById('applyPlan'),
  statusActive: document.getElementById('statusActive'),
  statusCancel: document.getElementById('statusCancel'),
  deleteCustomer: document.getElementById('deleteCustomer'),
  costOpenAiMtd: document.getElementById('costOpenAiMtd'),
  costTwilioMtd: document.getElementById('costTwilioMtd'),
  costSupabaseMtd: document.getElementById('costSupabaseMtd'),
  costFixedMtd: document.getElementById('costFixedMtd'),
  costTotalMtd: document.getElementById('costTotalMtd'),
  costProjectedMonth: document.getElementById('costProjectedMonth'),
  revenueMtd: document.getElementById('revenueMtd'),
  profitMtd: document.getElementById('profitMtd'),
  profitProjected: document.getElementById('profitProjected'),
  kpiRevenueMtd: document.getElementById('kpiRevenueMtd'),
  kpiCostMtd: document.getElementById('kpiCostMtd'),
  kpiProfitMtd: document.getElementById('kpiProfitMtd'),
  kpiMarginMtd: document.getElementById('kpiMarginMtd'),
  kpiRevenueProjected: document.getElementById('kpiRevenueProjected'),
  kpiCostProjected: document.getElementById('kpiCostProjected'),
  kpiProfitProjected: document.getElementById('kpiProfitProjected'),
  kpiCostPerActive: document.getElementById('kpiCostPerActive'),
  costInsights: document.getElementById('costInsights'),
  providerShare: document.getElementById('providerShare'),
  plansSummary: document.getElementById('plansSummary'),
  planRows: document.getElementById('planRows'),
  costGlossary: document.getElementById('costGlossary'),
  costProviderRows: document.getElementById('costProviderRows'),
  costStatus: document.getElementById('costStatus'),
  costSnapshots: document.getElementById('costSnapshots'),
  agentCoordinatorSelect: document.getElementById('agentCoordinatorSelect'),
  agentConfigSave: document.getElementById('agentConfigSave'),
  agentRoomTitle: document.getElementById('agentRoomTitle'),
  agentRoomInstruction: document.getElementById('agentRoomInstruction'),
  agentRoomStart: document.getElementById('agentRoomStart'),
  agentRoomRefresh: document.getElementById('agentRoomRefresh'),
  familySquadStatus: document.getElementById('familySquadStatus'),
  familySquadActivate: document.getElementById('familySquadActivate'),
  familySquadRun: document.getElementById('familySquadRun'),
  agentRoomsList: document.getElementById('agentRoomsList'),
  agentRoomMeta: document.getElementById('agentRoomMeta'),
  agentRoomMessages: document.getElementById('agentRoomMessages'),
  agentRoomSummary: document.getElementById('agentRoomSummary'),
  agentRoomDecisions: document.getElementById('agentRoomDecisions'),
  agentRoomChanges: document.getElementById('agentRoomChanges'),
  agentRoomFollowup: document.getElementById('agentRoomFollowup'),
  agentRoomSend: document.getElementById('agentRoomSend')
};

const state = {
  selectedCustomerId: null,
  customers: [],
  payments: [],
  metrics: null,
  costsOverview: null,
  costSnapshots: [],
  plans: [],
  agentConfig: null,
  familySquadStatus: null,
  agentRooms: [],
  selectedAgentRoomId: null,
  selectedAgentRoom: null,
  customerFilter: 'all',
  search: '',
  refreshTimer: null
};

const customerActionButtons = [
  els.paySetup,
  els.payMonthly,
  els.chargeSetup,
  els.chargeMonthly,
  els.addReferral,
  els.activateTrial,
  els.applyPlan,
  els.statusActive,
  els.statusCancel,
  els.deleteCustomer
];

function brl(cents) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents || 0) / 100);
}

function usd(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' }).format(value || 0);
}

function formatMoneyPair(params) {
  return `${usd(params.usd)} | ${brl(params.brlCents)}`;
}

function percent(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(value) {
  if (!value) return '---';
  return new Date(value).toLocaleString('pt-BR');
}

function formatDateOnly(value) {
  if (!value) return '---';
  return new Date(`${value}T12:00:00.000Z`).toLocaleDateString('pt-BR');
}

function getAuthToken() {
  return localStorage.getItem('finance_admin_jwt') || '';
}

function setAuthToken(token) {
  localStorage.setItem('finance_admin_jwt', token);
}

function clearAuthToken() {
  localStorage.removeItem('finance_admin_jwt');
}

function badgeClass(status) {
  if (status === 'active' || status === 'paid') return 'active';
  if (status === 'trial') return 'trial';
  if (status === 'past_due' || status === 'overdue') return 'past_due';
  if (status === 'canceled' || status === 'refunded') return 'canceled';
  return 'pending_setup_payment';
}

function statusLabel(status) {
  const map = {
    active: 'Ativo',
    trial: 'Em teste',
    past_due: 'Inadimplente',
    pending_setup_payment: 'Pendente entrada',
    canceled: 'Cancelado',
    paid: 'Pago',
    overdue: 'Atrasado',
    pending: 'Pendente',
    refunded: 'Estornado'
  };
  return map[status] || status;
}

function providerSourceLabel(value) {
  const map = {
    api: 'API oficial',
    fixed: 'Custo manual',
    local_estimate: 'Estimativa local'
  };
  return map[value] || value;
}

function providerStatusLabel(value) {
  const map = {
    ok: 'OK',
    missing_config: 'Config faltando',
    error: 'Erro'
  };
  return map[value] || value;
}

function providerStatusPillClass(value) {
  if (value === 'ok') return 'active';
  if (value === 'missing_config') return 'pending_setup_payment';
  return 'past_due';
}

function providerActionHint(provider) {
  if (provider.status === 'ok') {
    return 'Leitura operacional normal.';
  }
  if (provider.provider === 'openai') {
    if (provider.note?.includes('OPENAI_ADMIN_KEY')) {
      return 'Preencha OPENAI_ADMIN_KEY para leitura oficial de custos.';
    }
    if (provider.note?.includes('OPENAI_ORG_ID')) {
      return 'Preencha OPENAI_ORG_ID para leitura da organização.';
    }
    return 'Revise chave e billing da OpenAI.';
  }
  if (provider.provider === 'twilio') {
    return 'Revise TWILIO_ACCOUNT_SID/AUTH_TOKEN.';
  }
  if (provider.provider === 'supabase' || provider.provider === 'infra' || provider.provider === 'other') {
    return 'Defina custo mensal fixo no .env para projeções reais.';
  }
  return provider.note || 'Revise configuração deste provedor.';
}

function humanFeatureName(code) {
  const map = {
    goals: 'Metas',
    reminders: 'Lembretes',
    insights: 'Insights',
    recurring: 'Recorrências',
    cashflow: 'Fluxo de caixa',
    investment_simulator: 'Simulador',
    gamification: 'Gamificação',
    health_score: 'Score',
    family_mode: 'Modo família',
    visual_monthly_report: 'Relatório visual',
    open_banking_import: 'Open banking'
  };
  return map[code] || code;
}

function aiTierLabel(value) {
  const map = {
    basic: 'Básica',
    assistida: 'Assistida',
    avancada: 'Avançada',
    colaborativa: 'Colaborativa',
    proativa: 'Proativa'
  };
  return map[value] || value;
}

function proactiveLabel(value) {
  const map = {
    none: 'Baixa',
    standard: 'Média',
    advanced: 'Alta',
    max: 'Máxima'
  };
  return map[value] || value;
}

function agentRoomStatusLabel(value) {
  const map = {
    running: 'Rodando',
    completed: 'Concluída',
    failed: 'Falhou'
  };
  return map[value] || value;
}

function daysSince(dateValue) {
  if (!dateValue) return Number.POSITIVE_INFINITY;
  const target = new Date(dateValue).getTime();
  if (Number.isNaN(target)) return Number.POSITIVE_INFINITY;
  const diffMs = Date.now() - target;
  return diffMs / (1000 * 60 * 60 * 24);
}

function isInactive7d(customer) {
  return daysSince(customer.lastInboundAt) >= 7;
}

function setNotice(message, type = 'success') {
  if (!message) {
    els.notice.textContent = '';
    els.notice.className = 'notice hidden';
    return;
  }
  els.notice.textContent = message;
  els.notice.className = `notice ${type}`;
}

function setCustomerActionsEnabled(enabled) {
  customerActionButtons.forEach((button) => {
    button.disabled = !enabled;
  });
  if (els.customerPlanSelect) {
    els.customerPlanSelect.disabled = !enabled;
  }
}

function showDashboard(show) {
  els.loginView.classList.toggle('hidden', show);
  els.dashboardView.classList.toggle('hidden', !show);
}

function applyCustomerFilter(customer) {
  if (state.customerFilter === 'active') {
    return customer.subscriptionStatus === 'active';
  }

  if (state.customerFilter === 'past_due') {
    return customer.subscriptionStatus === 'past_due';
  }

  if (state.customerFilter === 'pending_setup_payment') {
    return customer.subscriptionStatus === 'pending_setup_payment';
  }

  if (state.customerFilter === 'trial') {
    return customer.subscriptionStatus === 'trial';
  }

  if (state.customerFilter === 'canceled') {
    return customer.subscriptionStatus === 'canceled';
  }

  if (state.customerFilter === 'inactive_7d') {
    return isInactive7d(customer);
  }

  return true;
}

function applyCustomerSearch(customer) {
  const term = state.search.trim().toLowerCase();
  if (!term) return true;

  const haystack = `${customer.name || ''} ${customer.whatsappNumber}`.toLowerCase();
  return haystack.includes(term);
}

function updateFilterCounters() {
  const customers = state.customers;
  els.countAll.textContent = String(customers.length);
  els.countActive.textContent = String(customers.filter((c) => c.subscriptionStatus === 'active').length);
  els.countPastDue.textContent = String(customers.filter((c) => c.subscriptionStatus === 'past_due').length);
  els.countPending.textContent = String(customers.filter((c) => c.subscriptionStatus === 'pending_setup_payment').length);
  els.countTrial.textContent = String(customers.filter((c) => c.subscriptionStatus === 'trial').length);
  els.countCanceled.textContent = String(customers.filter((c) => c.subscriptionStatus === 'canceled').length);
  els.countInactive.textContent = String(customers.filter(isInactive7d).length);
}

function renderCustomers() {
  updateFilterCounters();

  const filtered = state.customers
    .filter(applyCustomerFilter)
    .filter(applyCustomerSearch);

  els.customers.innerHTML = '';

  if (!filtered.length) {
    els.customers.innerHTML = '<div class="item">Nenhum cliente com esse filtro.</div>';
    return;
  }

  filtered.forEach((customer) => {
    const isSelected = state.selectedCustomerId === customer.id;
    const div = document.createElement('div');
    div.className = `item ${isSelected ? 'is-selected' : ''}`;
    div.innerHTML = `
      <strong>${customer.name || 'Sem nome'}</strong>
      <span class="badge ${badgeClass(customer.subscriptionStatus)}">${statusLabel(customer.subscriptionStatus)}</span>
      <div class="small">WhatsApp: ${customer.whatsappNumber}</div>
      <div class="small">Plano: ${customer.planName}</div>
      <div class="small">Mensal atual: ${brl(customer.effectiveMonthlyFeeCents)}</div>
      <div class="small">Vencimento: ${formatDateOnly(customer.nextDueDate)}</div>
      <div class="small">Teste: ${customer.trialActive ? `ativo até ${formatDateOnly(customer.trialEndDate)} (${customer.trialDaysLeft}d)` : 'inativo'}</div>
      <div class="small">Indicações: ${customer.referralCount}</div>
      <div class="small">Última interação: ${formatDate(customer.lastInboundAt)}</div>
      <button data-id="${customer.id}" class="ghost">Gerenciar cliente</button>
    `;

    div.querySelector('button').addEventListener('click', () => {
      selectCustomer(customer.id).catch((error) => {
        console.error(error);
        setNotice(`Falha ao carregar cliente: ${error.message}`, 'error');
      });
    });

    els.customers.appendChild(div);
  });
}

function renderPayments() {
  els.payments.innerHTML = '';
  if (!state.payments.length) {
    els.payments.innerHTML = '<div class="item">Sem pagamentos registrados.</div>';
    return;
  }

  state.payments.forEach((payment) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <strong>${payment.customerName || 'Sem nome'} (${payment.whatsappNumber})</strong>
      <span class="badge ${badgeClass(payment.status)}">${statusLabel(payment.status)}</span>
      <div class="small">Tipo: ${payment.paymentType} | Gateway: ${payment.gateway}</div>
      <div class="small">Valor: ${brl(payment.amountCents)}</div>
      <div class="small">Vencimento: ${formatDateOnly(payment.dueDate)}</div>
      <div class="small">Pago em: ${formatDate(payment.paidAt)}</div>
      <div class="small">Ref: ${payment.externalReference || '---'}</div>
    `;
    els.payments.appendChild(div);
  });
}

function renderMetrics(data) {
  state.metrics = data;
  els.activeCustomers.textContent = data.activeCustomers;
  els.online1h.textContent = data.customersOnline1h;
  els.online24h.textContent = data.customersOnline24h;
  els.inactive7d.textContent = data.inactive7d;
  els.newToday.textContent = data.newCustomersToday;
  els.pastDue.textContent = data.pastDueCustomers;
  els.pendingSetup.textContent = data.pendingSetupCustomers;
  els.trialCustomers.textContent = data.trialCustomers;
  els.expensesMonth.textContent = brl(data.expensesThisMonthCents);
}

function renderCostSnapshots() {
  els.costSnapshots.innerHTML = '';
  if (!state.costSnapshots.length) {
    els.costSnapshots.innerHTML = '<div class="item">Sem snapshots ainda. Clique em "Salvar snapshot de hoje".</div>';
    return;
  }

  state.costSnapshots.forEach((snap) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <strong>${formatDateOnly(snap.snapshotDate)}</strong>
      <div class="small">Custo MTD: ${formatMoneyPair({ usd: snap.totals.mtdUsd, brlCents: snap.totals.mtdBrlCents })}</div>
      <div class="small">Custo projetado: ${formatMoneyPair({ usd: snap.totals.projectedUsd, brlCents: snap.totals.projectedBrlCents })}</div>
      <div class="small">Lucro MTD: ${brl(snap.profit.mtdBrlCents)}</div>
      <div class="small">Lucro projetado: ${brl(snap.profit.projectedBrlCents)}</div>
      <div class="small">Atualizado em: ${formatDate(snap.createdAt)}</div>
    `;
    els.costSnapshots.appendChild(div);
  });
}

function renderCosts(data) {
  state.costsOverview = data;
  const providers = new Map((data.providers || []).map((item) => [item.provider, item]));
  const openai = providers.get('openai') || { mtdUsd: 0, status: 'missing_config' };
  const twilio = providers.get('twilio') || { mtdUsd: 0, status: 'missing_config' };
  const supabase = providers.get('supabase') || { mtdUsd: 0, monthlyUsd: 0, status: 'missing_config' };
  const infra = providers.get('infra') || { mtdUsd: 0, monthlyUsd: 0, status: 'missing_config' };
  const other = providers.get('other') || { mtdUsd: 0, monthlyUsd: 0, status: 'missing_config' };

  const nonSupabaseFixedMonthlyUsd = (infra.monthlyUsd || 0) + (other.monthlyUsd || 0);

  const shortSource = (item) => {
    if (item.source === 'api') return 'API oficial';
    if (item.source === 'local_estimate') return 'estimativa local';
    return 'fixo manual';
  };
  const shortState = (item) => (item.status === 'ok' ? 'OK' : providerStatusLabel(item.status));
  const toBrlCents = (usdValue) => Math.round((usdValue || 0) * Number(data.fxUsdBrlRate || 0) * 100);

  els.costOpenAiMtd.textContent = `${formatMoneyPair({ usd: openai.mtdUsd || 0, brlCents: toBrlCents(openai.mtdUsd || 0) })} (${shortSource(openai)} | ${shortState(openai)})`;
  els.costTwilioMtd.textContent = `${formatMoneyPair({ usd: twilio.mtdUsd || 0, brlCents: toBrlCents(twilio.mtdUsd || 0) })} (${shortSource(twilio)} | ${shortState(twilio)})`;
  els.costSupabaseMtd.textContent = `${formatMoneyPair({ usd: supabase.mtdUsd || 0, brlCents: toBrlCents(supabase.mtdUsd || 0) })} (${usd(supabase.monthlyUsd || 0)}/mês)`;
  els.costFixedMtd.textContent = `${formatMoneyPair({ usd: (infra.mtdUsd || 0) + (other.mtdUsd || 0), brlCents: toBrlCents((infra.mtdUsd || 0) + (other.mtdUsd || 0)) })} (${usd(nonSupabaseFixedMonthlyUsd)}/mês)`;
  els.costTotalMtd.textContent = formatMoneyPair({
    usd: data.totals?.mtdUsd || 0,
    brlCents: data.totals?.mtdBrlCents || 0
  });
  els.costProjectedMonth.textContent = formatMoneyPair({
    usd: data.totals?.projectedUsd || 0,
    brlCents: data.totals?.projectedBrlCents || 0
  });
  els.revenueMtd.textContent = brl(data.revenue?.mtdBrlCents || 0);
  els.profitMtd.textContent = brl(data.profit?.mtdBrlCents || 0);
  els.profitProjected.textContent = brl(data.profit?.projectedBrlCents || 0);

  const revenueMtdCents = data.revenue?.mtdBrlCents || 0;
  const revenueProjectedCents = data.revenue?.projectedBrlCents || 0;
  const costMtdCents = data.totals?.mtdBrlCents || 0;
  const costProjectedCents = data.totals?.projectedBrlCents || 0;
  const profitMtdCents = data.profit?.mtdBrlCents || 0;
  const profitProjectedCents = data.profit?.projectedBrlCents || 0;
  const marginMtd = revenueMtdCents > 0 ? profitMtdCents / revenueMtdCents : 0;
  const activeCustomers = Number(state.metrics?.activeCustomers || 0);
  const costPerActiveCents = activeCustomers > 0 ? Math.round(costMtdCents / activeCustomers) : 0;

  els.kpiRevenueMtd.textContent = brl(revenueMtdCents);
  els.kpiCostMtd.textContent = brl(costMtdCents);
  els.kpiProfitMtd.textContent = brl(profitMtdCents);
  els.kpiMarginMtd.textContent = percent(marginMtd);
  els.kpiRevenueProjected.textContent = brl(revenueProjectedCents);
  els.kpiCostProjected.textContent = brl(costProjectedCents);
  els.kpiProfitProjected.textContent = brl(profitProjectedCents);
  els.kpiCostPerActive.textContent = activeCustomers > 0
    ? `${brl(costPerActiveCents)} / cliente`
    : '---';

  const breakEvenCustomers = activeCustomers > 0
    ? Math.ceil(costProjectedCents / Math.max(Math.round(revenueProjectedCents / activeCustomers), 1))
    : null;
  const providerAlerts = (data.providers || [])
    .filter((item) => item.status !== 'ok')
    .slice(0, 2)
    .map((item) => `${item.provider.toUpperCase()}: ${providerActionHint(item)}`);
  const insightItems = [
    `Clientes ativos: ${activeCustomers}`,
    `Receita média por cliente (MTD): ${activeCustomers > 0 ? brl(Math.round(revenueMtdCents / activeCustomers)) : '---'}`,
    `Break-even estimado (clientes): ${breakEvenCustomers ?? '---'}`,
    ...providerAlerts
  ];
  els.costInsights.innerHTML = insightItems.map((item) => `<span class="insight-pill">${escapeHtml(item)}</span>`).join('');

  const fx = Number(data.fxUsdBrlRate || 0);
  const sortedProviders = [...(data.providers || [])]
    .sort((a, b) => (b.mtdUsd || 0) - (a.mtdUsd || 0) || a.provider.localeCompare(b.provider));
  const totalMtdUsd = Math.max(data.totals?.mtdUsd || 0, 0);
  els.costProviderRows.innerHTML = sortedProviders.map((item) => {
    const mtdBrl = Math.round((item.mtdUsd || 0) * fx * 100);
    const sourceText = providerSourceLabel(item.source);
    const statusText = providerStatusLabel(item.status);
    const actionHint = providerActionHint(item);
    return `
      <tr>
        <td><strong>${escapeHtml(item.provider)}</strong></td>
        <td>${usd(item.mtdUsd || 0)}</td>
        <td>${brl(mtdBrl)}</td>
        <td>${usd(item.projectedUsd || 0)}</td>
        <td>${usd(item.monthlyUsd || 0)}</td>
        <td>${escapeHtml(sourceText)}</td>
        <td><span class="badge ${providerStatusPillClass(item.status)}">${escapeHtml(statusText)}</span></td>
        <td>${escapeHtml(item.note || actionHint)}</td>
      </tr>
    `;
  }).join('');

  els.providerShare.innerHTML = sortedProviders.map((item) => {
    const share = totalMtdUsd > 0 ? (item.mtdUsd || 0) / totalMtdUsd : 0;
    const pct = Math.round(share * 1000) / 10;
    const width = share > 0 ? Math.max(2, Math.round(share * 100)) : 0;
    return `
      <div class="provider-share-item">
        <div class="provider-share-head">
          <strong>${escapeHtml(item.provider)}</strong>
          <span>${pct.toFixed(1)}%</span>
        </div>
        <div class="provider-share-bar"><span style="width:${width}%"></span></div>
        <div class="small">${usd(item.mtdUsd || 0)} no MTD</div>
      </div>
    `;
  }).join('');

  els.costGlossary.textContent = [
    `MTD = do dia 1 até hoje (${data.period?.dayOfMonth || '-'} de ${data.period?.daysInMonth || '-'} dias).`,
    'Projetado = estimativa para fechar o mês com base no ritmo atual.',
    'Lucro = receita recebida - custos.'
  ].join(' ');

  const providerStatus = (data.providers || [])
    .map((item) => {
      const statusText = item.status === 'ok'
        ? 'ok'
        : item.status === 'missing_config'
          ? 'config faltando'
          : 'erro';
      const note = item.note ? ` (${item.note})` : '';
      return `${item.provider}: ${statusText}${note}`;
    })
    .join(' | ');

  const generatedAt = data.period?.generatedAt ? formatDate(data.period.generatedAt) : '---';
  const fxInfo = data.fxUsdBrlRate ? `FX ${data.fxUsdBrlRate.toFixed(2)}` : '';
  const revenueMtd = brl(data.revenue?.mtdBrlCents || 0);
  const revenueProjected = brl(data.revenue?.projectedBrlCents || 0);
  els.costStatus.textContent = `Atualizado em ${generatedAt}. ${fxInfo}. Receita MTD: ${revenueMtd}. Receita projetada: ${revenueProjected}. ${providerStatus}`;
}

function renderPlans() {
  if (!els.planRows || !els.plansSummary) return;

  if (!state.plans.length) {
    els.planRows.innerHTML = '<tr><td colspan="9">Sem planos carregados.</td></tr>';
    els.plansSummary.innerHTML = '';
    return;
  }

  const ordered = [...state.plans].sort((a, b) => {
    const order = ['free', 'essential', 'premium', 'family', 'elite'];
    return order.indexOf(a.code) - order.indexOf(b.code);
  });

  const minMonthly = Math.min(...ordered.map((plan) => Number(plan.monthlyFeeCents || 0)));
  const maxMonthly = Math.max(...ordered.map((plan) => Number(plan.monthlyFeeCents || 0)));
  const maxMessages = Math.max(...ordered.map((plan) => Number(plan.monthlyMessageLimit || 0)));

  els.plansSummary.innerHTML = [
    `<span class="insight-pill">Planos: ${ordered.length}</span>`,
    `<span class="insight-pill">Mensalidade: ${brl(minMonthly)} até ${brl(maxMonthly)}</span>`,
    `<span class="insight-pill">Maior limite: ${maxMessages} msg/mês</span>`
  ].join('');

  els.planRows.innerHTML = ordered.map((plan) => {
    const features = Array.isArray(plan.features)
      ? plan.features.map((feature) => humanFeatureName(feature)).join(', ')
      : '---';
    const setup = Number(plan.setupFeeCents || 0);
    const monthly = Number(plan.monthlyFeeCents || 0);
    const members = Number(plan.groupMemberLimit || 1);
    return `
      <tr>
        <td><strong>${escapeHtml(plan.name)}</strong><div class="small">${escapeHtml(plan.code)}</div></td>
        <td>${brl(setup)}</td>
        <td>${brl(monthly)}</td>
        <td>${escapeHtml(String(plan.monthlyMessageLimit || 0))}</td>
        <td>${escapeHtml(aiTierLabel(plan.aiTier))}</td>
        <td>${escapeHtml(proactiveLabel(plan.proactiveLevel))}</td>
        <td>${members}</td>
        <td>${escapeHtml(features)}</td>
        <td>${escapeHtml(plan.shortPitch || '---')}</td>
      </tr>
    `;
  }).join('');
}

function renderAgentConfig() {
  if (!els.agentCoordinatorSelect) return;

  const configData = state.agentConfig;
  if (!configData || !Array.isArray(configData.agents)) {
    els.agentCoordinatorSelect.innerHTML = '<option value="">Sem configuração</option>';
    return;
  }

  const currentValue = els.agentCoordinatorSelect.value;
  const activeAgents = configData.agents.filter((agent) => agent.active !== false);

  els.agentCoordinatorSelect.innerHTML = '';
  activeAgents.forEach((agent) => {
    const option = document.createElement('option');
    option.value = agent.name;
    option.textContent = `${agent.name} — ${agent.role}`;
    els.agentCoordinatorSelect.appendChild(option);
  });

  const desired = activeAgents.some((agent) => agent.name === configData.coordinatorAgent)
    ? configData.coordinatorAgent
    : activeAgents[0]?.name;

  if (currentValue && activeAgents.some((agent) => agent.name === currentValue)) {
    els.agentCoordinatorSelect.value = currentValue;
  } else if (desired) {
    els.agentCoordinatorSelect.value = desired;
  }
}

function renderFamilySquadStatus() {
  if (!els.familySquadStatus) return;

  const status = state.familySquadStatus;
  if (!status) {
    els.familySquadStatus.innerHTML = 'Status da squad indisponível no momento.';
    return;
  }

  const squadState = status.active
    ? '<span class="badge active">Ativa</span>'
    : '<span class="badge pending">Inativa</span>';
  const missing = Array.isArray(status.missingAgents) && status.missingAgents.length > 0
    ? status.missingAgents.join(', ')
    : 'nenhum';
  const activeCount = Array.isArray(status.activeAgentNames)
    ? status.activeAgentNames.length
    : 0;

  els.familySquadStatus.innerHTML = `
    <strong>Equipe dedicada Plano Família: ${squadState}</strong>
    <div class="small">Coordenador atual: ${escapeHtml(status.coordinatorAgent || '---')}</div>
    <div class="small">Coordenador esperado: ${escapeHtml(status.requiredCoordinator || '---')}</div>
    <div class="small">Agentes ativos: ${activeCount}</div>
    <div class="small">Pendências da squad: ${escapeHtml(missing)}</div>
    <div class="small">Atualizada em: ${formatDate(status.configUpdatedAt)}</div>
  `;
}

function renderAgentRooms() {
  if (!els.agentRoomsList) return;
  els.agentRoomsList.innerHTML = '';

  if (!state.agentRooms.length) {
    els.agentRoomsList.innerHTML = '<div class="item">Nenhuma sala criada ainda.</div>';
    return;
  }

  state.agentRooms.forEach((room) => {
    const isSelected = room.id === state.selectedAgentRoomId;
    const div = document.createElement('div');
    div.className = `item ${isSelected ? 'is-selected' : ''}`;
    div.innerHTML = `
      <strong>${escapeHtml(room.title || 'Sala sem título')}</strong>
      <span class="badge ${badgeClass(room.status === 'failed' ? 'canceled' : room.status === 'running' ? 'pending' : 'active')}">${escapeHtml(agentRoomStatusLabel(room.status))}</span>
      <div class="small">Coordenador: ${escapeHtml(room.coordinatorAgent || '---')}</div>
      <div class="small">Mensagens: ${escapeHtml(String(room.messageCount ?? 0))}</div>
      <div class="small">Atualizada em: ${formatDate(room.updatedAt)}</div>
      <div class="small">${escapeHtml(room.lastMessage || room.summary || 'Sem conteúdo ainda.')}</div>
      <button data-room-id="${room.id}" class="ghost">Abrir sala</button>
    `;

    const button = div.querySelector('button');
    if (button) {
      button.addEventListener('click', () => {
        selectAgentRoom(room.id).catch((error) => {
          console.error(error);
          setNotice(`Falha ao abrir sala: ${error.message}`, 'error');
        });
      });
    }

    els.agentRoomsList.appendChild(div);
  });
}

function renderAgentRoomDetail() {
  if (!els.agentRoomMeta || !els.agentRoomMessages || !els.agentRoomSummary || !els.agentRoomDecisions || !els.agentRoomChanges) {
    return;
  }

  const room = state.selectedAgentRoom;
  if (!room) {
    els.agentRoomMeta.innerHTML = 'Selecione uma sala para acompanhar o debate.';
    els.agentRoomMessages.innerHTML = '<div class="item">Sem mensagens.</div>';
    els.agentRoomSummary.textContent = '---';
    els.agentRoomDecisions.innerHTML = '<div class="item">Sem decisões.</div>';
    els.agentRoomChanges.innerHTML = '<div class="item">Sem mudanças.</div>';
    return;
  }

  els.agentRoomMeta.innerHTML = `
    <strong>${escapeHtml(room.title || 'Sala sem título')}</strong>
    <div class="small">Status: <span class="badge ${badgeClass(room.status === 'failed' ? 'canceled' : room.status === 'running' ? 'pending' : 'active')}">${escapeHtml(agentRoomStatusLabel(room.status))}</span></div>
    <div class="small">Coordenador: ${escapeHtml(room.coordinatorAgent)}</div>
    <div class="small">Criada por: ${escapeHtml(room.createdBy || 'sistema')}</div>
    <div class="small">Criada em: ${formatDate(room.createdAt)}</div>
    <div class="small">Atualizada em: ${formatDate(room.updatedAt)}</div>
  `;

  if (!Array.isArray(room.messages) || room.messages.length === 0) {
    els.agentRoomMessages.innerHTML = '<div class="item">Sem mensagens na sala.</div>';
  } else {
    els.agentRoomMessages.innerHTML = room.messages.map((message) => {
      const toneClass = message.role === 'admin'
        ? 'agent-msg-admin'
        : message.role === 'system'
          ? 'agent-msg-system'
          : 'agent-msg-agent';
      return `
        <div class="item ${toneClass}">
          <strong>${escapeHtml(message.agentName || (message.role === 'admin' ? 'Admin' : 'Sistema'))}</strong>
          <div>${escapeHtml(message.content)}</div>
          <div class="small">${formatDate(message.createdAt)}</div>
        </div>
      `;
    }).join('');
  }

  els.agentRoomSummary.textContent = room.summary || 'Sem resumo disponível ainda.';

  if (!Array.isArray(room.decisions) || room.decisions.length === 0) {
    els.agentRoomDecisions.innerHTML = '<div class="item">Sem decisões registradas.</div>';
  } else {
    els.agentRoomDecisions.innerHTML = room.decisions.map((decision) => `
      <div class="item">
        <strong>${escapeHtml(decision.title)}</strong>
        <div class="small">Prioridade: ${escapeHtml(decision.priority)} | Responsável: ${escapeHtml(decision.owner)}</div>
        <div class="small">${escapeHtml(decision.reason)}</div>
      </div>
    `).join('');
  }

  if (!Array.isArray(room.changes) || room.changes.length === 0) {
    els.agentRoomChanges.innerHTML = '<div class="item">Sem mudanças registradas.</div>';
  } else {
    els.agentRoomChanges.innerHTML = room.changes.map((change) => `
      <div class="item">
        <strong>${escapeHtml(change.title)}</strong>
        <div class="small">Status: ${escapeHtml(change.status)}</div>
        <div class="small"><strong>O que:</strong> ${escapeHtml(change.what)}</div>
        <div class="small"><strong>Por quê:</strong> ${escapeHtml(change.why)}</div>
      </div>
    `).join('');
  }
}

async function selectAgentRoom(roomId) {
  state.selectedAgentRoomId = roomId;
  const payload = await api(`/admin/agents/rooms/${roomId}`);
  state.selectedAgentRoom = payload.room || null;
  renderAgentRooms();
  renderAgentRoomDetail();
}

async function loadAgentRooms({ keepSelection = true } = {}) {
  const [configData, roomsPayload, familySquadPayload] = await Promise.all([
    api('/admin/agents/config'),
    api('/admin/agents/rooms?limit=30'),
    api('/admin/agents/family-squad/status')
  ]);

  state.agentConfig = configData;
  state.agentRooms = Array.isArray(roomsPayload?.rooms) ? roomsPayload.rooms : [];
  state.familySquadStatus = familySquadPayload?.status || null;
  renderAgentConfig();
  renderFamilySquadStatus();
  renderAgentRooms();

  if (!keepSelection) {
    state.selectedAgentRoomId = null;
    state.selectedAgentRoom = null;
    renderAgentRoomDetail();
    return;
  }

  if (!state.selectedAgentRoomId && state.agentRooms.length > 0) {
    state.selectedAgentRoomId = state.agentRooms[0].id;
  }

  const stillExists = state.agentRooms.some((room) => room.id === state.selectedAgentRoomId);
  if (!stillExists) {
    state.selectedAgentRoomId = state.agentRooms[0]?.id ?? null;
  }

  if (state.selectedAgentRoomId) {
    await selectAgentRoom(state.selectedAgentRoomId);
  } else {
    state.selectedAgentRoom = null;
    renderAgentRoomDetail();
  }
}

async function api(path, options = {}) {
  const token = getAuthToken();
  const res = await fetch(`${API}${path}`, {
    method: options.method || 'GET',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await res.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }

  if (res.status === 401) {
    clearAuthToken();
    throw new Error('UNAUTHORIZED');
  }

  if (!res.ok) {
    throw new Error(payload?.error || `HTTP ${res.status}`);
  }

  return payload;
}

async function login() {
  const email = els.adminEmail.value.trim().toLowerCase();
  const password = els.adminPassword.value;

  if (!email || !password) {
    throw new Error('Informe email e senha.');
  }

  const res = await fetch(`${API}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || 'Falha no login');
  }

  setAuthToken(data.token);
  els.adminPassword.value = '';
  els.sessionInfo.textContent = `Conectado como ${data.user.email} (${data.user.role}).`;
}

async function loadPlans() {
  const plans = await api('/admin/plans');
  state.plans = Array.isArray(plans) ? plans : [];

  if (!els.customerPlanSelect) return;

  els.customerPlanSelect.innerHTML = '';
  state.plans.forEach((plan) => {
    const option = document.createElement('option');
    option.value = plan.code;
    const monthly = brl(plan.monthlyFeeCents || 0);
    option.textContent = `${plan.name} (${monthly}/mês | ${plan.monthlyMessageLimit} msg | IA ${aiTierLabel(plan.aiTier)})`;
    els.customerPlanSelect.appendChild(option);
  });

  renderPlans();
}

async function loadCustomerTransactions(customerId) {
  const transactions = await api(`/admin/customers/${customerId}/transactions`);
  els.transactions.innerHTML = '';

  if (!transactions.length) {
    els.transactions.innerHTML = '<div class="item">Sem transações para este cliente.</div>';
    return;
  }

  transactions.forEach((tx) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <strong>${tx.kind === 'expense' ? 'Despesa' : 'Receita'} ${brl(tx.amountCents)}</strong>
      <div class="small">${tx.category}</div>
      <div class="small">${tx.description || ''}</div>
      <div class="small">${new Date(tx.occurredAt).toLocaleString('pt-BR')}</div>
    `;
    els.transactions.appendChild(div);
  });
}

async function loadCustomerSummary(customerId) {
  const sub = await api(`/admin/customers/${customerId}/subscription`);
  if (els.customerPlanSelect && sub.planCode) {
    els.customerPlanSelect.value = sub.planCode;
  }

  const features = Array.isArray(sub.features) ? sub.features.join(', ') : '---';
  const monthlyLimit = Number(sub.monthlyMessageLimit || 0);
  const used = Number(sub.messagesUsedThisMonth || 0);
  const remaining = monthlyLimit > 0 ? Math.max(monthlyLimit - used, 0) : 0;

  els.selectedCustomer.innerHTML = `
    <strong>Status: <span class="badge ${badgeClass(sub.status)}">${statusLabel(sub.status)}</span></strong>
    <div class="small">Plano: ${sub.planName || sub.planCode || '---'}</div>
    <div class="small">Mensagens/mês: ${used}/${monthlyLimit} (restantes: ${remaining})</div>
    <div class="small">Recursos do plano: ${features}</div>
    <div class="small">Entrada paga: ${sub.hasPaidSetup ? 'sim' : 'não'}</div>
    <div class="small">Teste: ${sub.trialActive ? `ativo até ${formatDateOnly(sub.trialEndDate)} (${sub.trialDaysLeft}d)` : 'inativo'}</div>
    <div class="small">Entrada: ${brl(sub.setupFeeCents)}</div>
    <div class="small">Mensal base: ${brl(sub.baseMonthlyFeeCents)}</div>
    <div class="small">Mensal c/ desconto: ${brl(sub.discountedMonthlyFeeCents)}</div>
    <div class="small">Mensal atual: ${brl(sub.effectiveMonthlyFeeCents)}</div>
    <div class="small">Indicações: ${sub.referralCount} (meta ${sub.referralThreshold})</div>
    <div class="small">Vencimento: ${formatDateOnly(sub.nextDueDate)}</div>
    <div class="small">Último pagamento: ${formatDateOnly(sub.lastPaymentDate)}</div>
  `;
}

async function selectCustomer(customerId) {
  state.selectedCustomerId = customerId;
  setCustomerActionsEnabled(true);
  renderCustomers();
  await Promise.all([
    loadCustomerSummary(customerId),
    loadCustomerTransactions(customerId)
  ]);
}

function resetSelection() {
  state.selectedCustomerId = null;
  setCustomerActionsEnabled(false);
  els.selectedCustomer.innerHTML = 'Selecione um cliente na lista.';
  els.transactions.innerHTML = '<div class="item">Selecione um cliente para carregar transações.</div>';
}

async function loadSession() {
  const token = getAuthToken();
  if (!token) {
    els.sessionInfo.textContent = 'Faça login para acessar o painel.';
    return false;
  }

  try {
    const me = await api('/admin/auth/me');
    els.sessionInfo.textContent = `Conectado como ${me.email} (${me.role}).`;
    return true;
  } catch {
    clearAuthToken();
    els.sessionInfo.textContent = 'Sessão expirada. Faça login novamente.';
    return false;
  }
}

async function loadAll({ silent = false } = {}) {
  try {
    const plansPromise = state.plans.length ? Promise.resolve(state.plans) : api('/admin/plans');
    const [metrics, customers, payments, costsOverview, costSnapshots, plans, agentConfig, agentRoomsPayload, familySquadPayload] = await Promise.all([
      api('/admin/metrics'),
      api('/admin/customers'),
      api('/admin/payments?limit=50'),
      api('/admin/costs/overview'),
      api('/admin/costs/snapshots?limit=15'),
      plansPromise,
      api('/admin/agents/config'),
      api('/admin/agents/rooms?limit=30'),
      api('/admin/agents/family-squad/status')
    ]);

    renderMetrics(metrics);
    renderCosts(costsOverview);
    state.plans = Array.isArray(plans) ? plans : state.plans;
    if (els.customerPlanSelect && els.customerPlanSelect.options.length === 0 && state.plans.length > 0) {
      els.customerPlanSelect.innerHTML = '';
      state.plans.forEach((plan) => {
        const option = document.createElement('option');
        option.value = plan.code;
        option.textContent = `${plan.name} (${brl(plan.monthlyFeeCents || 0)}/mês | ${plan.monthlyMessageLimit} msg | IA ${aiTierLabel(plan.aiTier)})`;
        els.customerPlanSelect.appendChild(option);
      });
    }
    renderPlans();
    state.customers = customers;
    state.payments = payments;
    state.costSnapshots = costSnapshots;
    state.agentConfig = agentConfig;
    state.agentRooms = Array.isArray(agentRoomsPayload?.rooms) ? agentRoomsPayload.rooms : [];
    state.familySquadStatus = familySquadPayload?.status || null;
    renderAgentConfig();
    renderFamilySquadStatus();
    renderAgentRooms();

    if (!state.selectedAgentRoomId && state.agentRooms.length > 0) {
      state.selectedAgentRoomId = state.agentRooms[0].id;
    } else if (state.selectedAgentRoomId && !state.agentRooms.some((room) => room.id === state.selectedAgentRoomId)) {
      state.selectedAgentRoomId = state.agentRooms[0]?.id ?? null;
    }

    if (state.selectedAgentRoomId) {
      const roomPayload = await api(`/admin/agents/rooms/${state.selectedAgentRoomId}`);
      state.selectedAgentRoom = roomPayload.room || null;
    } else {
      state.selectedAgentRoom = null;
    }
    renderAgentRoomDetail();

    const customerStillExists = state.customers.some((c) => c.id === state.selectedCustomerId);
    if (!customerStillExists) {
      resetSelection();
    }

    renderCustomers();
    renderPayments();
    renderCostSnapshots();

    if (state.selectedCustomerId) {
      await Promise.all([
        loadCustomerSummary(state.selectedCustomerId),
        loadCustomerTransactions(state.selectedCustomerId)
      ]);
    }
  } catch (error) {
    console.error(error);
    if (error.message === 'UNAUTHORIZED') {
      clearAuthToken();
      stopAutoRefresh();
      showDashboard(false);
      setNotice('');
      return;
    }

    if (!silent) {
      setNotice(`Falha ao carregar painel: ${error.message}`, 'error');
    }
  }
}

async function requireCustomerAction(action) {
  if (!state.selectedCustomerId) {
    setNotice('Selecione um cliente primeiro.', 'error');
    return;
  }

  await action(state.selectedCustomerId);
  await loadAll();
}

function setActiveFilter(filter) {
  state.customerFilter = filter;
  document.querySelectorAll('.filter-chip').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.filter === filter);
  });
  renderCustomers();
}

function startAutoRefresh() {
  stopAutoRefresh();
  state.refreshTimer = setInterval(() => {
    loadAll({ silent: true });
  }, 25000);
}

function stopAutoRefresh() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

els.loginBtn.addEventListener('click', async () => {
  try {
    await login();
    showDashboard(true);
    setNotice('Login realizado com sucesso.', 'success');
    await loadAll();
    startAutoRefresh();
  } catch (error) {
    console.error(error);
    setNotice('');
    els.sessionInfo.textContent = `Falha no login: ${error.message}`;
  }
});

els.adminPassword.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    els.loginBtn.click();
  }
});

els.logoutBtn.addEventListener('click', () => {
  clearAuthToken();
  stopAutoRefresh();
  resetSelection();
  state.customers = [];
  state.payments = [];
  renderCustomers();
  renderPayments();
  showDashboard(false);
  setNotice('');
  els.sessionInfo.textContent = 'Sessão encerrada.';
});

els.customerSearch.addEventListener('input', (event) => {
  state.search = event.target.value;
  renderCustomers();
});

document.querySelectorAll('.filter-chip').forEach((button) => {
  button.addEventListener('click', () => {
    setActiveFilter(button.dataset.filter);
  });
});

els.syncStatus.addEventListener('click', async () => {
  try {
    const result = await api('/admin/subscriptions/sync-status', { method: 'POST' });
    setNotice(`Sincronização concluída. Marcados em atraso: ${result.pastDueMarked}.`, 'success');
    await loadAll();
  } catch (error) {
    console.error(error);
    setNotice(`Erro ao sincronizar status: ${error.message}`, 'error');
  }
});

els.runRenewals.addEventListener('click', async () => {
  try {
    const run = await api('/admin/billing/renewals/run', {
      method: 'POST',
      body: { daysAhead: 2 }
    });
    setNotice(
      `Renovações: criadas=${run.result.created}, pendentes=${run.result.alreadyPending}, falhas=${run.result.failed}.`,
      'success'
    );
    await loadAll();
  } catch (error) {
    console.error(error);
    setNotice(`Erro ao gerar renovações: ${error.message}`, 'error');
  }
});

els.runProactive.addEventListener('click', async () => {
  try {
    const run = await api('/admin/automation/proactive/run', {
      method: 'POST',
      body: { dryRun: false, customerLimit: 1000 }
    });
    const r = run.result;
    setNotice(
      `Alertas proativos: clientes=${r.customersEligible}/${r.customersScanned}, lembretes=${r.reminderAlertsSent}/${r.reminderAlertsTriggered}, limites=${r.limitAlertsSent}/${r.limitAlertsTriggered}, resumo semanal=${r.weeklySummariesSent}/${r.weeklySummariesTriggered}, falhas=${r.failures.length}.`,
      r.failures.length > 0 ? 'error' : 'success'
    );
    await loadAll();
  } catch (error) {
    console.error(error);
    setNotice(`Erro ao rodar alertas proativos: ${error.message}`, 'error');
  }
});

els.saveCostSnapshot.addEventListener('click', async () => {
  try {
    const result = await api('/admin/costs/snapshots', { method: 'POST' });
    setNotice(`Snapshot salvo em ${formatDateOnly(result.snapshotDate)}.`, 'success');
    await loadAll();
  } catch (error) {
    console.error(error);
    setNotice(`Erro ao salvar snapshot: ${error.message}`, 'error');
  }
});

els.agentRoomRefresh?.addEventListener('click', async () => {
  try {
    await loadAgentRooms({ keepSelection: true });
    setNotice('Sala dos agentes atualizada.', 'success');
  } catch (error) {
    console.error(error);
    setNotice(`Erro ao atualizar sala dos agentes: ${error.message}`, 'error');
  }
});

els.familySquadActivate?.addEventListener('click', async () => {
  try {
    const instruction = els.agentRoomInstruction?.value?.trim();
    const payload = await api('/admin/agents/family-squad/activate', {
      method: 'POST',
      body: {
        openKickoffRoom: true,
        kickoffInstruction: instruction || undefined
      }
    });
    state.agentConfig = payload.config || state.agentConfig;
    state.familySquadStatus = payload.status || state.familySquadStatus;
    await loadAgentRooms({ keepSelection: false });
    if (payload.room?.id) {
      state.selectedAgentRoomId = payload.room.id;
      await selectAgentRoom(payload.room.id);
    }
    setNotice('Equipe dedicada do plano família ativada com sucesso.', 'success');
  } catch (error) {
    console.error(error);
    setNotice(`Erro ao ativar equipe do plano família: ${error.message}`, 'error');
  }
});

els.familySquadRun?.addEventListener('click', async () => {
  try {
    const instruction = els.agentRoomInstruction?.value?.trim();
    const payload = await api('/admin/agents/family-squad/rooms', {
      method: 'POST',
      body: {
        title: 'Diagnóstico contínuo: Plano Família',
        instruction: instruction || undefined,
        ensureActive: true
      }
    });
    state.familySquadStatus = payload.status || state.familySquadStatus;
    await loadAgentRooms({ keepSelection: false });
    if (payload.room?.id) {
      state.selectedAgentRoomId = payload.room.id;
      await selectAgentRoom(payload.room.id);
    }
    const auto = payload.autoActivated ? ' (squad foi ativada automaticamente)' : '';
    setNotice(`Diagnóstico do plano família iniciado${auto}.`, 'success');
  } catch (error) {
    console.error(error);
    setNotice(`Erro ao rodar diagnóstico da squad família: ${error.message}`, 'error');
  }
});

els.agentConfigSave?.addEventListener('click', async () => {
  try {
    const coordinatorAgent = els.agentCoordinatorSelect?.value;
    if (!coordinatorAgent) {
      setNotice('Escolha um coordenador para salvar.', 'error');
      return;
    }
    const payload = await api('/admin/agents/config', {
      method: 'PUT',
      body: { coordinatorAgent }
    });
    state.agentConfig = payload.config || state.agentConfig;
    renderAgentConfig();
    setNotice('Coordenador geral atualizado com sucesso.', 'success');
  } catch (error) {
    console.error(error);
    setNotice(`Erro ao salvar coordenador: ${error.message}`, 'error');
  }
});

els.agentRoomStart?.addEventListener('click', async () => {
  try {
    const title = els.agentRoomTitle?.value?.trim();
    const instruction = els.agentRoomInstruction?.value?.trim();
    const coordinatorAgent = els.agentCoordinatorSelect?.value || undefined;
    if (!instruction || instruction.length < 4) {
      setNotice('Escreva uma instrução com pelo menos 4 caracteres.', 'error');
      return;
    }
    const payload = await api('/admin/agents/rooms', {
      method: 'POST',
      body: {
        title: title || undefined,
        instruction,
        coordinatorAgent
      }
    });
    if (els.agentRoomInstruction) els.agentRoomInstruction.value = '';
    if (els.agentRoomTitle) els.agentRoomTitle.value = '';

    await loadAgentRooms({ keepSelection: false });
    state.selectedAgentRoomId = payload.room?.id || state.selectedAgentRoomId;
    if (state.selectedAgentRoomId) {
      await selectAgentRoom(state.selectedAgentRoomId);
    }
    setNotice('Reunião criada e processada pelos agentes.', 'success');
  } catch (error) {
    console.error(error);
    setNotice(`Erro ao iniciar reunião: ${error.message}`, 'error');
  }
});

els.agentRoomSend?.addEventListener('click', async () => {
  try {
    if (!state.selectedAgentRoomId) {
      setNotice('Selecione uma sala antes de enviar instrução.', 'error');
      return;
    }
    const instruction = els.agentRoomFollowup?.value?.trim();
    if (!instruction || instruction.length < 4) {
      setNotice('Escreva uma instrução válida para a sala.', 'error');
      return;
    }
    await api(`/admin/agents/rooms/${state.selectedAgentRoomId}/instructions`, {
      method: 'POST',
      body: {
        instruction,
        coordinatorAgent: els.agentCoordinatorSelect?.value || undefined
      }
    });
    if (els.agentRoomFollowup) els.agentRoomFollowup.value = '';
    await loadAgentRooms({ keepSelection: true });
    setNotice('Instrução enviada para os agentes.', 'success');
  } catch (error) {
    console.error(error);
    setNotice(`Erro ao enviar instrução para sala: ${error.message}`, 'error');
  }
});

els.paySetup.addEventListener('click', () => requireCustomerAction(async (customerId) => {
  await api(`/admin/customers/${customerId}/subscription/payments`, {
    method: 'POST',
    body: { paymentType: 'setup', gateway: 'manual' }
  });
  setNotice('Pagamento de entrada registrado.', 'success');
}));

els.payMonthly.addEventListener('click', () => requireCustomerAction(async (customerId) => {
  await api(`/admin/customers/${customerId}/subscription/payments`, {
    method: 'POST',
    body: { paymentType: 'monthly', gateway: 'manual' }
  });
  setNotice('Mensalidade registrada.', 'success');
}));

els.chargeSetup.addEventListener('click', () => requireCustomerAction(async (customerId) => {
  const result = await api(`/admin/billing/customers/${customerId}/charges`, {
    method: 'POST',
    body: { paymentType: 'setup' }
  });
  if (result.charge.invoiceUrl) {
    window.alert(`Cobrança criada. Link:\n${result.charge.invoiceUrl}`);
  }
  setNotice('Cobrança de entrada gerada no Asaas.', 'success');
}));

els.chargeMonthly.addEventListener('click', () => requireCustomerAction(async (customerId) => {
  const result = await api(`/admin/billing/customers/${customerId}/charges`, {
    method: 'POST',
    body: { paymentType: 'monthly' }
  });
  if (result.charge.invoiceUrl) {
    window.alert(`Cobrança criada. Link:\n${result.charge.invoiceUrl}`);
  }
  setNotice('Cobrança mensal gerada no Asaas.', 'success');
}));

els.addReferral.addEventListener('click', () => requireCustomerAction(async (customerId) => {
  await api(`/admin/customers/${customerId}/subscription/referrals`, {
    method: 'POST',
    body: { delta: 1 }
  });
  setNotice('Indicação adicionada.', 'success');
}));

els.activateTrial.addEventListener('click', () => requireCustomerAction(async (customerId) => {
  await api(`/admin/customers/${customerId}/subscription/trial`, {
    method: 'POST',
    body: { days: 5 }
  });
  setNotice('Período de teste de 5 dias ativado.', 'success');
}));

els.applyPlan.addEventListener('click', () => requireCustomerAction(async (customerId) => {
  const planCode = els.customerPlanSelect.value;
  await api(`/admin/customers/${customerId}/subscription/plan`, {
    method: 'POST',
    body: { planCode }
  });
  const plan = state.plans.find((item) => item.code === planCode);
  setNotice(`Plano atualizado para ${plan?.name || planCode}.`, 'success');
}));

els.statusActive.addEventListener('click', () => requireCustomerAction(async (customerId) => {
  await api(`/admin/customers/${customerId}/subscription/status`, {
    method: 'POST',
    body: { status: 'active' }
  });
  setNotice('Assinatura ativada.', 'success');
}));

els.statusCancel.addEventListener('click', () => requireCustomerAction(async (customerId) => {
  await api(`/admin/customers/${customerId}/subscription/status`, {
    method: 'POST',
    body: { status: 'canceled' }
  });
  setNotice('Assinatura cancelada.', 'success');
}));

els.deleteCustomer.addEventListener('click', () => requireCustomerAction(async (customerId) => {
  const customer = state.customers.find((item) => item.id === customerId);
  const label = customer ? `${customer.name || 'Sem nome'} (${customer.whatsappNumber})` : customerId;
  const confirmed = window.confirm(
    `Excluir cliente ${label}?\n\nEssa ação remove histórico, transações, pagamentos e assinatura desse cliente.`
  );

  if (!confirmed) {
    return;
  }

  await api(`/admin/customers/${customerId}`, { method: 'DELETE' });
  resetSelection();
  setNotice('Cliente excluído com sucesso.', 'success');
}));

resetSelection();

loadSession().then((ok) => {
  if (!ok) {
    showDashboard(false);
    return;
  }

  showDashboard(true);
  loadAll();
  startAutoRefresh();
});

// ── JARDES ────────────────────────────────────────
const jardesChat = document.getElementById('jardesChat');
const jardesInput = document.getElementById('jardesInput');
const jardesSend = document.getElementById('jardesSend');
const jardesMetrics = document.getElementById('jardesMetrics');

const jardesHistory = [];

function appendJardesMsg(role, text) {
  const div = document.createElement('div');
  div.className = `jardes-msg ${role}`;
  div.textContent = text;
  jardesChat.appendChild(div);
  jardesChat.scrollTop = jardesChat.scrollHeight;
  return div;
}

async function sendJardes() {
  const text = jardesInput.value.trim();
  if (!text) return;

  jardesInput.value = '';
  jardesInput.disabled = true;
  jardesSend.disabled = true;

  appendJardesMsg('user', text);
  jardesHistory.push({ role: 'user', content: text });

  const typing = appendJardesMsg('typing', 'Jardes está pensando...');

  try {
    const res = await api('/admin/jardes/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages: jardesHistory.slice(-20),
        includeMetrics: jardesMetrics.checked
      })
    });

    typing.remove();
    const reply = res.reply ?? 'Sem resposta.';
    appendJardesMsg('assistant', reply);
    jardesHistory.push({ role: 'assistant', content: reply });
  } catch (err) {
    typing.remove();
    appendJardesMsg('assistant', `Erro ao contatar o Jardes: ${err.message}`);
  } finally {
    jardesInput.disabled = false;
    jardesSend.disabled = false;
    jardesInput.focus();
  }
}

jardesSend.addEventListener('click', sendJardes);

jardesInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendJardes();
  }
});

// Mensagem de boas-vindas ao carregar o dashboard
setTimeout(() => {
  if (jardesChat.children.length === 0) {
    appendJardesMsg('assistant', 'Jardes online. Pronto para operar, Felipe. O que você precisa agora?');
  }
}, 1500);
