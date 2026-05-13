CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  whatsapp_number TEXT NOT NULL UNIQUE,
  plan_name TEXT DEFAULT 'starter',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_inbound_at TIMESTAMPTZ,
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  asaas_customer_id TEXT,
  tax_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BRL',
  category TEXT NOT NULL DEFAULT 'outros',
  description TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  source_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_customer_occurred
  ON transactions (customer_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_customers_asaas_customer_id
  ON customers (asaas_customer_id);

CREATE TABLE IF NOT EXISTS conversation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending_setup_payment',
  setup_fee_cents INTEGER NOT NULL DEFAULT 6000,
  base_monthly_fee_cents INTEGER NOT NULL DEFAULT 2000,
  discounted_monthly_fee_cents INTEGER NOT NULL DEFAULT 1000,
  referral_count INTEGER NOT NULL DEFAULT 0,
  referral_threshold INTEGER NOT NULL DEFAULT 6,
  has_paid_setup BOOLEAN NOT NULL DEFAULT FALSE,
  start_date DATE,
  next_due_date DATE,
  last_payment_date DATE,
  grace_days INTEGER NOT NULL DEFAULT 3,
  trial_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  trial_start_date DATE,
  trial_end_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status_due
  ON subscriptions (status, next_due_date);

CREATE INDEX IF NOT EXISTS idx_subscriptions_trial_active
  ON subscriptions (trial_enabled, trial_end_date);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  payment_type TEXT NOT NULL DEFAULT 'monthly',
  gateway TEXT NOT NULL DEFAULT 'manual',
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'paid',
  due_date DATE,
  paid_at TIMESTAMPTZ,
  external_reference TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_customer_created
  ON payments (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_gateway_external_reference
  ON payments (gateway, external_reference);

CREATE TABLE IF NOT EXISTS spending_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(customer_id, period)
);

CREATE INDEX IF NOT EXISTS idx_spending_limits_customer_active
  ON spending_limits (customer_id, is_active, period);

INSERT INTO admin_users (email, password_hash, role)
VALUES ('owner@finance-bot.local', 'dev-only-change-me', 'owner')
ON CONFLICT (email) DO NOTHING;

INSERT INTO subscriptions (customer_id, status, has_paid_setup)
SELECT id, 'pending_setup_payment', FALSE
FROM customers
ON CONFLICT (customer_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS savings_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  target_cents INTEGER NOT NULL CHECK (target_cents > 0),
  deadline_date DATE NOT NULL,
  monthly_target_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_savings_goals_customer_status
  ON savings_goals (customer_id, status);
