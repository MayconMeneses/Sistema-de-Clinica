-- 0014_payments: cobrança online (Pix e link de pagamento) pelo Mercado Pago. Capability: payments.gateway.
-- Cada clínica usa a PRÓPRIA conta do provedor (o dinheiro cai na conta da clínica). As credenciais ficam cifradas em repouso.
-- Estado do adaptador real: escrito, testado contra um servidor falso local; NÃO validado com o Mercado Pago de verdade.

INSERT INTO capabilities (code, description, globally_available, depends_on) VALUES
  ('payments.gateway', 'Pagamentos online (Pix e link)', true, '{finance.advanced}');
INSERT INTO plan_capabilities (plan_code, capability_code) VALUES
  ('gestao','payments.gateway'), ('completa','payments.gateway'), ('enterprise','payments.gateway');

-- ---------------------------------------------------------------- Configuração por clínica
CREATE TABLE payment_settings (
  tenant_id          uuid PRIMARY KEY REFERENCES tenants(id),
  provider           text NOT NULL DEFAULT 'mercadopago' CHECK (provider IN ('mercadopago')),
  mode               text NOT NULL DEFAULT 'disabled' CHECK (mode IN ('disabled','sandbox','live')),
  access_token_enc   text,                 -- AES-256-GCM (DATA_ENCRYPTION_KEY); nunca devolvido pela API
  token_last4        text CHECK (token_last4 IS NULL OR length(token_last4) <= 4),
  webhook_secret_enc text,                 -- segredo de assinatura das notificações
  updated_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (mode <> 'live' OR access_token_enc IS NOT NULL)   -- produção exige credencial
);

-- ---------------------------------------------------------------- Cobranças online
CREATE TABLE payment_intents (
  id                  uuid NOT NULL,                 -- derivado da chave de idempotência (repetir a chamada não duplica)
  tenant_id           uuid NOT NULL,
  patient_id          uuid NOT NULL,
  amount_cents        bigint NOT NULL CHECK (amount_cents >= 100),
  description         text NOT NULL CHECK (length(btrim(description)) BETWEEN 2 AND 120),
  method              text NOT NULL CHECK (method IN ('pix','link')),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled','expired','refunded')),
  provider            text NOT NULL CHECK (provider IN ('mercadopago','sandbox')),
  provider_payment_id text,                          -- no link de pagamento só existe depois que o paciente paga
  checkout_url        text,
  pix_qr_code         text,                          -- "copia e cola"
  pix_qr_base64       text,
  payer_email         text CHECK (payer_email IS NULL OR length(payer_email) <= 200),
  expires_at          timestamptz NOT NULL,
  provider_status     text,                          -- último status bruto do provedor (diagnóstico)
  paid_method         text CHECK (paid_method IN ('pix','card')),
  payment_movement_id uuid,
  refund_movement_id  uuid,
  idempotency_key     text NOT NULL,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_movement_id) REFERENCES financial_movements(tenant_id, id),
  FOREIGN KEY (tenant_id, refund_movement_id) REFERENCES financial_movements(tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, provider, provider_payment_id),
  CHECK ((status IN ('approved','refunded')) = (payment_movement_id IS NOT NULL)),
  CHECK ((status = 'refunded') = (refund_movement_id IS NOT NULL))
);
CREATE INDEX payment_intents_patient_idx ON payment_intents (tenant_id, patient_id, created_at DESC);
CREATE INDEX payment_intents_status_idx ON payment_intents (tenant_id, status, created_at DESC);

-- Valor, paciente e forma nunca mudam. Estados finais são definitivos. Nada é apagado.
-- Transições: pending → approved | rejected | cancelled | expired ; approved → refunded.
CREATE FUNCTION payment_intents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cobrança online não pode ser excluída' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.patient_id <> OLD.patient_id OR NEW.amount_cents <> OLD.amount_cents
     OR NEW.method <> OLD.method OR NEW.provider <> OLD.provider OR NEW.created_by <> OLD.created_by OR NEW.idempotency_key <> OLD.idempotency_key THEN
    RAISE EXCEPTION 'dados da cobrança online são imutáveis' USING ERRCODE = 'insufficient_privilege';
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
CREATE TRIGGER payment_intents_guard_trg BEFORE UPDATE OR DELETE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION payment_intents_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_intents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_own_tenant ON %I FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
-- payment_settings guarda segredos: só o runtime da clínica (com o tenant fixado) lê e grava; a plataforma e o worker não têm acesso.
ALTER TABLE payment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own_tenant ON payment_settings FOR ALL TO clinica_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON payment_settings, payment_intents TO clinica_app;
