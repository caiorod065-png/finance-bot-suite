import { pool } from '../db/pool.js';
import { config } from '../config.js';

type CustomerBillingRow = {
  id: string;
  name: string | null;
  whatsapp_number: string;
  asaas_customer_id: string | null;
  tax_id: string | null;
};

type SubscriptionBillingRow = {
  id: string;
  customer_id: string;
  status: string;
  setup_fee_cents: number;
  base_monthly_fee_cents: number;
  discounted_monthly_fee_cents: number;
  referral_count: number;
  referral_threshold: number;
  has_paid_setup: boolean;
  next_due_date: string | null;
};

type AsaasCustomerResponse = {
  id: string;
};

type AsaasPaymentResponse = {
  id: string;
  status?: string;
  dueDate?: string;
  value?: number;
  invoiceUrl?: string;
  bankSlipUrl?: string;
};

let customerSchemaReady: Promise<void> | null = null;

async function ensureCustomerSchema(): Promise<void> {
  if (!customerSchemaReady) {
    customerSchemaReady = (async () => {
      await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS tax_id TEXT`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_tax_id ON customers (tax_id)`);
    })().catch((error) => {
      customerSchemaReady = null;
      throw error;
    });
  }

  await customerSchemaReady;
}

function requireAsaasConfig(): void {
  if (!config.asaasApiKey) {
    throw new Error('ASAAS_API_KEY não configurada.');
  }
}

function centsToValue(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

function effectiveMonthlyFeeCents(sub: Pick<SubscriptionBillingRow, 'base_monthly_fee_cents' | 'discounted_monthly_fee_cents' | 'referral_count' | 'referral_threshold'>): number {
  return sub.referral_count >= sub.referral_threshold
    ? sub.discounted_monthly_fee_cents
    : sub.base_monthly_fee_cents;
}

function todayIsoDate(reference = new Date()): string {
  return reference.toISOString().slice(0, 10);
}

function addDaysIsoDate(reference = new Date(), days = 0): string {
  const date = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate(), 12, 0, 0));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function asaasPhoneFromWhatsapp(whatsapp: string): string | undefined {
  const digits = whatsapp.replace(/\D/g, '');
  if (digits.length >= 10 && digits.length <= 13) {
    return digits;
  }
  return undefined;
}

async function asaasRequest<T>(path: string, init?: RequestInit): Promise<T> {
  requireAsaasConfig();

  const response = await fetch(`${config.asaasBaseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      access_token: config.asaasApiKey,
      ...(init?.headers ?? {})
    }
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const safe = { ...body };
    delete safe.cpfCnpj;
    delete safe.cpf;
    delete safe.cnpj;
    throw new Error(`Asaas ${response.status}: ${JSON.stringify(safe)}`);
  }

  return body as T;
}

async function ensureSubscription(customerId: string): Promise<SubscriptionBillingRow> {
  const existing = await pool.query<SubscriptionBillingRow>(
    `SELECT id, customer_id, status, setup_fee_cents, base_monthly_fee_cents, discounted_monthly_fee_cents,
            referral_count, referral_threshold, has_paid_setup, next_due_date::text
     FROM subscriptions
     WHERE customer_id = $1
     LIMIT 1`,
    [customerId]
  );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const created = await pool.query<SubscriptionBillingRow>(
    `INSERT INTO subscriptions (customer_id)
     VALUES ($1)
     RETURNING id, customer_id, status, setup_fee_cents, base_monthly_fee_cents, discounted_monthly_fee_cents,
               referral_count, referral_threshold, has_paid_setup, next_due_date::text`,
    [customerId]
  );

  return created.rows[0];
}

async function getCustomer(customerId: string): Promise<CustomerBillingRow> {
  await ensureCustomerSchema();
  const customer = await pool.query<CustomerBillingRow>(
    `SELECT id, name, whatsapp_number, asaas_customer_id, tax_id
     FROM customers
     WHERE id = $1
     LIMIT 1`,
    [customerId]
  );

  if (!customer.rows[0]) {
    throw new Error('Cliente não encontrado para cobrança.');
  }

  return customer.rows[0];
}

async function getOrCreateAsaasCustomer(customerId: string): Promise<string> {
  const customer = await getCustomer(customerId);
  if (customer.asaas_customer_id) {
    return customer.asaas_customer_id;
  }

  const name = customer.name?.trim() || `Cliente ${customer.id.slice(0, 8)}`;
  const mobilePhone = asaasPhoneFromWhatsapp(customer.whatsapp_number);
  const cpfCnpj = customer.tax_id?.replace(/\D/g, '') || undefined;
  const created = await asaasRequest<AsaasCustomerResponse>('/v3/customers', {
    method: 'POST',
    body: JSON.stringify({
      name,
      mobilePhone,
      cpfCnpj,
      externalReference: customer.id
    })
  });

  await pool.query(
    `UPDATE customers
     SET asaas_customer_id = $2, updated_at = NOW()
     WHERE id = $1`,
    [customer.id, created.id]
  );

  return created.id;
}

export async function createAsaasCharge(params: {
  customerId: string;
  paymentType: 'setup' | 'monthly';
  dueDate?: string;
  amountCents?: number;
}): Promise<{
  created: boolean;
  customerId: string;
  paymentType: 'setup' | 'monthly';
  amountCents: number;
  dueDate: string;
  gatewayPaymentId: string;
  gatewayStatus: string;
  invoiceUrl: string | null;
}> {
  const subscription = await ensureSubscription(params.customerId);
  const dueDate = params.dueDate ?? (params.paymentType === 'setup'
    ? todayIsoDate()
    : subscription.next_due_date ?? addDaysIsoDate(new Date(), 30));
  const amountCents = params.amountCents ?? (params.paymentType === 'setup'
    ? subscription.setup_fee_cents
    : effectiveMonthlyFeeCents(subscription));

  const externalReference = `${params.paymentType}:${params.customerId}:${dueDate}`;

  // Check for an existing pending charge before hitting the Asaas API
  const existingPending = await pool.query<{
    external_reference: string;
    amount_cents: number;
    due_date: string | null;
    status: string;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT external_reference, amount_cents, due_date::text, status, metadata
     FROM payments
     WHERE customer_id = $1
       AND payment_type = $2
       AND gateway = 'asaas'
       AND status IN ('pending', 'created')
       AND due_date = $3::date
     ORDER BY created_at DESC
     LIMIT 1`,
    [params.customerId, params.paymentType, dueDate]
  );

  const currentPending = existingPending.rows[0];
  if (currentPending?.external_reference) {
    return {
      created: false,
      customerId: params.customerId,
      paymentType: params.paymentType,
      amountCents: currentPending.amount_cents,
      dueDate: currentPending.due_date ?? dueDate,
      gatewayPaymentId: currentPending.external_reference,
      gatewayStatus: currentPending.status,
      invoiceUrl: typeof currentPending.metadata?.invoiceUrl === 'string'
        ? currentPending.metadata.invoiceUrl
        : null
    };
  }

  const asaasCustomerId = await getOrCreateAsaasCustomer(params.customerId);
  const description = params.paymentType === 'setup'
    ? 'Pagamento de entrada - Assistente Financeiro'
    : `Mensalidade Assistente Financeiro (${dueDate})`;

  const created = await asaasRequest<AsaasPaymentResponse>('/v3/payments', {
    method: 'POST',
    body: JSON.stringify({
      customer: asaasCustomerId,
      billingType: 'PIX',
      dueDate,
      value: centsToValue(amountCents),
      description,
      externalReference
    })
  });

  const invoiceUrl = created.invoiceUrl ?? created.bankSlipUrl ?? null;

  // ON CONFLICT prevents duplicate rows if two concurrent calls pass the check above
  await pool.query(
    `INSERT INTO payments (customer_id, subscription_id, payment_type, gateway, amount_cents, status, due_date, external_reference, metadata)
     VALUES ($1, $2, $3, 'asaas', $4, 'pending', $5::date, $6, $7)
     ON CONFLICT (external_reference) DO NOTHING`,
    [
      params.customerId,
      subscription.id,
      params.paymentType,
      amountCents,
      dueDate,
      created.id,
      {
        provider: 'asaas',
        asaasExternalReference: externalReference,
        asaasStatus: created.status ?? 'PENDING',
        invoiceUrl
      }
    ]
  );

  return {
    created: true,
    customerId: params.customerId,
    paymentType: params.paymentType,
    amountCents,
    dueDate: created.dueDate ?? dueDate,
    gatewayPaymentId: created.id,
    gatewayStatus: created.status ?? 'PENDING',
    invoiceUrl
  };
}

export async function runAsaasRenewalSweep(daysAhead = 0): Promise<{
  checked: number;
  created: number;
  alreadyPending: number;
  failed: number;
  details: Array<{ customerId: string; ok: boolean; reason?: string }>;
}> {
  const safeDaysAhead = Math.min(Math.max(daysAhead, 0), 60);
  const dueLimit = addDaysIsoDate(new Date(), safeDaysAhead);

  const targets = await pool.query<{
    customer_id: string;
    next_due_date: string;
  }>(
    `SELECT customer_id, next_due_date::text
     FROM subscriptions
     WHERE has_paid_setup = TRUE
       AND status = 'active'
       AND next_due_date IS NOT NULL
       AND next_due_date <= $1::date
     ORDER BY next_due_date ASC`,
    [dueLimit]
  );

  let created = 0;
  let alreadyPending = 0;
  let failed = 0;
  const details: Array<{ customerId: string; ok: boolean; reason?: string }> = [];

  for (const row of targets.rows) {
    try {
      const result = await createAsaasCharge({
        customerId: row.customer_id,
        paymentType: 'monthly',
        dueDate: row.next_due_date
      });

      if (result.created) {
        created += 1;
      } else {
        alreadyPending += 1;
      }
      details.push({ customerId: row.customer_id, ok: true });
    } catch (error) {
      failed += 1;
      details.push({
        customerId: row.customer_id,
        ok: false,
        reason: error instanceof Error ? error.message : 'unknown_error'
      });
    }
  }

  return {
    checked: targets.rowCount ?? 0,
    created,
    alreadyPending,
    failed,
    details
  };
}
