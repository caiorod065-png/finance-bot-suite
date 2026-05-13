-- Sprint 1 Família: cofres compartilhados, alertas de risco, reunião mensal

-- Adiciona suporte a cofres familiares na tabela de metas
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS family_group_id UUID REFERENCES family_groups(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_savings_goals_family_group ON savings_goals (family_group_id, status);
