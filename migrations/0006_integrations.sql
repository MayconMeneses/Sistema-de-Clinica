-- 0006_integrations: consentimentos, outbox transacional, conexões de integração e webhooks recebidos.
-- Papel clinica_worker: processa a fila entre tenants, mas só enxerga outbox_events e webhook_receipts.

GRANT EXECUTE ON FUNCTION app_current_tenant() TO clinica_worker;

-- ---------------------------------------------------------------- CONSENTIMENTO (append-only, versionado)
CREATE TABLE patient_consents (
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  patient_id      uuid NOT NULL,
  purpose         text NOT NULL CHECK (purpose IN ('communication_whatsapp','communication_email','communication_sms')),
  granted         boolean NOT NULL,
  policy_version  text NOT NULL DEFAULT '1',
  source          text NOT NULL DEFAULT 'staff' CHECK (source IN ('staff','patient_portal','import')),
  recorded_by     uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES users(tenant_id, id)
);
CREATE INDEX patient_consents_idx ON patient_consents (tenant_id, patient_id, purpose, seq DESC);
CREATE TRIGGER patient_consents_append_only BEFORE UPDATE OR DELETE ON patient_consents
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- CONEXÕES DE INTEGRAÇÃO (por clínica)
CREATE TABLE integration_connections (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  kind        text NOT NULL CHECK (kind IN ('email','sms','whatsapp','payments','storage','calendar','nfse','signature')),
  provider    text NOT NULL CHECK (length(provider) BETWEEN 2 AND 40),
  mode        text NOT NULL DEFAULT 'sandbox' CHECK (mode IN ('disabled','sandbox','live')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, kind)
);

-- ---------------------------------------------------------------- OUTBOX TRANSACIONAL
-- Efeitos externos são gravados na MESMA transação da mudança de negócio e executados depois, com retry.
CREATE TABLE outbox_events (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  topic            text NOT NULL CHECK (topic IN ('message.send')),
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','processing','sent','failed','dead','skipped')),
  delivery_status  text CHECK (delivery_status IN ('sent','delivered','read','failed')),
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 6 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  last_error       text,
  external_id      text,
  idempotency_key  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX outbox_due_idx ON outbox_events (next_attempt_at) WHERE status IN ('pending','failed','processing');
CREATE INDEX outbox_external_idx ON outbox_events (external_id) WHERE external_id IS NOT NULL;
CREATE INDEX outbox_patient_idx ON outbox_events (tenant_id, (payload->>'patientId'), created_at DESC);
CREATE TRIGGER outbox_no_delete BEFORE DELETE ON outbox_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- WEBHOOKS RECEBIDOS (dedupe + dead-letter)
-- Guarda só o evento NORMALIZADO (sem corpo bruto, sem telefone/e-mail). Sem tenant_id: o tenant é resolvido pelo vínculo com a outbox.
CREATE TABLE webhook_receipts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider             text NOT NULL,
  external_event_id    text NOT NULL,
  external_message_id  text NOT NULL,
  event_status         text NOT NULL CHECK (event_status IN ('sent','delivered','read','failed')),
  status               text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','dead')),
  attempts             int NOT NULL DEFAULT 0,
  received_at          timestamptz NOT NULL DEFAULT now(),
  processed_at         timestamptz,
  UNIQUE (provider, external_event_id)
);
CREATE INDEX webhook_receipts_open_idx ON webhook_receipts (received_at) WHERE status = 'received';

-- ---------------------------------------------------------------- RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['patient_consents','integration_connections','outbox_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

CREATE POLICY app_own_tenant ON patient_consents FOR ALL TO clinica_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY app_read_own ON integration_connections FOR SELECT TO clinica_app USING (tenant_id = app_current_tenant());
CREATE POLICY platform_all ON integration_connections FOR ALL TO clinica_platform USING (true) WITH CHECK (true);

CREATE POLICY app_read_own ON outbox_events FOR SELECT TO clinica_app USING (tenant_id = app_current_tenant());
CREATE POLICY app_insert_own ON outbox_events FOR INSERT TO clinica_app WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY worker_all ON outbox_events FOR ALL TO clinica_worker USING (true) WITH CHECK (true);
-- Master vê só metadados (sem payload) e só pode recolocar na fila o que está morto.
CREATE POLICY platform_read ON outbox_events FOR SELECT TO clinica_platform USING (true);
CREATE POLICY platform_requeue ON outbox_events FOR UPDATE TO clinica_platform
  USING (status = 'dead') WITH CHECK (status = 'pending');

GRANT SELECT, INSERT ON patient_consents TO clinica_app;
GRANT SELECT ON integration_connections TO clinica_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON integration_connections TO clinica_platform;
GRANT SELECT, INSERT ON outbox_events TO clinica_app;
GRANT SELECT, UPDATE ON outbox_events TO clinica_worker;
GRANT SELECT (id, tenant_id, topic, status, delivery_status, attempts, last_error, created_at, updated_at, processed_at) ON outbox_events TO clinica_platform;
GRANT UPDATE (status, attempts, next_attempt_at) ON outbox_events TO clinica_platform;

GRANT SELECT, INSERT, UPDATE ON webhook_receipts TO clinica_worker;
GRANT SELECT ON webhook_receipts TO clinica_platform;
GRANT UPDATE (status, attempts) ON webhook_receipts TO clinica_platform;
