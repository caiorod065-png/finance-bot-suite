ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS trial_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS trial_start_date DATE;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS trial_end_date DATE;

CREATE INDEX IF NOT EXISTS idx_subscriptions_trial_active
  ON subscriptions (trial_enabled, trial_end_date);
