import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash, timingSafeEqual } from 'crypto';
import { config } from '../config.js';
import { getAdminSessionFromRequest } from '../services/admin-auth.js';
import {
  createConnectToken,
  deleteItem,
  getAccounts,
  getItem,
  getTransactions,
  isPluggyConfigured,
  type PluggyTransaction,
} from '../services/pluggy.js';
import {
  deleteBankConnection,
  findCustomerByWhatsappLoose,
  getBankConnectionByCustomer,
  getBankConnectionByItemId,
  saveBankTransactions,
  upsertBankConnection,
} from '../services/ledger.js';
import { inferCategory } from '../services/parser.js';
import { sendWhatsAppText } from '../services/whatsapp-outbound.js';
import { pool } from '../db/pool.js';

const PLUGGY_CONNECT_URL = 'https://connect.pluggy.ai';

// Armazena tokens temporários em memória: { id -> { connectToken, expiresAt } }
const connectRedirects = new Map<string, { connectToken: string; expiresAt: number }>();

function safeCompare(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function requireAdminAuth(headers: Record<string, unknown>): boolean {
  return Boolean(getAdminSessionFromRequest(headers));
}

function amountToCents(amount: number): number {
  return Math.round(Math.abs(amount) * 100);
}

function pluggyTypeToKind(type: string): 'expense' | 'income' {
  return type === 'CREDIT' ? 'income' : 'expense';
}

async function processPluggyTransactions(
  customerId: string,
  txs: PluggyTransaction[]
): Promise<number> {
  const mapped = txs.map((tx) => ({
    pluggyTxId: tx.id,
    pluggyAccountId: tx.accountId,
    amountCents: amountToCents(tx.amount),
    description: tx.description,
    category: tx.category ? tx.category.toLowerCase() : inferCategory(tx.description),
    kind: pluggyTypeToKind(tx.type) as 'expense' | 'income',
    occurredAt: tx.date,
    rawPluggyType: tx.type,
  }));
  return saveBankTransactions({ customerId, transactions: mapped });
}

async function getCustomerPhone(customerId: string): Promise<string | null> {
  const r = await pool.query<{ whatsapp_number: string }>(
    'SELECT whatsapp_number FROM customers WHERE id = $1',
    [customerId]
  );
  return r.rows[0]?.whatsapp_number ?? null;
}

export async function openFinanceRoutes(app: FastifyInstance): Promise<void> {

  // GET /openfinance/r/:id — redirect curto para o Pluggy Connect
  app.get<{ Params: { id: string } }>(
    '/openfinance/r/:id',
    async (request, reply) => {
      const entry = connectRedirects.get(request.params.id);
      if (!entry || entry.expiresAt < Date.now()) {
        connectRedirects.delete(request.params.id);
        return reply.status(410).send('Link expirado. Solicite um novo link no WhatsApp.');
      }
      return reply.redirect(`${PLUGGY_CONNECT_URL}?connect_token=${entry.connectToken}`);
    }
  );

  // POST /openfinance/connect — gera link curto e envia no WhatsApp
  app.post<{ Body: { phone: string; webhookUrl?: string } }>(
    '/openfinance/connect',
    async (request, reply) => {
      if (!requireAdminAuth(request.headers as Record<string, unknown>)) {
        return reply.status(401).send({ error: 'unauthorized' });
      }
      if (!isPluggyConfigured()) {
        return reply.status(503).send({ error: 'Open Finance não configurado no servidor.' });
      }

      const { phone } = request.body ?? {};
      if (!phone) return reply.status(400).send({ error: 'phone obrigatório' });

      const customer = await findCustomerByWhatsappLoose(phone);
      if (!customer) return reply.status(404).send({ error: 'Cliente não encontrado.' });

      const existing = await getBankConnectionByCustomer(customer.id);
      if (existing && existing.status === 'connected') {
        return reply.status(409).send({
          error: `Banco já conectado (${existing.institutionName ?? existing.status}). Desconecte primeiro.`,
        });
      }

      const webhookUrl =
        request.body.webhookUrl ??
        `${process.env.API_PUBLIC_URL ?? ''}/openfinance/webhook/pluggy`;

      const token = await createConnectToken({ webhookUrl });

      // Armazena token com ID curto para evitar truncamento de URL no WhatsApp
      const redirectId = randomUUID().replace(/-/g, '').slice(0, 12);
      connectRedirects.set(redirectId, { connectToken: token, expiresAt: Date.now() + 30 * 60 * 1000 });

      const baseUrl = process.env.API_PUBLIC_URL ?? '';
      const link = `${baseUrl}/openfinance/r/${redirectId}`;

      await sendWhatsAppText({
        to: phone,
        message: `🏦 *Conectar seu banco à Iara*\n\nClique no link abaixo, escolha seu banco e autorize o acesso. Leva menos de 1 minuto e é seguro:\n\n${link}\n\n_O link expira em 30 minutos._`,
      });

      return { ok: true, message: 'Link enviado no WhatsApp.' };
    }
  );

  // GET /openfinance/status/:phone
  app.get<{ Params: { phone: string } }>(
    '/openfinance/status/:phone',
    async (request, reply) => {
      if (!requireAdminAuth(request.headers as Record<string, unknown>)) {
        return reply.status(401).send({ error: 'unauthorized' });
      }
      const customer = await findCustomerByWhatsappLoose(request.params.phone);
      if (!customer) return reply.status(404).send({ error: 'Cliente não encontrado.' });

      const conn = await getBankConnectionByCustomer(customer.id);
      if (!conn) return { connected: false };

      return {
        connected: conn.status === 'connected',
        status: conn.status,
        institution: conn.institutionName,
      };
    }
  );

  // DELETE /openfinance/disconnect
  app.delete<{ Body: { phone: string } }>(
    '/openfinance/disconnect',
    async (request, reply) => {
      if (!requireAdminAuth(request.headers as Record<string, unknown>)) {
        return reply.status(401).send({ error: 'unauthorized' });
      }
      const { phone } = request.body ?? {};
      if (!phone) return reply.status(400).send({ error: 'phone obrigatório' });

      const customer = await findCustomerByWhatsappLoose(phone);
      if (!customer) return reply.status(404).send({ error: 'Cliente não encontrado.' });

      const conn = await getBankConnectionByCustomer(customer.id);
      if (conn) {
        try {
          await deleteItem(conn.pluggyItemId);
        } catch {
          // ignora erro do Pluggy — remove localmente mesmo assim
        }
      }

      const removed = await deleteBankConnection(customer.id);
      if (!removed) return reply.status(404).send({ error: 'Nenhuma conexão encontrada.' });

      return { ok: true, message: 'Banco desconectado.' };
    }
  );

  // POST /openfinance/webhook/pluggy — recebe eventos do Pluggy
  app.post<{ Body: Record<string, unknown> }>(
    '/openfinance/webhook/pluggy',
    async (request, reply) => {
      if (config.pluggyWebhookSecret) {
        const signature = request.headers['x-pluggy-signature'] as string | undefined;
        if (!signature || !safeCompare(signature, config.pluggyWebhookSecret)) {
          return reply.status(401).send({ error: 'unauthorized' });
        }
      }

      const body = request.body as {
        event: string;
        itemId?: string;
        data?: Record<string, unknown>;
      };

      const event = body.event ?? '';
      const itemId = body.itemId ?? (body.data?.itemId as string | undefined);

      request.log.info({ event, itemId }, 'pluggy_webhook');
      if (!itemId) return { ok: true, ignored: true };

      // ── item criado ou atualizado ─────────────────────────────────────────
      if (event === 'item/created' || event === 'item/updated') {
        try {
          const item = await getItem(itemId);
          const conn = await getBankConnectionByItemId(itemId);

          if (!conn) {
            request.log.warn({ itemId }, 'pluggy_webhook_item_not_found');
            return { ok: true, ignored: true, reason: 'connection_not_found' };
          }

          const newStatus = item.status === 'UPDATED' ? 'connected' : 'updating';
          await upsertBankConnection({
            customerId: conn.customerId,
            pluggyItemId: itemId,
            institutionName: item.connector?.name,
            status: newStatus,
          });

          if (newStatus === 'connected') {
            const accounts = await getAccounts(itemId);
            let totalInserted = 0;

            for (const account of accounts) {
              const page = await getTransactions(account.id);
              totalInserted += await processPluggyTransactions(conn.customerId, page.results);
              for (let p = 2; p <= page.totalPages; p++) {
                const next = await getTransactions(account.id, undefined, undefined, p);
                totalInserted += await processPluggyTransactions(conn.customerId, next.results);
              }
            }

            const phone = await getCustomerPhone(conn.customerId);
            if (phone) {
              const institution = item.connector?.name ?? 'seu banco';
              const msg = totalInserted > 0
                ? `Importei ${totalInserted} transações recentes automaticamente.`
                : 'Suas próximas transações serão importadas automaticamente.';
              await sendWhatsAppText({
                to: phone,
                message: `✅ *${institution} conectado com sucesso!*\n\n${msg}\n\nAgora posso analisar seus gastos reais sem você precisar digitar nada 🎉`,
              });
            }
          }
        } catch (err) {
          request.log.error(err, 'pluggy_webhook_item_error');
        }
        return { ok: true };
      }

      // ── item com erro ─────────────────────────────────────────────────────
      if (event === 'item/error') {
        const conn = await getBankConnectionByItemId(itemId);
        if (conn) {
          await upsertBankConnection({
            customerId: conn.customerId,
            pluggyItemId: itemId,
            status: 'error',
          });
        }
        return { ok: true };
      }

      // ── novas transações disponíveis ──────────────────────────────────────
      if (event === 'transactions/updated') {
        const conn = await getBankConnectionByItemId(itemId);
        if (!conn) return { ok: true, ignored: true };

        try {
          const accounts = await getAccounts(itemId);
          let totalInserted = 0;

          for (const account of accounts) {
            const page = await getTransactions(account.id);
            totalInserted += await processPluggyTransactions(conn.customerId, page.results);
          }

          if (totalInserted > 0) {
            const phone = await getCustomerPhone(conn.customerId);
            if (phone) {
              const label = totalInserted > 1 ? 's transações importadas' : ' transação importada';
              await sendWhatsAppText({
                to: phone,
                message: `📊 ${totalInserted} nova${label} do seu banco automaticamente. Me pergunte sobre seus gastos quando quiser!`,
              });
            }
          }
        } catch (err) {
          request.log.error(err, 'pluggy_webhook_transactions_error');
        }

        return { ok: true };
      }

      return { ok: true, ignored: true, event };
    }
  );
}
