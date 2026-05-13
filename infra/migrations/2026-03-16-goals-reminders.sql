CREATE TABLE IF NOT EXISTS financial_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  target_cents INTEGER NOT NULL CHECK (target_cents > 0),
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  deadline_date DATE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  achieved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_financial_goals_customer_active
  ON financial_goals (customer_id, is_active, deadline_date);

CREATE TABLE IF NOT EXISTS bill_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  amount_cents INTEGER,
  due_date DATE NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none', 'monthly')),
  remind_days_before INTEGER NOT NULL DEFAULT 2 CHECK (remind_days_before BETWEEN 0 AND 30),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_notified_for_due_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bill_reminders_customer_active
  ON bill_reminders (customer_id, is_active, due_date);
