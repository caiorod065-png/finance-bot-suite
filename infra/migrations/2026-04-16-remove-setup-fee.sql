-- Remove taxa de ativação (setup fee) de R$60 de todos os planos pagos.
-- O primeiro pagamento do cliente agora é a mensalidade do plano escolhido.

ALTER TABLE subscriptions ALTER COLUMN setup_fee_cents SET DEFAULT 0;

UPDATE subscriptions
SET setup_fee_cents = 0
WHERE setup_fee_cents > 0;
