import {
  logConversation,
  createFamilyGroup,
  joinFamilyGroupByCode,
  upsertFamilySpendingLimit,
  clearFamilySpendingLimit,
  listFamilySpendingLimits,
  familySpendingLimitStatuses,
  familyMonthlySummary,
  getFamilyContextForCustomer,
  leaveFamilyGroup,
} from '../../services/ledger.js';
import {
  planHasFeature,
  featureLabel,
  minimumPlanForFeature,
  type PlanFeature,
} from '../../services/plans.js';
import { config } from '../../config.js';

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

function periodLabel(period: 'daily' | 'weekly' | 'monthly'): string {
  if (period === 'daily') return 'diário';
  if (period === 'weekly') return 'semanal';
  return 'mensal';
}

function periodEmoji(period: 'daily' | 'weekly' | 'monthly'): string {
  if (period === 'daily') return '📅';
  if (period === 'weekly') return '🗓️';
  return '📆';
}

function planLockedReply(params: {
  feature: PlanFeature;
  planName?: string;
  customerName?: string | null;
}): string {
  const required = minimumPlanForFeature(params.feature);
  const current = params.planName ?? 'atual';
  const firstName = params.customerName?.trim().split(/\s+/)[0];
  const namePrefix = firstName ? `${firstName}, ` : '';
  return [
    `${namePrefix}esse recurso (${featureLabel(params.feature)}) ainda não está no seu plano ${current}.`,
    `Para liberar, você precisa do plano ${required} ou superior.`,
    'Se quiser, eu te mostro em 30 segundos qual upgrade faz mais sentido para o seu uso.'
  ].join('\n');
}

async function featureGuardFn(params: {
  feature: PlanFeature;
  customerId: string;
  planCode: string;
  planName: string;
  customerName: string | null | undefined;
}): Promise<string | null> {
  if (planHasFeature(params.planCode, params.feature)) return null;
  const outText = planLockedReply({
    feature: params.feature,
    planName: params.planName,
    customerName: params.customerName,
  });
  await logConversation(params.customerId, 'outbound', outText, {
    intent: 'feature-locked',
    feature: params.feature,
    planCode: params.planCode,
  });
  return outText;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type HandlerResult = {
  replyText: string;
  responseBody: Record<string, unknown>;
};

export type FamilyIntentData =
  | { intent: 'create'; name?: string }
  | { intent: 'join'; code: string }
  | { intent: 'set_limit'; period: 'daily' | 'weekly' | 'monthly'; amountCents: number }
  | { intent: 'clear_limit'; period: 'daily' | 'weekly' | 'monthly' }
  | { intent: 'list_limits' }
  | { intent: 'summary' }
  | { intent: 'info' }
  | { intent: 'leave' };

export type FamilyParams = {
  customerId: string;
  customerName: string | null | undefined;
  from: string;
  now: Date;
  planCode: string;
  planName: string;
  data: FamilyIntentData;
};

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleFamilyIntents(p: FamilyParams): Promise<HandlerResult> {
  const { customerId, customerName, from, now, planCode, planName, data } = p;

  const guard = (feature: PlanFeature) =>
    featureGuardFn({ feature, customerId, planCode, planName, customerName });

  if (data.intent === 'create') {
    const locked = await guard('family_mode');
    if (locked) {
      return { replyText: locked, responseBody: { ok: true, to: from, replyText: locked, blockedFeature: 'family_mode' } };
    }
    const fallbackName = customerName ? `Família ${customerName}` : 'Minha Família';
    const group = await createFamilyGroup({
      ownerCustomerId: customerId,
      name: data.name || fallbackName,
    });
    const outText = [
      `👨‍👩‍👧‍👦 Grupo familiar pronto: ${group.name}`,
      `Código de convite: ${group.inviteCode}`,
      'Para entrar, a outra pessoa pode mandar: "entrar na família CÓDIGO".'
    ].join('\n');
    await logConversation(customerId, 'outbound', outText, { intent: 'family-create', groupId: group.groupId });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, familyGroup: group } };
  }

  if (data.intent === 'join') {
    const locked = await guard('family_mode');
    if (locked) {
      return { replyText: locked, responseBody: { ok: true, to: from, replyText: locked, blockedFeature: 'family_mode' } };
    }
    try {
      const joined = await joinFamilyGroupByCode({ customerId, inviteCode: data.code });
      const firstName = customerName?.trim().split(/\s+/)[0] ?? 'você';
      const outText = [
        `Olá, ${firstName}! 👋 Vi que você entrou no grupo familiar "${joined.groupName}". Bem-vindo(a)! ✅`,
        '',
        'Eu sou a Iara, sua assistente financeira no WhatsApp. Aqui está o que posso fazer por você:',
        '• Anotar seus gastos e receitas (ex: "gastei 80 no mercado")',
        '• Mostrar seu resumo do mês',
        '• Criar lembretes de contas a vencer',
        '• Definir metas financeiras',
        '• Ver o resumo da família (ex: "resumo da família")',
        '',
        `Membros no grupo: ${joined.activeMembers}/${joined.memberLimit}${joined.remainingSlots > 0 ? ` (${joined.remainingSlots} vaga(s) sobrando)` : ''}.`,
        'Me manda qualquer dúvida ou já começa registrando um gasto! 🚀'
      ].join('\n');
      await logConversation(customerId, 'outbound', outText, { intent: 'family-join', groupId: joined.groupId });
      return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, familyGroup: joined } };
    } catch (error) {
      if (error instanceof Error && error.message === 'family_group_not_found') {
        const outText = 'Não encontrei esse código de família. Confere o código e tenta de novo.';
        await logConversation(customerId, 'outbound', outText, { intent: 'family-join', status: 'not-found' });
        return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, status: 'family_group_not_found' } };
      }
      if (error instanceof Error && error.message === 'family_group_full') {
        const outText = [
          'O grupo familiar já está lotado! 😕',
          'O dono do grupo pode comprar vagas extras (R$29,90/mês por membro adicional) para liberar mais membros.',
          'Peça ao dono para entrar em contato comigo sobre isso.'
        ].join('\n');
        await logConversation(customerId, 'outbound', outText, { intent: 'family-join', status: 'full' });
        return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, status: 'family_group_full' } };
      }
      throw error;
    }
  }

  if (data.intent === 'set_limit') {
    const locked = await guard('family_mode');
    if (locked) {
      return { replyText: locked, responseBody: { ok: true, to: from, replyText: locked, blockedFeature: 'family_mode' } };
    }
    try {
      const limit = await upsertFamilySpendingLimit({
        actorCustomerId: customerId,
        period: data.period,
        amountCents: data.amountCents,
      });
      const outText = [
        `Fechado ✅ limite familiar ${periodLabel(limit.period)} definido em ${centsToBrl(limit.amountCents)}.`,
        'Vou alertar quando o grupo estiver perto de estourar esse teto.'
      ].join('\n');
      await logConversation(customerId, 'outbound', outText, { intent: 'family-set-limit', period: limit.period });
      return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, limit } };
    } catch (error) {
      if (error instanceof Error && error.message === 'family_owner_required') {
        const outText = 'Só o dono do grupo pode definir limite familiar.';
        await logConversation(customerId, 'outbound', outText, { intent: 'family-set-limit', status: 'owner-required' });
        return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, status: 'family_owner_required' } };
      }
      if (error instanceof Error && error.message === 'family_group_not_found') {
        const outText = 'Você ainda não está em uma família. Mande "criar família" primeiro.';
        await logConversation(customerId, 'outbound', outText, { intent: 'family-set-limit', status: 'no-group' });
        return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, status: 'family_group_not_found' } };
      }
      throw error;
    }
  }

  if (data.intent === 'clear_limit') {
    const locked = await guard('family_mode');
    if (locked) {
      return { replyText: locked, responseBody: { ok: true, to: from, replyText: locked, blockedFeature: 'family_mode' } };
    }
    try {
      const removed = await clearFamilySpendingLimit({
        actorCustomerId: customerId,
        period: data.period,
      });
      const outText = removed.removed
        ? `Removi o limite familiar ${periodLabel(data.period)}.`
        : `Não havia limite familiar ${periodLabel(data.period)} ativo para remover.`;
      await logConversation(customerId, 'outbound', outText, { intent: 'family-clear-limit', removed: removed.removed });
      return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, removed } };
    } catch (error) {
      if (error instanceof Error && error.message === 'family_owner_required') {
        const outText = 'Só o dono do grupo pode remover limites familiares.';
        await logConversation(customerId, 'outbound', outText, { intent: 'family-clear-limit', status: 'owner-required' });
        return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, status: 'family_owner_required' } };
      }
      if (error instanceof Error && error.message === 'family_group_not_found') {
        const outText = 'Você ainda não está em uma família ativa.';
        await logConversation(customerId, 'outbound', outText, { intent: 'family-clear-limit', status: 'no-group' });
        return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, status: 'family_group_not_found' } };
      }
      throw error;
    }
  }

  if (data.intent === 'list_limits') {
    const locked = await guard('family_mode');
    if (locked) {
      return { replyText: locked, responseBody: { ok: true, to: from, replyText: locked, blockedFeature: 'family_mode' } };
    }
    const [limits, statuses] = await Promise.all([
      listFamilySpendingLimits(customerId),
      familySpendingLimitStatuses({
        actorCustomerId: customerId,
        referenceDate: now,
        timezone: config.defaultTimezone,
      }),
    ]);
    if (!limits.groupId) {
      const outText = 'Você ainda não está em um grupo familiar. Mande "criar família".';
      await logConversation(customerId, 'outbound', outText, { intent: 'family-limits', status: 'no-group' });
      return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, limits: [] } };
    }
    const actives = limits.items.filter((item) => item.isActive);
    const outText = actives.length === 0
      ? [
        'Seu grupo ainda não tem limites familiares ativos.',
        limits.role === 'owner'
          ? 'Exemplo: "limite família semanal 1800".'
          : 'Peça ao dono do grupo para definir um limite familiar.'
      ].join('\n')
      : [
        `Limites familiares (${limits.role === 'owner' ? 'dono' : 'membro'}):`,
        ...actives.map((item) => {
          const status = statuses.statuses.find((s) => s.period === item.period);
          const statusLabel = status?.status === 'near'
            ? ` (atenção: faltam ${centsToBrl(status.remainingCents)})`
            : status?.status === 'exceeded'
              ? ` (estourado em ${centsToBrl(Math.abs(status.remainingCents))})`
              : '';
          return `• ${periodEmoji(item.period)} ${periodLabel(item.period)}: ${centsToBrl(item.amountCents)}${statusLabel}`;
        })
      ].join('\n');
    await logConversation(customerId, 'outbound', outText, { intent: 'family-limits', activeCount: actives.length });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, limits, statuses } };
  }

  if (data.intent === 'summary') {
    const locked = await guard('family_mode');
    if (locked) {
      return { replyText: locked, responseBody: { ok: true, to: from, replyText: locked, blockedFeature: 'family_mode' } };
    }
    const summary = await familyMonthlySummary(customerId, now, config.defaultTimezone);
    if (!summary) {
      const outText = [
        'Você ainda não está em um grupo familiar.',
        'Para começar, mande: "criar família".'
      ].join('\n');
      await logConversation(customerId, 'outbound', outText, { intent: 'family-summary', status: 'no-group' });
      return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, summary: null } };
    }
    const categories = summary.byCategory.length > 0
      ? summary.byCategory.map((item) => `• ${decorateCategory(item.category)}: ${centsToBrl(item.amountCents)}`)
      : ['• Sem despesas em categorias neste mês.'];
    const memberRanking = summary.memberExpenses.length > 0
      ? summary.memberExpenses.map((item, index) => `${index + 1}) ${(item.name ?? 'Sem nome')}: ${centsToBrl(item.amountCents)}`)
      : ['Sem despesas por membro no período.'];
    const familyLimitLines = summary.limitStatuses.length > 0
      ? summary.limitStatuses.map((item) => {
        if (item.status === 'near') {
          return `• ${periodEmoji(item.period)} ${periodLabel(item.period)}: faltam ${centsToBrl(item.remainingCents)} para ${centsToBrl(item.limitCents)}.`;
        }
        if (item.status === 'exceeded') {
          return `• ${periodEmoji(item.period)} ${periodLabel(item.period)}: estourado em ${centsToBrl(Math.abs(item.remainingCents))} (limite ${centsToBrl(item.limitCents)}).`;
        }
        return `• ${periodEmoji(item.period)} ${periodLabel(item.period)}: ${centsToBrl(item.spentCents)} de ${centsToBrl(item.limitCents)}.`;
      })
      : ['• Sem limite familiar ativo.'];
    const outText = [
      `👨‍👩‍👧‍👦 Resumo da família ${String(summary.month).padStart(2, '0')}/${summary.year}:`,
      `• Receitas: ${centsToBrl(summary.totalIncomeCents)}`,
      `• Despesas: ${centsToBrl(summary.totalExpenseCents)}`,
      `• Saldo: ${centsToBrl(summary.netCents)}`,
      `• Membros: ${summary.members.map((m) => m.name || m.whatsappNumber).join(', ')}`,
      'Categorias:',
      ...categories,
      'Ranking de gastos do grupo:',
      ...memberRanking,
      'Status dos limites do grupo:',
      ...familyLimitLines
    ].join('\n');
    await logConversation(customerId, 'outbound', outText, { intent: 'family-summary' });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, summary } };
  }

  if (data.intent === 'info') {
    const locked = await guard('family_mode');
    if (locked) {
      return { replyText: locked, responseBody: { ok: true, to: from, replyText: locked, blockedFeature: 'family_mode' } };
    }
    const context = await getFamilyContextForCustomer(customerId);
    const limitInfo = context ? await listFamilySpendingLimits(customerId) : null;
    const outText = !context
      ? 'Você ainda não faz parte de um grupo familiar. Mande "criar família" para começar.'
      : [
        `Seu grupo: ${context.groupName}`,
        `Código de convite: ${context.inviteCode}`,
        `Seu papel: ${context.role === 'owner' ? 'dono(a)' : 'membro'}`,
        `Membros (${context.members.length}): ${context.members.map((m) => m.name || m.whatsappNumber).join(', ')}`,
        `Limites familiares ativos: ${limitInfo?.items.filter((item) => item.isActive).length ?? 0}`,
        context.role === 'owner'
          ? 'Como dono(a), você pode definir limites: "limite família semanal 2000".'
          : 'Somente o dono pode alterar limites do grupo.'
      ].join('\n');
    await logConversation(customerId, 'outbound', outText, { intent: 'family-info', hasGroup: Boolean(context) });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, family: context } };
  }

  // leave
  const left = await leaveFamilyGroup(customerId);
  const outText = left.left
    ? 'Você saiu do grupo familiar. Se quiser voltar, use um novo código de convite.'
    : 'Você não estava em nenhum grupo familiar ativo.';
  await logConversation(customerId, 'outbound', outText, { intent: 'family-leave', left: left.left });
  return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText, left } };
}
