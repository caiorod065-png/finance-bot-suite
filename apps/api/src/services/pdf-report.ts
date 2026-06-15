import PDFDocument from 'pdfkit';
import { monthlySummary, monthlyVisualReportData } from './ledger.js';

// ─── Color palette ────────────────────────────────────────────────────────────

const CLR_BG      = '#0F172A'; // azul-escuro header
const CLR_ACCENT  = '#22C55E'; // verde receita
const CLR_DANGER  = '#EF4444'; // vermelho despesa
const CLR_NEUTRAL = '#64748B'; // cinza texto secundário
const CLR_WHITE   = '#FFFFFF';
const CLR_CARD    = '#F8FAFC'; // fundo dos cards
const CLR_BORDER  = '#E2E8F0';
const CLR_TEXT    = '#1E293B';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function brl(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const MONTH_NAMES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

function monthLabel(month: number, year: number): string {
  return `${MONTH_NAMES[month - 1]} de ${year}`;
}

const CATEGORY_EMOJI: Record<string, string> = {
  alimentacao: '🍽', transporte: '🚗', lazer: '🎮', saude: '⚕',
  moradia: '🏠', educacao: '📚', vestuario: '👔', eletronicos: '💻',
  servicos: '🔧', viagem: '✈', outros: '📦'
};

function catEmoji(cat: string): string {
  const key = cat.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return CATEGORY_EMOJI[key] ?? '•';
}

// ─── PDF layout helpers ───────────────────────────────────────────────────────

function drawHeader(doc: PDFKit.PDFDocument, customerName: string | null | undefined, month: number, year: number): void {
  doc.rect(0, 0, doc.page.width, 90).fill(CLR_BG);
  doc.fillColor(CLR_ACCENT).fontSize(22).font('Helvetica-Bold')
    .text('iara', 40, 24);
  doc.fillColor(CLR_NEUTRAL).fontSize(10).font('Helvetica')
    .text('assistente financeiro inteligente', 40, 52);
  doc.fillColor(CLR_WHITE).fontSize(14).font('Helvetica-Bold')
    .text(`Relatório Mensal · ${monthLabel(month, year)}`, 200, 28, { align: 'right', width: 355 });
  if (customerName) {
    doc.fillColor(CLR_NEUTRAL).fontSize(10).font('Helvetica')
      .text(customerName, 200, 52, { align: 'right', width: 355 });
  }
}

function drawSummaryCards(doc: PDFKit.PDFDocument, totalIncomeCents: number, totalExpenseCents: number, y: number): void {
  const net = totalIncomeCents - totalExpenseCents;
  const cardW = 155;
  const cards = [
    { label: 'Receitas', value: brl(totalIncomeCents), color: CLR_ACCENT },
    { label: 'Despesas', value: brl(totalExpenseCents), color: CLR_DANGER },
    { label: 'Saldo', value: brl(net), color: net >= 0 ? CLR_ACCENT : CLR_DANGER }
  ];

  cards.forEach((card, i) => {
    const x = 40 + i * (cardW + 10);
    doc.roundedRect(x, y, cardW, 62, 6).fill(CLR_CARD);
    doc.roundedRect(x, y, cardW, 4, 2).fill(card.color);
    doc.fillColor(CLR_NEUTRAL).fontSize(9).font('Helvetica')
      .text(card.label, x + 10, y + 14);
    doc.fillColor(CLR_TEXT).fontSize(16).font('Helvetica-Bold')
      .text(card.value, x + 10, y + 30, { width: cardW - 20 });
  });
}

function drawCategorySection(
  doc: PDFKit.PDFDocument,
  categories: Array<{ category: string; amountCents: number }>,
  totalExpenseCents: number,
  y: number
): void {
  doc.fillColor(CLR_TEXT).fontSize(13).font('Helvetica-Bold')
    .text('Despesas por Categoria', 40, y);

  const top = categories.slice(0, 10);
  const maxAmt = top[0]?.amountCents ?? 1;
  let rowY = y + 24;
  const BAR_FULL = 245;

  for (const cat of top) {
    const pct = cat.amountCents / maxAmt;
    const barW = Math.max(4, Math.round(BAR_FULL * pct));
    const sharePct = totalExpenseCents > 0 ? (cat.amountCents / totalExpenseCents * 100).toFixed(1) : '0.0';
    const emoji = catEmoji(cat.category);

    doc.fillColor(CLR_TEXT).fontSize(10).font('Helvetica')
      .text(`${emoji}  ${cat.category}`, 40, rowY, { width: 160 });
    doc.roundedRect(205, rowY + 2, BAR_FULL, 10, 3).fill(CLR_BORDER);
    doc.roundedRect(205, rowY + 2, barW, 10, 3).fill(CLR_DANGER);
    doc.fillColor(CLR_NEUTRAL).fontSize(9).font('Helvetica')
      .text(`${brl(cat.amountCents)}  (${sharePct}%)`, 455, rowY, { width: 100, align: 'right' });

    rowY += 20;
    if (rowY > doc.page.height - 100) {
      doc.addPage();
      rowY = 40;
    }
  }
}

function drawHighlights(doc: PDFKit.PDFDocument, highlights: string[], y: number): void {
  doc.fillColor(CLR_TEXT).fontSize(13).font('Helvetica-Bold')
    .text('Destaques do Mês', 40, y);

  let cur = y + 22;
  for (const h of highlights) {
    doc.roundedRect(40, cur, doc.page.width - 80, 28, 4).fill(CLR_CARD);
    doc.rect(40, cur, 3, 28).fill(CLR_ACCENT);
    doc.fillColor(CLR_TEXT).fontSize(10).font('Helvetica')
      .text(h, 55, cur + 9, { width: doc.page.width - 100 });
    cur += 34;
  }
}

function drawFooter(doc: PDFKit.PDFDocument, generatedAt: Date): void {
  const footerY = doc.page.height - 40;
  doc.rect(0, footerY - 8, doc.page.width, 1).fill(CLR_BORDER);
  const dateStr = generatedAt.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  doc.fillColor(CLR_NEUTRAL).fontSize(8).font('Helvetica')
    .text(`Gerado pela Iara em ${dateStr}. Este relatório é pessoal e intransferível.`, 40, footerY, {
      align: 'center',
      width: doc.page.width - 80
    });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function generateMonthlyPdfReport(params: {
  customerId: string;
  customerName?: string | null;
  month: number;
  year: number;
  generatedAt?: Date;
}): Promise<Buffer> {
  const { customerId, customerName, month, year } = params;
  const generatedAt = params.generatedAt ?? new Date();

  const [summary, visual] = await Promise.all([
    monthlySummary(customerId, month, year),
    monthlyVisualReportData({ customerId, month, year })
  ]);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, compress: true });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    drawHeader(doc, customerName, month, year);

    // Summary cards
    drawSummaryCards(doc, summary.totalIncomeCents, summary.totalExpenseCents, 110);

    // Category breakdown
    if (summary.byCategory.length > 0) {
      drawCategorySection(doc, summary.byCategory, summary.totalExpenseCents, 200);
    } else {
      doc.fillColor(CLR_NEUTRAL).fontSize(11).font('Helvetica')
        .text('Nenhuma despesa registrada neste mês.', 40, 210);
    }

    // Highlights
    const highlightY = 200 + 24 + Math.min(summary.byCategory.length, 10) * 20 + 30;
    if (visual.highlights.length > 0 && highlightY < doc.page.height - 180) {
      drawHighlights(doc, visual.highlights, highlightY);
    }

    // Footer
    drawFooter(doc, generatedAt);

    doc.end();
  });
}
