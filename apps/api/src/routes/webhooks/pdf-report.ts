import { randomUUID } from 'crypto';
import { generateMonthlyPdfReport } from '../../services/pdf-report.js';
import { storeReportToken } from '../reports.js';
import { logConversation } from '../../services/ledger.js';

// ─── Month name → number ──────────────────────────────────────────────────────

const MONTH_MAP: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4,
  maio: 5, junho: 6, julho: 7, agosto: 8,
  setembro: 9, outubro: 10, novembro: 11, dezembro: 12
};

function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function parseMonthYear(text: string): { month: number; year: number } | null {
  const norm = normalizeText(text);

  // "mês passado"
  if (/\b(mes passado|mes anterior)\b/.test(norm)) {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return { month: d.getMonth() + 1, year: d.getFullYear() };
  }

  // "este mês" / "esse mês" / "mês atual"
  if (/\b(este mes|esse mes|mes atual|mes corrente)\b/.test(norm)) {
    const d = new Date();
    return { month: d.getMonth() + 1, year: d.getFullYear() };
  }

  // "março de 2025" or "março 2025"
  for (const [name, num] of Object.entries(MONTH_MAP)) {
    if (norm.includes(name)) {
      const yearMatch = norm.match(/\b(20\d{2})\b/);
      const year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();
      return { month: num, year };
    }
  }

  // "03/2025" or "03-2025"
  const mmyyyy = norm.match(/\b(\d{1,2})[\/\-](\d{4})\b/);
  if (mmyyyy) {
    const month = Number(mmyyyy[1]);
    const year = Number(mmyyyy[2]);
    if (month >= 1 && month <= 12) return { month, year };
  }

  return null;
}

export function isPdfReportRequest(text: string): boolean {
  const norm = normalizeText(text);
  return (
    /\b(exportar?|gerar?|baixar?|obter?|quero|me manda|me envia)\b/.test(norm) &&
    /\b(relatorio|extrato|pdf|resumo mensal)\b/.test(norm)
  ) || /\brelatorio (mensal|financeiro|do mes)\b/.test(norm);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

type HandlerResult = {
  replyText: string;
  responseBody: Record<string, unknown>;
};

export async function handlePdfReport(params: {
  customerId: string;
  customerName?: string | null;
  from: string;
  text: string;
  now: Date;
  apiPublicUrl: string;
}): Promise<HandlerResult> {
  const { customerId, customerName, from, text, now, apiPublicUrl } = params;

  const parsed = parseMonthYear(text) ?? {
    month: now.getMonth() + 1 === 1 ? 12 : now.getMonth(),
    year: now.getMonth() + 1 === 1 ? now.getFullYear() - 1 : now.getFullYear()
  };

  const MONTH_NAMES = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
  ];
  const monthName = MONTH_NAMES[parsed.month - 1];
  const label = `${monthName}/${parsed.year}`;

  let buffer: Buffer;
  try {
    buffer = await generateMonthlyPdfReport({
      customerId,
      customerName,
      month: parsed.month,
      year: parsed.year,
      generatedAt: now
    });
  } catch {
    const errText = `Ops, tive um problema ao gerar o relatório de ${label}. Tente novamente em instantes.`;
    await logConversation(customerId, 'outbound', errText, { intent: 'export-pdf', error: true });
    return { replyText: errText, responseBody: { ok: false, to: from, replyText: errText } };
  }

  const token = randomUUID();
  const fileName = `relatorio-iara-${parsed.year}-${String(parsed.month).padStart(2, '0')}.pdf`;
  storeReportToken(token, buffer, fileName);

  const url = `${apiPublicUrl}/reports/${token}`;
  const outText =
    `📊 *Relatório Financeiro — ${label}*\n\n` +
    `Seu relatório está pronto! Clique para abrir o PDF:\n${url}\n\n` +
    `_O link expira em 1 hora._`;

  await logConversation(customerId, 'outbound', outText, { intent: 'export-pdf', month: parsed.month, year: parsed.year });
  return { replyText: outText, responseBody: { ok: true, to: from, replyText: outText } };
}
