-- 0016_cash_adjustments: sangria (retirada de dinheiro do caixa) e suprimento (reforço de troco). Valores em centavos.
-- Movimentos imutáveis, só em caixa aberto; o dinheiro esperado passa a ser: abertura + dinheiro recebido − devolvido + suprimentos − sangrias.

CREATE TABLE cash_adjustments (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  cash_session_id  uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('withdrawal','supply')),
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  reason           text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 200),
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, cash_session_id) REFERENCES cash_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);
CREATE INDEX cash_adjustments_session_idx ON cash_adjustments (tenant_id, cash_session_id, created_at);

-- Append-only; lançamento só enquanto o caixa está aberto (FOR SHARE espera um fechamento em andamento).
CREATE FUNCTION cash_adjustments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE closed timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'sangria e suprimento são imutáveis' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT closed_at INTO closed FROM cash_sessions WHERE tenant_id = NEW.tenant_id AND id = NEW.cash_session_id FOR SHARE;
  IF closed IS NOT NULL THEN
    RAISE EXCEPTION 'caixa fechado não aceita lançamentos' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_adjustments_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON cash_adjustments
  FOR EACH ROW EXECUTE FUNCTION cash_adjustments_guard();

ALTER TABLE cash_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own_tenant ON cash_adjustments FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT ON cash_adjustments TO clinica_app;
