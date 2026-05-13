ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS asaas_customer_id TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_asaas_customer_id
  ON customers (asaas_customer_id);

CREATE INDEX IF NOT EXISTS idx_payments_gateway_external_reference
  ON payments (gateway, external_reference);
