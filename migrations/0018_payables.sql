-- 0018_payables: contas a pagar. Capability: finance.advanced. Valores em centavos.
-- Conta aberta pode ser corrigida; paga ou cancelada fica imutável. Nada é excluído.

CREATE TABLE payables (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  group_id      uuid NOT NULL,                 -- parcelas da mesma compra compartilham o group_id
  installment   smallint NOT NULL DEFAULT 1 CHECK (installment >= 1),
  installments  smallint NOT NULL DEFAULT 1 CHECK (installments BETWEEN 1 AND 60 AND installment <= installments),
  description   text NOT NULL CHECK (length(btrim(description)) BETWEEN 2 AND 160),
  supplier      text CHECK (supplier IS NULL OR length(btrim(supplier)) BETWEEN 1 AND 120),
  category      text CHECK (category IS NULL OR length(btrim(category)) BETWEEN 1 AND 60),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  due_on        date NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','canceled')),
  paid_on       date,
  paid_method   text CHECK (paid_method IN ('cash','pix','transfer','card','boleto','other')),
  paid_cents    bigint CHECK (paid_cents IS NULL OR paid_cents > 0),   -- pode diferir do valor (juros/desconto)
  paid_by       uuid,
  paid_at       timestamptz,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 200),
  canceled_by   uuid,
  canceled_at   timestamptz,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, paid_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, canceled_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  UNIQUE (tenant_id, group_id, installment),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  CHECK ((status = 'paid') = (paid_on IS NOT NULL AND paid_method IS NOT NULL AND paid_cents IS NOT NULL AND paid_by IS NOT NULL)),
  CHECK ((status = 'canceled') = (canceled_at IS NOT NULL AND cancel_reason IS NOT NULL AND canceled_by IS NOT NULL))
);
CREATE INDEX payables_due_idx ON payables (tenant_id, status, due_on);

CREATE FUNCTION payables_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'conta a pagar não pode ser excluída: cancele-a' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.group_id <> OLD.group_id OR NEW.installment <> OLD.installment
     OR NEW.installments <> OLD.installments OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'identificação da conta é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'conta % é definitiva', OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payables_guard_trg BEFORE UPDATE OR DELETE ON payables
  FOR EACH ROW EXECUTE FUNCTION payables_guard();

ALTER TABLE payables ENABLE ROW LEVEL SECURITY;
ALTER TABLE payables FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own_tenant ON payables FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON payables TO clinica_app;
