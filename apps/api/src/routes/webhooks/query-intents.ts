import {
  logConversation,
  monthlySummary,
  getTransactionList,
  getCustomerFinancialCapacity,
  createSavingsGoal,
  getActiveSavingsGoals,
  getSavingsGoalMonthlyProgress,
  cancelActiveSavingsGoals,
  createFamilyVault,
  getActiveFamilyVaults,
  getFamilyVaultProgress,
  cancelActiveFamilyVaults,
  familyMonthlySummary,
} from '../../services/ledger.js';
import { config } from '../../config.js';
import type { ParsedIntent } from '../../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function centsToBrl(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function normalizeHumanText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function categoryEmoji(category: string): string {
  const key = normalizeHumanText(category);
  if (key.includes('mercado') || key.includes('supermercado')) return '🛒';
  if (key.includes('alimentacao') || key.includes('lanche') || key.includes('restaurante')) return '🍎';
  if (key.includes('transporte') || key.includes('uber') || key.includes('gasolina')) return '🚚';
  if (key.includes('moradia') || key.includes('aluguel')) return '🏠';
  if (key.includes('educacao') || key.includes('faculdade') || key.includes('curso')) return '📚';
  if (key.includes('beleza') || key.includes('manicure')) return '✂️';
  if (key.includes('shopping')) return '🛍️';
  if (key.includes('saude') || key.includes('farmacia') || key.includes('medico')) return '🏥';
  if (key.includes('lazer') || key.includes('cinema') || key.includes('viagem')) return '🎉';
  if (key.includes('outros')) return '📦';
  return '💸';
}

function decorateCategory(category: string): string {
  return `${categoryEmoji(category)} ${category}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type HandlerResult = {
  replyText: string;
  responseBody: Record<string, unknown>;
};

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleQueryIntents(p: {
  customerId: string;
  customerName?: string | null;
  from: string;
  now: Date;
  intent: ParsedIntent;
}): Promise<HandlerResult | null> {
  const { customerId, from, now, intent } = p;

  if (intent.type === 'ask-breakdown') {
    const summary = await monthlySummary(customerId, intent.month, intent.year);
    const categories = summary.byCategory
      .filter((item) => item.amountCents > 0)
      .slice(0, 8)
      .map((item) => `• ${decorateCategory(item.category)}: ${centsToBrl(item.amountCents)}`);
    const outText = categories.length > 0
      ? [
        `Detalhamento ${String(intent.month).padStart(2, '0')}/${intent.year}:`,
        ...categories,
        'Se quiser, eu explico também o que mais pesou no seu mês.'
      ].join('\n')
      : `Ainda não há categorias com gastos em ${String(intent.month).padStart(2, '0')}/${intent.year}. Quer lançar um gasto agora?`;
    await logConversation(customerId, 'outbound', outText, {
      intent: intent.type,
      month: intent.month,
      year: intent.year
    });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
  }

  if (intent.type === 'ask-expense-period') {
    const outText = [
      'Claro! Qual período você quer consultar?',
      '',
      '1️⃣ Este mês',
      '2️⃣ Mês passado',
      '3️⃣ Esta semana',
      '4️⃣ Hoje',
      '5️⃣ Últimos 2 meses',
      '6️⃣ Últimos 3 meses'
    ].join('\n');
    await logConversation(customerId, 'outbound', outText, { intent: intent.type });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
  }

  if (intent.type === 'full-expense-list') {
    const tz = config.defaultTimezone ?? 'America/Sao_Paulo';
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const startOfDay = new Date(nowLocal);
    startOfDay.setHours(0, 0, 0, 0);

    let periodDisplay: string;
    let since: Date;
    let until: Date;

    if (intent.period === 'today') {
      since = new Date(now.getTime() - (nowLocal.getTime() - startOfDay.getTime()));
      until = new Date(since.getTime() + 86400000);
      periodDisplay = `Hoje (${String(nowLocal.getDate()).padStart(2, '0')}/${String(nowLocal.getMonth() + 1).padStart(2, '0')}/${nowLocal.getFullYear()})`;
    } else if (intent.period === 'this-week') {
      const dow = nowLocal.getDay();
      const diff = nowLocal.getTime() - startOfDay.getTime();
      since = new Date(now.getTime() - diff - (dow === 0 ? 6 : dow - 1) * 86400000);
      until = new Date(since.getTime() + 7 * 86400000);
      periodDisplay = `Esta semana`;
    } else if (intent.period === 'this-month') {
      const m = nowLocal.getMonth() + 1;
      const y = nowLocal.getFullYear();
      since = new Date(`${y}-${String(m).padStart(2, '0')}-01T00:00:00`);
      until = new Date(m === 12 ? `${y + 1}-01-01T00:00:00` : `${y}-${String(m + 1).padStart(2, '0')}-01T00:00:00`);
      periodDisplay = `${String(m).padStart(2, '0')}/${y}`;
    } else if (intent.period === 'last-month') {
      const m = nowLocal.getMonth() === 0 ? 12 : nowLocal.getMonth();
      const y = nowLocal.getMonth() === 0 ? nowLocal.getFullYear() - 1 : nowLocal.getFullYear();
      since = new Date(`${y}-${String(m).padStart(2, '0')}-01T00:00:00`);
      until = new Date(`${nowLocal.getFullYear()}-${String(nowLocal.getMonth() + 1).padStart(2, '0')}-01T00:00:00`);
      periodDisplay = `${String(m).padStart(2, '0')}/${y}`;
    } else if (intent.period === 'last-2-months') {
      const curM = nowLocal.getMonth() + 1;
      const curY = nowLocal.getFullYear();
      const startM = curM <= 2 ? curM + 10 : curM - 2;
      const startY = curM <= 2 ? curY - 1 : curY;
      since = new Date(`${startY}-${String(startM).padStart(2, '0')}-01T00:00:00`);
      until = new Date(curM === 12 ? `${curY + 1}-01-01T00:00:00` : `${curY}-${String(curM + 1).padStart(2, '0')}-01T00:00:00`);
      periodDisplay = `Últimos 2 meses`;
    } else {
      const curM = nowLocal.getMonth() + 1;
      const curY = nowLocal.getFullYear();
      const startM = curM <= 3 ? curM + 9 : curM - 3;
      const startY = curM <= 3 ? curY - 1 : curY;
      since = new Date(`${startY}-${String(startM).padStart(2, '0')}-01T00:00:00`);
      until = new Date(curM === 12 ? `${curY + 1}-01-01T00:00:00` : `${curY}-${String(curM + 1).padStart(2, '0')}-01T00:00:00`);
      periodDisplay = `Últimos 3 meses`;
    }

    const transactions = await getTransactionList(customerId, { since, until });

    if (transactions.length === 0) {
      const outText = `📋 Extrato — ${periodDisplay}:\n\nNenhum lançamento encontrado neste período.`;
      await logConversation(customerId, 'outbound', outText, { intent: intent.type, period: intent.period });
      return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
    }

    const totalExpenseCents = transactions.filter(t => t.kind === 'expense').reduce((s, t) => s + t.amountCents, 0);
    const totalIncomeCents = transactions.filter(t => t.kind === 'income').reduce((s, t) => s + t.amountCents, 0);

    const formatLine = (t: typeof transactions[0]): string => {
      const d = new Date(t.occurredAt);
      const localStr = d.toLocaleString('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const [datePart, timePart] = localStr.split(', ');
      const prefix = t.kind === 'income' ? '💰' : '💸';
      return `${datePart} ${timePart ?? ''} — ${categoryEmoji(t.category)} ${t.category} — ${prefix} ${centsToBrl(t.amountCents)}`;
    };

    const displayed = transactions.slice(0, 50);
    const truncated = transactions.length > 50;

    const lines = [
      `📋 Extrato — ${periodDisplay}:`,
      '',
      ...displayed.map(formatLine),
      ...(truncated ? [`\n(mostrando 50 de ${transactions.length} lançamentos)`] : []),
      '',
      `💸 Total gastos: ${centsToBrl(totalExpenseCents)}`,
      ...(totalIncomeCents > 0 ? [`💰 Total receitas: ${centsToBrl(totalIncomeCents)}`] : []),
      `📦 ${transactions.length} lançamento(s)`
    ];

    const outText = lines.join('\n');
    await logConversation(customerId, 'outbound', outText, { intent: intent.type, period: intent.period, count: transactions.length });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
  }

  if (intent.type === 'set-savings-goal-missing-info') {
    const deadlinePart = intent.deadlineIso
      ? ` para ${new Date(intent.deadlineIso + 'T12:00:00').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}`
      : '';
    const outText = `Claro, adoro isso! 🎯\n\nMe diz: quanto você quer juntar${deadlinePart}? E pra quê é essa meta?\n\nManda assim: "meta de R$ 2.000 para viagem até julho"`;
    await logConversation(customerId, 'outbound', outText, { intent: intent.type });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
  }

  if (intent.type === 'set-savings-goal') {
    const capacity = await getCustomerFinancialCapacity(customerId);
    const deadlineDate = new Date(intent.deadlineIso + 'T23:59:59');
    const monthsRemaining = Math.max(
      1,
      (deadlineDate.getFullYear() - now.getFullYear()) * 12 + (deadlineDate.getMonth() - now.getMonth()) + 1
    );
    const idealMonthlyTargetCents = Math.ceil(intent.targetAmountCents / monthsRemaining);
    const surplusCents = capacity.avgMonthlySurplusCents;
    const feasible = surplusCents >= idealMonthlyTargetCents;
    const monthlyTargetCents = Math.min(idealMonthlyTargetCents, Math.max(surplusCents, 0));

    const goalId = await createSavingsGoal({
      customerId,
      description: intent.description,
      targetCents: intent.targetAmountCents,
      deadlineDate: new Date(intent.deadlineIso + 'T12:00:00'),
      monthlyTargetCents: idealMonthlyTargetCents
    });

    const deadlineFmt = new Date(intent.deadlineIso + 'T12:00:00').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const lines: string[] = [
      `🎯 Meta criada: *${intent.description}*`,
      `💰 Valor alvo: ${centsToBrl(intent.targetAmountCents)}`,
      `📅 Prazo: ${deadlineFmt} (${monthsRemaining} mes${monthsRemaining > 1 ? 'es' : ''})`,
      `📊 Meta mensal: ${centsToBrl(idealMonthlyTargetCents)}`,
      ''
    ];

    void monthlyTargetCents;

    if (feasible) {
      lines.push(`✅ Seu histórico mostra sobra média de ${centsToBrl(surplusCents)}/mês — você consegue cumprir essa meta!`);
    } else if (surplusCents > 0) {
      const realisticMonths = Math.ceil(intent.targetAmountCents / surplusCents);
      lines.push(`⚠️ Sua sobra média é ${centsToBrl(surplusCents)}/mês. Para este valor, você precisaria de ~${realisticMonths} meses.`);
      lines.push(`Vou te acompanhar e avisar se os gastos estiverem ameaçando o objetivo.`);
    } else {
      lines.push(`⚠️ Seu histórico não mostra sobra clara ainda. Vou monitorar e te alertar se os gastos ameaçarem a meta.`);
    }

    lines.push('');
    lines.push(`Vou te acompanhar todo mês e avisar quando algo estiver fora do trilho. 💪`);

    const outText = lines.join('\n');
    await logConversation(customerId, 'outbound', outText, { intent: intent.type, goalId });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
  }

  if (intent.type === 'ask-savings-goal-status') {
    const goals = await getActiveSavingsGoals(customerId);
    if (goals.length === 0) {
      const outText = `Você não tem nenhuma meta de poupança ativa no momento. 📭\n\nQuer criar uma? Me diz quanto quer guardar e para quando!`;
      await logConversation(customerId, 'outbound', outText, { intent: intent.type });
      return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
    }

    const goal = goals[0];
    const progress = await getSavingsGoalMonthlyProgress({ customerId, goalCreatedAt: goal.createdAt });
    const deadlineDate = goal.deadlineDate;
    const monthsRemaining = Math.max(
      1,
      (deadlineDate.getFullYear() - now.getFullYear()) * 12 + (deadlineDate.getMonth() - now.getMonth()) + 1
    );
    const projectedTotal = progress.avgMonthlySurplusCents * monthsRemaining;
    const onTrack = projectedTotal >= goal.targetCents;
    const deadlineFmt = deadlineDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

    const lines = [
      `🎯 Meta: *${goal.description}*`,
      `💰 Alvo: ${centsToBrl(goal.targetCents)} até ${deadlineFmt}`,
      `📊 Meta mensal: ${centsToBrl(goal.monthlyTargetCents)}`,
      `📈 Sobra este mês: ${centsToBrl(progress.currentMonthSurplusCents)}`,
      `📉 Média histórica de sobra: ${centsToBrl(progress.avgMonthlySurplusCents)}`,
      '',
      onTrack
        ? `✅ Você está no caminho certo! Projetando ${centsToBrl(projectedTotal)} até o prazo.`
        : `⚠️ Risco de não bater a meta. Projetando ${centsToBrl(projectedTotal)} — faltam ${centsToBrl(goal.targetCents - projectedTotal)} para cobrir.`
    ];

    const outText = lines.join('\n');
    await logConversation(customerId, 'outbound', outText, { intent: intent.type, goalId: goal.id });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
  }

  if (intent.type === 'cancel-savings-goal') {
    const cancelled = await cancelActiveSavingsGoals(customerId);
    const outText = cancelled > 0
      ? `Meta cancelada. ✅ Se quiser criar uma nova, é só me dizer quanto quer guardar e para quando!`
      : `Você não tem nenhuma meta ativa para cancelar. 📭`;
    await logConversation(customerId, 'outbound', outText, { intent: intent.type, cancelled });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
  }

  if (intent.type === 'set-family-vault') {
    try {
      const deadlineDate = new Date(intent.deadlineIso + 'T12:00:00');
      const deadlineDate2 = new Date(intent.deadlineIso + 'T23:59:59');
      const monthsRemaining = Math.max(
        1,
        (deadlineDate.getFullYear() - now.getFullYear()) * 12 + (deadlineDate.getMonth() - now.getMonth()) + 1
      );
      const monthlyTargetCents = Math.ceil(intent.targetAmountCents / monthsRemaining);
      const vaultResult = await createFamilyVault({
        customerId,
        description: intent.description,
        targetCents: intent.targetAmountCents,
        deadlineDate: deadlineDate2,
        monthlyTargetCents
      });
      const deadlineFmt = deadlineDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
      const outText = [
        `🏦 Cofre criado para a família: *${intent.description}*`,
        `💰 Alvo: ${centsToBrl(intent.targetAmountCents)} até ${deadlineFmt}`,
        `📊 Meta mensal da família: ${centsToBrl(monthlyTargetCents)}`,
        ``,
        `Todos os membros contribuem juntos. Vou monitorar e avisar se o ritmo estiver fora do trilho. 💪`
      ].join('\n');
      await logConversation(customerId, 'outbound', outText, { intent: intent.type, vaultId: vaultResult.vaultId });
      return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
    } catch (err) {
      const isNoGroup = err instanceof Error && err.message === 'family_group_not_found';
      const outText = isNoGroup
        ? `Você precisa estar em um grupo familiar para criar cofres compartilhados. Crie um grupo primeiro com "criar grupo familiar"! 👨‍👩‍👧`
        : `Não consegui criar o cofre agora. Tente novamente.`;
      await logConversation(customerId, 'outbound', outText, { intent: intent.type });
      return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
    }
  }

  if (intent.type === 'ask-family-vault-status') {
    const vaults = await getActiveFamilyVaults(customerId);
    if (vaults.length === 0) {
      const outText = `A família não tem nenhum cofre ativo no momento. 📭\n\nQuer criar um? É só dizer: "cofre familiar de R$X para [objetivo] em [mês]"!`;
      await logConversation(customerId, 'outbound', outText, { intent: intent.type });
      return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
    }

    const lines: string[] = [`🏦 *Cofres da família:*`, ``];
    for (const vault of vaults) {
      const progress = await getFamilyVaultProgress({ groupId: vault.groupId, vaultCreatedAt: vault.createdAt, now });
      const deadlineDate = vault.deadlineDate;
      const monthsRemaining = Math.max(
        1,
        (deadlineDate.getFullYear() - now.getFullYear()) * 12 + (deadlineDate.getMonth() - now.getMonth()) + 1
      );
      const projected = progress.avgMonthlySurplusCents * monthsRemaining;
      const onTrack = projected >= vault.targetCents;
      const deadlineFmt = deadlineDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
      lines.push(
        `🎯 *${vault.description}*`,
        `   Alvo: ${centsToBrl(vault.targetCents)} até ${deadlineFmt}`,
        `   Meta/mês: ${centsToBrl(vault.monthlyTargetCents)} | Sobra atual: ${centsToBrl(progress.currentMonthSurplusCents)}`,
        onTrack
          ? `   ✅ No caminho certo (projeção: ${centsToBrl(projected)})`
          : `   ⚠️ Em risco (projeção: ${centsToBrl(projected)}, faltam ${centsToBrl(vault.targetCents - projected)})`,
        ``
      );
    }

    const outText = lines.join('\n');
    await logConversation(customerId, 'outbound', outText, { intent: intent.type, vaultCount: vaults.length });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
  }

  if (intent.type === 'cancel-family-vault') {
    const cancelled = await cancelActiveFamilyVaults(customerId);
    const outText = cancelled > 0
      ? `Cofre(s) da família cancelado(s). ✅`
      : `Não há cofres familiares ativos para cancelar. 📭`;
    await logConversation(customerId, 'outbound', outText, { intent: intent.type, cancelled });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
  }

  if (intent.type === 'ask-family-meeting') {
    const summary = await familyMonthlySummary(customerId, now, config.defaultTimezone ?? 'America/Sao_Paulo');
    if (!summary) {
      const outText = `Você não está em um grupo familiar ainda. Crie um grupo para usar essa função! 👨‍👩‍👧`;
      await logConversation(customerId, 'outbound', outText, { intent: intent.type });
      return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
    }

    const monthName = new Date(summary.year, summary.month - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const topCategories = summary.byCategory.slice(0, 5)
      .map(c => `   • ${c.category}: ${centsToBrl(c.amountCents)}`).join('\n');
    const memberLines = summary.memberExpenses
      .map(m => `   • ${m.name ?? 'Membro'}: ${centsToBrl(m.amountCents)}`).join('\n');

    const statusLine = summary.netCents >= 0
      ? `✅ Saldo positivo: ${centsToBrl(summary.netCents)}`
      : `⚠️ Saldo negativo: ${centsToBrl(Math.abs(summary.netCents))}`;

    const outText = [
      `📋 *Reunião Financeira — ${monthName}*`,
      ``,
      `💰 Entradas: ${centsToBrl(summary.totalIncomeCents)}`,
      `💸 Saídas: ${centsToBrl(summary.totalExpenseCents)}`,
      `${statusLine}`,
      ``,
      `📊 *Top categorias:*`,
      topCategories || `   Sem dados`,
      ``,
      `👥 *Gastos por membro:*`,
      memberLines || `   Sem dados`,
      ``,
      `🎯 *Meta para o próximo mês:*`,
      summary.netCents < 0
        ? `   Cortar ${centsToBrl(Math.abs(summary.netCents))} dos gastos para equilibrar a casa.`
        : `   Destinar ${centsToBrl(Math.round(summary.netCents * 0.3))} para os cofres da família.`
    ].join('\n');

    await logConversation(customerId, 'outbound', outText, { intent: intent.type, month: summary.month, year: summary.year });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
  }

  if (intent.type === 'ask-couple-balance') {
    const summary = await familyMonthlySummary(customerId, now, config.defaultTimezone ?? 'America/Sao_Paulo');
    if (!summary || summary.members.length < 2) {
      const outText = summary
        ? `Preciso de pelo menos 2 membros no grupo familiar para mostrar o balanço do casal. Convide seu parceiro(a)! 💑`
        : `Você não está em um grupo familiar ainda. Crie um grupo e convide seu parceiro(a) para usar o modo casal! 💑`;
      await logConversation(customerId, 'outbound', outText, { intent: intent.type });
      return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
    }

    const sorted = [...summary.memberExpenses].sort((a, b) => b.amountCents - a.amountCents);
    const [first, second] = sorted;
    const diff = (first?.amountCents ?? 0) - (second?.amountCents ?? 0);
    const monthName = new Date(summary.year, summary.month - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

    const memberLines = sorted.map(m => `   • ${m.name ?? 'Membro'}: ${centsToBrl(m.amountCents)}`).join('\n');
    const balanceLine = diff === 0
      ? `   ✅ Gastos equilibrados entre vocês!`
      : `   ${first?.name ?? 'Membro 1'} gastou ${centsToBrl(diff)} a mais que ${second?.name ?? 'Membro 2'}.`;

    const outText = [
      `💑 *Balanço do Casal — ${monthName}*`,
      ``,
      `💸 *Gastos por pessoa:*`,
      memberLines,
      ``,
      balanceLine,
      ``,
      `📊 Total do grupo: ${centsToBrl(summary.totalExpenseCents)}`,
      `💰 Entradas: ${centsToBrl(summary.totalIncomeCents)}`,
      summary.netCents >= 0
        ? `✅ Saldo do casal: ${centsToBrl(summary.netCents)}`
        : `⚠️ Déficit do casal: ${centsToBrl(Math.abs(summary.netCents))}`
    ].join('\n');

    await logConversation(customerId, 'outbound', outText, { intent: intent.type, month: summary.month, year: summary.year });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, intent } };
  }

  return null;
}
