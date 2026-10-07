-- 0019_commissions: comissões e repasses de profissionais. Capability: finance.advanced. Valores em centavos.
-- Base = PRODUÇÃO: cobranças geradas por atendimento concluído ou procedimento concluído, atribuídas ao profissional.
-- (Não considera descontos nem inadimplência; o repasse é uma decisão da clínica sobre o que a regra calcula.)

-- Cobranças passam a registrar o profissional (atendimentos antigos continuam atribuídos pela consulta).
ALTER TABLE financial_movements ADD COLUMN professional_id uuid;
ALTER TABLE financial_movements ADD CONSTRAINT financial_movements_professional_fk FOREIGN KEY (tenant_id, professional_id) REFERENCES users(tenant_id, id);
ALTER TABLE financial_movements ADD CONSTRAINT financial_movements_professional_charge CHECK (professional_id IS NULL OR kind = 'charge');

-- Regra de comissão: percentual em pontos-base (100 = 1%). Cada mudança é uma nova linha; vale a mais recente com vigência até a data da cobrança.
CREATE TABLE commission_rules (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  professional_id uuid NOT NULL,
  percent_bp      int NOT NULL CHECK (percent_bp BETWEEN 0 AND 10000),
  effective_from  date NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, professional_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);
CREATE INDEX commission_rules_lookup_idx ON commission_rules (tenant_id, professional_id, effective_from DESC, created_at DESC);
CREATE TRIGGER commission_rules_append_only BEFORE UPDATE OR DELETE ON commission_rules FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Repasse: valores calculados NO SERVIDOR no momento do registro. Períodos de um mesmo profissional não se sobrepõem (decidido pelo banco).
CREATE TABLE commission_payouts (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  professional_id uuid NOT NULL,
  period_from     date NOT NULL,
  period_to       date NOT NULL,
  base_cents      bigint NOT NULL CHECK (base_cents >= 0),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  charges_count   int NOT NULL CHECK (charges_count >= 1),
  method          text NOT NULL CHECK (method IN ('cash','pix','transfer','other')),
  note            text CHECK (note IS NULL OR length(note) <= 200),
  paid_on         date NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  voided_at       timestamptz,
  voided_by       uuid,
  void_reason     text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 3 AND 200),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, professional_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, voided_by) REFERENCES users(tenant_id, id),
  CHECK (period_to >= period_from),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL AND voided_by IS NULL)),
  CONSTRAINT commission_payouts_no_overlap EXCLUDE USING gist
    (tenant_id WITH =, professional_id WITH =, daterange(period_from, period_to, '[]') WITH &&) WHERE (voided_at IS NULL)
);
CREATE INDEX commission_payouts_pro_idx ON commission_payouts (tenant_id, professional_id, period_from DESC);

-- Só a anulação (uma vez, com motivo) altera a linha; nada é apagado.
CREATE FUNCTION commission_payouts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'repasse não pode ser excluído: anule-o' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'repasse anulado é definitivo' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.professional_id, NEW.period_from, NEW.period_to, NEW.base_cents, NEW.amount_cents, NEW.charges_count, NEW.method, NEW.note, NEW.paid_on, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.professional_id, OLD.period_from, OLD.period_to, OLD.base_cents, OLD.amount_cents, OLD.charges_count, OLD.method, OLD.note, OLD.paid_on, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'dados do repasse são imutáveis' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_payouts_guard_trg BEFORE UPDATE OR DELETE ON commission_payouts FOR EACH ROW EXECUTE FUNCTION commission_payouts_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['commission_rules','commission_payouts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_own_tenant ON %I FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON commission_rules TO clinica_app;
GRANT SELECT, INSERT, UPDATE ON commission_payouts TO clinica_app;
