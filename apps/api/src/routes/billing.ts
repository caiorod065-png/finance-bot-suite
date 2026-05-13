import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { createFamilyGroup, getCustomerSubscription, logConversation, recordSubscriptionPayment } from '../services/ledger.js';
import { getPlanDefinition } from '../services/plans.js';
import { sendPaymentThanksMessage, sendWelcomeActivationMessage } from '../services/whatsapp-outbound.js';

const asaasWebhookSchema = z.object({
  event: z.string(),
  payment: z
    .object({
      id: z.string().optional(),
      value: z.number().optional(),
      externalReference: z.string().optional(),
      status: z.string().optional(),
      dueDate: z.string().optional()
    })
    .passthrough()
    .optional()
}).passthrough();

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseReference(ref?: string): { customerId: string; paymentType: 'setup' | 'monthly' } | null {
  if (!ref) return null;
  if (ref.startsWith('setup:')) {
    const customerId = ref.split(':')[1] ?? '';
    return isUuid(customerId) ? { customerId, paymentType: 'setup' } : null;
  }
  if (ref.startsWith('monthly:')) {
    const customerId = ref.split(':')[1] ?? '';
    return isUuid(customerId) ? { customerId, paymentType: 'monthly' } : null;
  }

  // fallback: UUID direto representa pagamento mensal
  return isUuid(ref) ? { customerId: ref, paymentType: 'monthly' } : null;
}

function isPaidEvent(event: string): boolean {
  return event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED';
}

function mapAsaasEventToLocalStatus(event: string): string {
  if (event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED') return 'paid';
  if (event === 'PAYMENT_OVERDUE') return 'overdue';
  if (event === 'PAYMENT_DELETED') return 'canceled';
  if (event === 'PAYMENT_REFUNDED') return 'refunded';
  return 'pending';
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/webhooks/billing/asaas', async (request, reply) => {
    const incomingToken = typeof request.headers['x-webhook-token'] === 'string'
      ? request.headers['x-webhook-token']
      : undefined;
    const queryToken = (request.query as { token?: string } | undefined)?.token;
    const providedToken = incomingToken ?? queryToken;

    if (config.asaasWebhookToken && providedToken !== config.asaasWebhookToken) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const body = asaasWebhookSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_payload', details: body.error.flatten() });
    }

    const parsedRef = parseReference(body.data.payment?.externalReference);
    if (!parsedRef) {
      return reply.status(400).send({ error: 'missing_external_reference' });
    }

    const eventIsPaid = isPaidEvent(body.data.event);

    if (body.data.payment?.id) {
      const mappedStatus = eventIsPaid ? 'pending' : mapAsaasEventToLocalStatus(body.data.event);
      await pool.query(
        `UPDATE payments
         SET status = $3,
             metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
         WHERE gateway = 'asaas'
           AND external_reference = $1
           AND customer_id = $2`,
        [
          body.data.payment.id,
          parsedRef.customerId,
          mappedStatus,
          {
            provider: 'asaas',
            asaasEvent: body.data.event,
            asaasStatus: body.data.payment?.status,
            asaasDueDate: body.data.payment?.dueDate
          }
        ]
      );
    }

    if (!eventIsPaid) {
      return { ok: true, ignored: true, reason: 'unsupported_event', event: body.data.event };
    }

    if (body.data.payment?.id) {
      const duplicate = await pool.query<{ id: string }>(
        `SELECT id
         FROM payments
         WHERE gateway = 'asaas'
           AND external_reference = $1
           AND status = 'paid'
         LIMIT 1`,
        [body.data.payment.id]
      );

      if (duplicate.rows[0]) {
        return { ok: true, applied: false, duplicate: true };
      }
    }

    const amountCents = body.data.payment?.value ? Math.round(body.data.payment.value * 100) : undefined;

    // Verificar se é primeira ativação ANTES de registrar o pagamento
    const prePayment = await pool.query<{ has_paid_setup: boolean }>(
      `SELECT has_paid_setup FROM subscriptions WHERE customer_id = $1 LIMIT 1`,
      [parsedRef.customerId]
    );
    const isFirstActivation = !prePayment.rows[0]?.has_paid_setup;

    const result = await recordSubscriptionPayment({
      customerId: parsedRef.customerId,
      paymentType: parsedRef.paymentType,
      amountCents,
      gateway: 'asaas',
      externalReference: body.data.payment?.id,
      metadata: {
        provider: 'asaas',
        event: body.data.event,
        externalReference: body.data.payment?.externalReference
      }
    });
    const subscription = await getCustomerSubscription(parsedRef.customerId);

    const customer = await pool.query<{ whatsapp_number: string; name: string | null }>(
      `SELECT whatsapp_number, name
       FROM customers
       WHERE id = $1
       LIMIT 1`,
      [parsedRef.customerId]
    );

    const phone = customer.rows[0]?.whatsapp_number;
    const customerName = customer.rows[0]?.name ?? null;
    const plan = getPlanDefinition(subscription.planCode);

    // Auto-create family group + invite codes na PRIMEIRA ativação do plano família
    // Funciona tanto para pagamento 'setup' quanto 'monthly' (quando não há taxa de ativação)
    let familyInviteCodes: string[] | undefined;
    if (isFirstActivation && plan.code === 'family') {
      try {
        const fallbackName = customerName ? `Família ${customerName}` : 'Minha Família';
        const group = await createFamilyGroup({
          ownerCustomerId: parsedRef.customerId,
          name: fallbackName
        });
        familyInviteCodes = group.inviteCodes;
      } catch {
        // Family group may already exist — non-blocking
      }
    }

    const featureLabels: Record<string, string> = {
      goals: 'metas',
      reminders: 'lembretes',
      insights: 'insights',
      recurring: 'detecção de recorrentes',
      cashflow: 'previsão de saldo',
      investment_simulator: 'simulador de investimento',
      gamification: 'gamificação',
      health_score: 'score financeiro',
      family_mode: 'modo família',
      visual_monthly_report: 'relatório visual mensal',
      open_banking_import: 'importação Open Banking'
    };
    const planFeatures = plan.features.map((f) => featureLabels[f] ?? f);

    let thanksDelivery: { sent: boolean; provider?: 'meta' | 'twilio' | 'twilio-template' } | null = null;
    if (phone) {
      const sent = isFirstActivation
        ? await sendWelcomeActivationMessage({
            to: phone,
            customerName,
            planCode: plan.code,
            familyInviteCodes
          })
        : await sendPaymentThanksMessage({
            to: phone,
            customerName,
            paymentType: parsedRef.paymentType,
            planName: subscription.planName
          });
      thanksDelivery = sent;

      await logConversation(
        parsedRef.customerId,
        'outbound',
        sent.sent
          ? `Mensagem de ${isFirstActivation ? 'boas-vindas' : 'agradecimento'} enviada (${sent.provider}).`
          : 'Pagamento confirmado, mas não consegui enviar mensagem automática no WhatsApp.',
        { provider: sent.provider ?? null, source: isFirstActivation ? 'welcome-activation' : 'payment-thanks' }
      );
    }

    await logConversation(
      parsedRef.customerId,
      'outbound',
      `Pagamento confirmado (${parsedRef.paymentType}). Próximo vencimento: ${result.nextDueDate ?? 'não definido'}.`,
      { provider: 'asaas', event: body.data.event }
    );

    return { ok: true, applied: true, result, thanksDelivery };
  });
}
