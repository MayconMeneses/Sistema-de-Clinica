-- 0028_patient_portal: portal do paciente. Capability: patient.portal.
-- O paciente entra por um link de uso único criado pela clínica + a data de nascimento (segundo fator; o convite trava após 5 erros).
-- A sessão do paciente é separada da equipe (cookie e tabela próprios) e só enxerga o que for do PRÓPRIO paciente.
-- Pedidos que dependem de decisão humana (novo horário, cancelamento em cima da hora) viram "pedidos do portal" para a recepção.

INSERT INTO capabilities (code, description, globally_available, depends_on) VALUES
  ('patient.portal', 'Portal do paciente', true, '{schedule.core}');
INSERT INTO plan_capabilities (plan_code, capability_code) VALUES
  ('gestao','patient.portal'), ('completa','patient.portal'), ('enterprise','patient.portal');

CREATE TABLE portal_invites (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  patient_id  uuid NOT NULL,
  token_hash  text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  attempts    smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  used_at     timestamptz,
  revoked_at  timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);
CREATE INDEX portal_invites_patient_idx ON portal_invites (tenant_id, patient_id, created_at DESC);

CREATE TABLE portal_sessions (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  patient_id  uuid NOT NULL,
  token_hash  text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (token_hash),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id)
);
CREATE INDEX portal_sessions_patient_idx ON portal_sessions (tenant_id, patient_id) WHERE revoked_at IS NULL;

CREATE TABLE portal_requests (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  patient_id      uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('schedule','reschedule','cancel')),
  appointment_id  uuid,
  message         text CHECK (message IS NULL OR length(btrim(message)) BETWEEN 1 AND 300),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_by     uuid,
  resolved_at     timestamptz,
  resolution_note text CHECK (resolution_note IS NULL OR length(resolution_note) <= 300),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments(tenant_id, id),
  FOREIGN KEY (tenant_id, resolved_by) REFERENCES users(tenant_id, id),
  CHECK ((status = 'open') = (resolved_at IS NULL)),
  CHECK (kind = 'schedule' OR appointment_id IS NOT NULL)
);
-- um pedido aberto por consulta e tipo (o paciente não "enche" a fila repetindo)
CREATE UNIQUE INDEX portal_requests_one_open ON portal_requests (tenant_id, appointment_id, kind) WHERE status = 'open' AND appointment_id IS NOT NULL;
CREATE INDEX portal_requests_open_idx ON portal_requests (tenant_id, created_at) WHERE status = 'open';

-- Documento liberado para o paciente (a equipe decide, documento a documento)
ALTER TABLE patient_documents ADD COLUMN shared_with_patient boolean NOT NULL DEFAULT false;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['portal_invites','portal_sessions','portal_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_own_tenant ON %I FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON portal_invites, portal_sessions, portal_requests TO clinica_app;
GRANT UPDATE (shared_with_patient) ON patient_documents TO clinica_app;
