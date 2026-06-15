import {
  logConversation,
  getBankConnectionByCustomer,
  deleteBankConnection,
} from '../../services/ledger.js';

// ─── Text detection ───────────────────────────────────────────────────────────

function normalizeHumanText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function isConnectBankRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return (
    /\b(conectar?|ligar|vincular|integrar)\b/.test(normalized) &&
    /\b(banco|conta|open.?finance|pluggy)\b/.test(normalized)
  ) || /\b(conectar? meu banco|linkar? banco|abrir? open.?finance)\b/.test(normalized);
}

function isDisconnectBankRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return (
    /\b(desconectar?|desvincular|remover?|cancelar?)\b/.test(normalized) &&
    /\b(banco|conta|open.?finance|pluggy)\b/.test(normalized)
  );
}

function isAskBankStatusRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(banco conectado|banco esta conectado|banco está conectado|status do banco|meu banco esta|meu banco está)\b/.test(normalized);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

type HandlerResult = {
  replyText: string;
  responseBody: Record<string, unknown>;
};

export async function handleOpenFinanceIntents(params: {
  customerId: string;
  from: string;
  text: string;
}): Promise<HandlerResult | null> {
  const { customerId, from, text } = params;

  if (isConnectBankRequest(text)) {
    const { isPluggyConfigured, createConnectToken } = await import('../../services/pluggy.js');
    if (!isPluggyConfigured()) {
      const outText = 'Open Finance ainda não está disponível. Em breve você poderá conectar seu banco aqui! 🏦';
      await logConversation(customerId, 'outbound', outText, { intent: 'connect-bank', reason: 'not-configured' });
      return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText } };
    }
    const existing = await getBankConnectionByCustomer(customerId);
    if (existing && existing.status === 'connected') {
      const outText = `Você já tem o *${existing.institutionName ?? 'seu banco'}* conectado! 🏦\n\nSe quiser trocar, me diga "desconectar banco" primeiro.`;
      await logConversation(customerId, 'outbound', outText, { intent: 'connect-bank', reason: 'already-connected' });
      return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText } };
    }
    const webhookUrl = `${process.env.API_PUBLIC_URL ?? ''}/openfinance/webhook/pluggy`;
    const token = await createConnectToken({ webhookUrl });
    const link = `https://connect.pluggy.ai?token=${token}`;
    const outText = `🏦 *Conectar seu banco à Iara*\n\nClique no link abaixo, escolha seu banco e autorize o acesso. Leva menos de 1 minuto:\n\n${link}\n\n_O link expira em 30 minutos._`;
    await logConversation(customerId, 'outbound', outText, { intent: 'connect-bank' });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText } };
  }

  if (isDisconnectBankRequest(text)) {
    const { deleteItem } = await import('../../services/pluggy.js');
    const conn = await getBankConnectionByCustomer(customerId);
    if (!conn) {
      const outText = 'Não encontrei nenhum banco conectado na sua conta. 🤔';
      await logConversation(customerId, 'outbound', outText, { intent: 'disconnect-bank', reason: 'not-found' });
      return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText } };
    }
    try { await deleteItem(conn.pluggyItemId); } catch { /* ignora erro Pluggy */ }
    await deleteBankConnection(customerId);
    const outText = `Banco desconectado com sucesso! ✅\n\nSe quiser conectar novamente, é só me dizer "conectar banco".`;
    await logConversation(customerId, 'outbound', outText, { intent: 'disconnect-bank' });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText } };
  }

  if (isAskBankStatusRequest(text)) {
    const conn = await getBankConnectionByCustomer(customerId);
    let outText: string;
    if (!conn) {
      outText = 'Você ainda não tem um banco conectado. 🏦\n\nQuer conectar agora? É só me dizer "conectar banco"!';
    } else if (conn.status === 'connected') {
      outText = `Seu *${conn.institutionName ?? 'banco'}* está conectado e funcionando! ✅\n\nSuas transações são importadas automaticamente.`;
    } else {
      outText = `O status do seu banco é: *${conn.status}*. Se houver problema, me diga "desconectar banco" e tente conectar novamente.`;
    }
    await logConversation(customerId, 'outbound', outText, { intent: 'ask-bank-status' });
    return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText } };
  }

  return null;
}
