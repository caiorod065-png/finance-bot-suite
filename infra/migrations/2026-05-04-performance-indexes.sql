-- Índices para conversation_logs — usados em hasAutoMessageToday/Week/Month e hasInboundMessageToday
-- Sem estes índices, cada verificação de deduplicação de alerta faz seq scan na tabela
CREATE INDEX IF NOT EXISTS idx_conversation_logs_customer_created
  ON conversation_logs (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_logs_customer_direction_created
  ON conversation_logs (customer_id, direction, created_at DESC);

-- Constraint único em payments.external_reference — impede cobranças duplicadas
-- em chamadas concorrentes ao Asaas para o mesmo cliente/tipo/data
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_external_reference_unique
  ON payments (external_reference)
  WHERE external_reference IS NOT NULL;
