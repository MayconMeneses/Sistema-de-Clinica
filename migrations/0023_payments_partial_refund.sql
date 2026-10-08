-- 0023_payments_partial_refund: estorno parcial de pagamentos online.
-- A cobrança continua "paga" enquanto parte do valor foi devolvida; vira "estornada" quando o total devolvido iguala o valor.
-- Cada devolução é um movimento de estorno imutável no financeiro e uma linha em payment_refunds.

ALTER TABLE payment_intents ADD COLUMN refunded_cents bigint NOT NULL DEFAULT 0;

-- Cobranças já estornadas por inteiro (antes desta versão) passam a registrar o valor devolvido.
-- (A tabela tem RLS forçada: a migração abre uma política temporária para o papel que a executa, só para este ajuste.)
DO $$ BEGIN EXECUTE format('CREATE POLICY mig_0023_tmp ON payment_intents FOR ALL TO %I USING (true) WITH CHECK (true)', current_user); END $$;
ALTER TABLE payment_intents DISABLE TRIGGER payment_intents_guard_trg;
UPDATE payment_intents SET refunded_cents = amount_cents WHERE status = 'refunded';
ALTER TABLE payment_intents ENABLE TRIGGER payment_intents_guard_trg;

ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_refunded_range CHECK (refunded_cents >= 0 AND refunded_cents <= amount_cents);
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_refunded_status CHECK ((status = 'refunded') = (refunded_cents = amount_cents));
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_refunded_only_paid CHECK (refunded_cents = 0 OR status IN ('approved','refunded'));
-- refund_movement_id passa a apontar para o ÚLTIMO estorno (parcial ou total).
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'payment_intents'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%refund_movement_id%' LOOP
    EXECUTE format('ALTER TABLE payment_intents DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_refund_movement_check CHECK ((refunded_cents > 0) = (refund_movement_id IS NOT NULL));

CREATE OR REPLACE FUNCTION payment_intents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cobrança online não pode ser excluída' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.patient_id <> OLD.patient_id OR NEW.amount_cents <> OLD.amount_cents
     OR NEW.method <> OLD.method OR NEW.provider <> OLD.provider OR NEW.created_by <> OLD.created_by OR NEW.idempotency_key <> OLD.idempotency_key THEN
    RAISE EXCEPTION 'dados da cobrança online são imutáveis' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.refunded_cents < OLD.refunded_cents THEN
    RAISE EXCEPTION 'valor estornado não pode diminuir' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> NEW.status THEN
    IF NOT ((OLD.status = 'pending' AND NEW.status IN ('approved','rejected','cancelled','expired')) OR (OLD.status = 'approved' AND NEW.status = 'refunded')) THEN
      RAISE EXCEPTION 'transição inválida de cobrança online: % → %', OLD.status, NEW.status USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF OLD.status IN ('rejected','cancelled','expired','refunded') THEN
    RAISE EXCEPTION 'cobrança online finalizada é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TABLE payment_refunds (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  intent_id        uuid NOT NULL,
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  cumulative_cents bigint NOT NULL CHECK (cumulative_cents >= amount_cents),   -- total devolvido depois deste estorno
  movement_id      uuid NOT NULL,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, intent_id) REFERENCES payment_intents(tenant_id, id),
  FOREIGN KEY (tenant_id, movement_id) REFERENCES financial_movements(tenant_id, id),
  UNIQUE (tenant_id, intent_id, cumulative_cents)
);
CREATE TRIGGER payment_refunds_append_only BEFORE UPDATE OR DELETE ON payment_refunds FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- Estornos totais anteriores viram uma linha cada.
INSERT INTO payment_refunds (tenant_id, intent_id, amount_cents, cumulative_cents, movement_id, created_by)
  SELECT tenant_id, id, amount_cents, amount_cents, refund_movement_id, created_by FROM payment_intents WHERE status = 'refunded';

DROP POLICY IF EXISTS mig_0023_tmp ON payment_intents;
ALTER TABLE payment_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_refunds FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own_tenant ON payment_refunds FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT ON payment_refunds TO clinica_app;
