CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status_due
  ON subscriptions (status, next_due_date);

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

INSERT INTO subscriptions (customer_id, status, has_paid_setup)
SELECT id, 'pending_setup_payment', FALSE
FROM customers
ON CONFLICT (customer_id) DO NOTHING;
