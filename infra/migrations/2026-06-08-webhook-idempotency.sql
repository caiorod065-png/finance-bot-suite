-- Deduplicação de webhooks WhatsApp
-- Garante que mensagens reenviadas pelo Meta não gerem transações duplicadas

CREATE TABLE IF NOT EXISTS processed_webhook_messages (
  message_id   TEXT        NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT processed_webhook_messages_pkey PRIMARY KEY (message_id)
);

CREATE INDEX IF NOT EXISTS idx_processed_webhook_messages_processed_at
  ON processed_webhook_messages (processed_at);
