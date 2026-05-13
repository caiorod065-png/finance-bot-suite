import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  activateCustomerTrial,
  adminMetrics,
  changeReferralCount,
  createBillReminder,
  createFinancialGoal,
  customerTransactions,
  detectRecurringExpenses,
  deleteCustomer,
  financialGoalsProgress,
  forecastCashflowMonth,
  getCustomerSubscription,
  listBillReminders,
  listPayments,
  listPlans,
  listActiveFinancialGoals,
  listCustomers,
  migrateSubscriptionsToCurrentPlanPricing,
  recordSubscriptionPayment,
  refreshSubscriptionStatuses,
  setCustomerPlan,
  setCustomerSubscriptionStatus
} from '../services/ledger.js';
import { config } from '../config.js';
import {
  authenticateAdmin,
  ensureAdminBootstrapUser,
  getAdminSessionFromRequest,
  issueAdminToken,
  setAdminPassword
} from '../services/admin-auth.js';
import { createAsaasCharge, runAsaasRenewalSweep } from '../services/billing-asaas.js';
import { sendWelcomeActivationMessage } from '../services/whatsapp-outbound.js';
import { pool } from '../db/pool.js';
import { costOverview, listCostSnapshots, saveDailyCostSnapshot } from '../services/costs.js';
import { runProactiveAlerts } from '../services/proactive-alerts.js';
import { getProactiveSchedulerState } from '../services/proactive-scheduler.js';
import {
  activateFamilyPlanSquad,
  appendAgentMeetingInstruction,
  createFamilyPlanSquadRoom,
  createAgentMeetingRoom,
  getFamilyPlanSquadStatus,
  getAgentCoordinatorConfig,
  getAgentMeetingRoom,
  listAgentMeetingRooms,
  updateAgentCoordinatorConfig
} from '../services/agent-room.js';

function auth(headers: Record<string, unknown>): boolean {
  return Boolean(getAdminSessionFromRequest(headers));
}

const referralBodySchema = z.object({
  delta: z.number().int().min(-100).max(100)
});

const paymentBodySchema = z.object({
  paymentType: z.enum(['setup', 'monthly']),
  amountCents: z.number().int().positive().optional(),
  gateway: z.string().min(2).optional(),
  externalReference: z.string().min(1).optional()
});

const statusBodySchema = z.object({
  status: z.enum(['active', 'past_due', 'canceled'])
});

const planBodySchema = z.object({
  planCode: z.enum(['free', 'essential', 'premium', 'family', 'elite'])
});

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(200)
});

const bootstrapBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200)
});

const createChargeBodySchema = z.object({
  paymentType: z.enum(['setup', 'monthly']),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  amountCents: z.number().int().positive().optional()
});

const renewalsBodySchema = z.object({
  daysAhead: z.number().int().min(0).max(60).optional()
});

const proactiveBodySchema = z.object({
  dryRun: z.boolean().optional(),
  customerLimit: z.number().int().min(1).max(5000).optional()
});

const migratePricingBodySchema = z.object({
  skipCanceled: z.boolean().optional(),
  includeFree: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  customerLimit: z.number().int().min(1).max(10000).optional(),
  planCodes: z.array(z.enum(['free', 'essential', 'premium', 'family', 'elite'])).optional()
});

const trialBodySchema = z.object({
  days: z.number().int().min(1).max(14).optional()
});

const goalBodySchema = z.object({
  title: z.string().min(2).max(120),
  targetCents: z.number().int().positive(),
  deadlineDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

const reminderBodySchema = z.object({
  title: z.string().min(2).max(120),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  remindDaysBefore: z.number().int().min(0).max(30).optional(),
  remindMinutesBefore: z.number().int().min(0).max(240).optional(),
  recurrence: z.enum(['none', 'monthly']).optional(),
  amountCents: z.number().int().positive().optional()
});

const agentDefinitionBodySchema = z.object({
  name: z.string().min(2).max(80),
  role: z.string().min(2).max(180),
  goal: z.string().min(2).max(280),
  active: z.boolean().optional()
});

const updateAgentConfigBodySchema = z.object({
  coordinatorAgent: z.string().min(2).max(80).optional(),
  agents: z.array(agentDefinitionBodySchema).min(1).max(20).optional()
});

const createAgentRoomBodySchema = z.object({
  title: z.string().min(2).max(140).optional(),
  instruction: z.string().min(4).max(2400),
  coordinatorAgent: z.string().min(2).max(80).optional()
});

const appendAgentInstructionBodySchema = z.object({
  instruction: z.string().min(4).max(2400),
  coordinatorAgent: z.string().min(2).max(80).optional()
});

const activateFamilySquadBodySchema = z.object({
  openKickoffRoom: z.boolean().optional(),
  kickoffInstruction: z.string().min(4).max(2400).optional()
});

const createFamilySquadRoomBodySchema = z.object({
  title: z.string().min(2).max(140).optional(),
  instruction: z.string().min(4).max(2400).optional(),
  coordinatorAgent: z.string().min(2).max(80).optional(),
  ensureActive: z.boolean().optional()
});

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  await ensureAdminBootstrapUser();

  app.post('/admin/auth/login', async (request, reply) => {
    const body = loginBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }

    const admin = await authenticateAdmin(body.data.email, body.data.password);
    if (!admin) {
      return reply.status(401).send({ error: 'invalid_credentials' });
    }

    const token = issueAdminToken(admin);
    return {
      token: token.token,
      expiresInSeconds: token.expiresInSeconds,
      user: {
        id: admin.id,
        email: admin.email,
        role: admin.role
      }
    };
  });

  app.post('/admin/auth/bootstrap', async (request, reply) => {
    const legacyToken = request.headers['x-admin-token'];
    if (typeof legacyToken !== 'string' || legacyToken !== config.adminToken) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const body = bootstrapBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }

    await setAdminPassword(body.data.email, body.data.password, 'owner');
    return { ok: true };
  });

  app.get('/admin/auth/me', async (request, reply) => {
    const session = getAdminSessionFromRequest(request.headers as Record<string, unknown>);
    if (!session) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    return {
      id: session.id,
      email: session.email,
      role: session.role,
      authType: session.authType
    };
  });

  app.get('/admin/agents/config', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    return getAgentCoordinatorConfig();
  });

  app.get('/admin/agents/family-squad/status', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    const status = await getFamilyPlanSquadStatus();
    return { ok: true, status };
  });

  app.post('/admin/agents/family-squad/activate', async (request, reply) => {
    const session = getAdminSessionFromRequest(request.headers as Record<string, unknown>);
    if (!session) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const body = activateFamilySquadBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }

    const result = await activateFamilyPlanSquad({
      createdBy: session.email,
      openKickoffRoom: body.data.openKickoffRoom ?? true,
      kickoffInstruction: body.data.kickoffInstruction
    });

    return { ok: true, ...result };
  });

  app.post('/admin/agents/family-squad/rooms', async (request, reply) => {
    const session = getAdminSessionFromRequest(request.headers as Record<string, unknown>);
    if (!session) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const body = createFamilySquadRoomBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }

    const result = await createFamilyPlanSquadRoom({
      title: body.data.title,
      instruction: body.data.instruction,
      coordinatorAgent: body.data.coordinatorAgent,
      ensureActive: body.data.ensureActive,
      createdBy: session.email
    });

    return { ok: true, ...result };
  });

  app.put('/admin/agents/config', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const body = updateAgentConfigBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }

    const updated = await updateAgentCoordinatorConfig({
      coordinatorAgent: body.data.coordinatorAgent,
      agents: body.data.agents?.map((agent) => ({
        ...agent,
        active: agent.active ?? true
      }))
    });

    return { ok: true, config: updated };
  });

  app.get('/admin/agents/rooms', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const limitRaw = Number((request.query as { limit?: string } | undefined)?.limit ?? 25);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 25;
    const rooms = await listAgentMeetingRooms(limit);
    return { ok: true, rooms };
  });

  app.get('/admin/agents/rooms/:id', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const { id } = request.params as { id: string };
    const room = await getAgentMeetingRoom(id);
    if (!room) {
      return reply.status(404).send({ error: 'room_not_found' });
    }
    return { ok: true, room };
  });

  app.post('/admin/agents/rooms', async (request, reply) => {
    const session = getAdminSessionFromRequest(request.headers as Record<string, unknown>);
    if (!session) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const body = createAgentRoomBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }

    const room = await createAgentMeetingRoom({
      title: body.data.title,
      instruction: body.data.instruction,
      coordinatorAgent: body.data.coordinatorAgent,
      createdBy: session.email
    });

    return { ok: true, room };
  });

  app.post('/admin/agents/rooms/:id/instructions', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const body = appendAgentInstructionBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }

    const { id } = request.params as { id: string };
    try {
      const room = await appendAgentMeetingInstruction({
        roomId: id,
        instruction: body.data.instruction,
        coordinatorAgent: body.data.coordinatorAgent
      });
      return { ok: true, room };
    } catch (error) {
      if (error instanceof Error && error.message === 'room_not_found') {
        return reply.status(404).send({ error: 'room_not_found' });
      }
      throw error;
    }
  });

  app.get('/admin/metrics', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    return adminMetrics();
  });

  app.get('/admin/costs/overview', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    return costOverview();
  });

  app.get('/admin/costs/snapshots', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const limit = Number((request.query as { limit?: string } | undefined)?.limit ?? 30);
    return listCostSnapshots(limit);
  });

  app.post('/admin/costs/snapshots', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    return saveDailyCostSnapshot();
  });

  app.post('/admin/subscriptions/sync-status', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    return refreshSubscriptionStatuses();
  });

  app.post('/admin/subscriptions/migrate-pricing', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const body = migratePricingBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }

    const result = await migrateSubscriptionsToCurrentPlanPricing({
      skipCanceled: body.data.skipCanceled,
      includeFree: body.data.includeFree,
      dryRun: body.data.dryRun,
      customerLimit: body.data.customerLimit,
      planCodes: body.data.planCodes
    });

    return { ok: true, result };
  });

  app.get('/admin/customers', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    return listCustomers();
  });

  app.get('/admin/plans', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    return listPlans();
  });

  app.get('/admin/customers/:id/subscription', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const { id } = request.params as { id: string };
    return getCustomerSubscription(id);
  });

  app.post('/admin/customers/:id/subscription/referrals', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const body = referralBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }

    const { id } = request.params as { id: string };
    return changeReferralCount(id, body.data.delta);
  });

  app.post('/admin/customers/:id/subscription/payments', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const body = paymentBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }

    const { id } = request.params as { id: string };

    const prePayment = await pool.query<{ has_paid_setup: boolean }>(
      `SELECT has_paid_setup FROM subscriptions WHERE customer_id = $1 LIMIT 1`,
      [id]
    );
    const isFirstActivation = !prePayment.rows[0]?.has_paid_setup;

    const result = await recordSubscriptionPayment({
      customerId: id,
      paymentType: body.data.paymentType,
      amountCents: body.data.amountCents,
      gateway: body.data.gateway,
      externalReference: body.data.externalReference
    });

    if (isFirstActivation) {
      try {
        const customer = await pool.query<{ whatsapp_number: string; name: string | null }>(
          `SELECT c.whatsapp_number, c.name, s.plan_code
           FROM customers c JOIN subscriptions s ON s.customer_id = c.id
           WHERE c.id = $1 LIMIT 1`,
          [id]
        );
        const row = customer.rows[0];
        if (row?.whatsapp_number) {
          await sendWelcomeActivationMessage({
            to: row.whatsapp_number,
            customerName: row.name,
            planCode: (row as unknown as { plan_code: string }).plan_code ?? 'essential'
          });
        }
      } catch {
        // Non-blocking — payment is already recorded
      }
    }

    return result;
  });

  app.post('/admin/customers/:id/subscription/status', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const body = statusBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }

    const { id } = request.params as { id: string };
    await setCustomerSubscriptionStatus(id, body.data.status);
    return { ok: true };
  });

  app.post('/admin/customers/:id/subscription/plan', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const body = planBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }

    const { id } = request.params as { id: string };
    const result = await setCustomerPlan(id, body.data.planCode);
    return { ok: true, plan: result };
  });

  app.post('/admin/customers/:id/subscription/trial', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const body = trialBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }

    const { id } = request.params as { id: string };
    const trial = await activateCustomerTrial(id, body.data.days ?? 5);
    return { ok: true, trial };
  });

  app.get('/admin/customers/:id/transactions', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const { id } = request.params as { id: string };
    return customerTransactions(id);
  });

  app.get('/admin/customers/:id/goals', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    const { id } = request.params as { id: string };
    return listActiveFinancialGoals(id);
  });

  app.get('/admin/customers/:id/goals/progress', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    const { id } = request.params as { id: string };
    return financialGoalsProgress(id);
  });

  app.post('/admin/customers/:id/goals', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    const body = goalBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }
    const { id } = request.params as { id: string };
    const goal = await createFinancialGoal({
      customerId: id,
      title: body.data.title,
      targetCents: body.data.targetCents,
      deadlineDate: body.data.deadlineDate,
      startDate: body.data.startDate
    });
    return { ok: true, goal };
  });

  app.get('/admin/customers/:id/reminders', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    const { id } = request.params as { id: string };
    return listBillReminders(id);
  });

  app.post('/admin/customers/:id/reminders', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    const body = reminderBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }
    const { id } = request.params as { id: string };
    const reminder = await createBillReminder({
      customerId: id,
      title: body.data.title,
      dueDate: body.data.dueDate,
      dueTime: body.data.dueTime,
      remindDaysBefore: body.data.remindDaysBefore,
      remindMinutesBefore: body.data.remindMinutesBefore,
      recurrence: body.data.recurrence,
      amountCents: body.data.amountCents
    });
    return { ok: true, reminder };
  });

  app.get('/admin/customers/:id/insights', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    const { id } = request.params as { id: string };
    const [forecast, recurring] = await Promise.all([
      forecastCashflowMonth(id),
      detectRecurringExpenses(id)
    ]);
    return { forecast, recurring };
  });

  app.delete('/admin/customers/:id', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const { id } = request.params as { id: string };
    const removed = await deleteCustomer(id);
    if (!removed.deleted) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return { ok: true, removed };
  });

  app.get('/admin/payments', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const limit = Number((request.query as { limit?: string } | undefined)?.limit ?? 200);
    return listPayments(limit);
  });

  app.post('/admin/billing/customers/:id/charges', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const body = createChargeBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }

    const { id } = request.params as { id: string };
    const charge = await createAsaasCharge({
      customerId: id,
      paymentType: body.data.paymentType,
      dueDate: body.data.dueDate,
      amountCents: body.data.amountCents
    });

    return { ok: true, charge };
  });

  app.post('/admin/billing/renewals/run', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const body = renewalsBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }

    const result = await runAsaasRenewalSweep(body.data.daysAhead ?? 0);
    return { ok: true, result };
  });

  app.post('/admin/automation/proactive/run', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const body = proactiveBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }

    const result = await runProactiveAlerts({
      dryRun: body.data.dryRun ?? false,
      customerLimit: body.data.customerLimit,
      timezone: config.defaultTimezone
    });
    return { ok: true, result };
  });

  app.get('/admin/automation/proactive/status', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    return { ok: true, scheduler: getProactiveSchedulerState() };
  });
}
