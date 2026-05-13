ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS tax_id TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_tax_id
  ON customers (tax_id);
