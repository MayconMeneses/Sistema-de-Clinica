-- 0013_crm: CRM e funil de captação. Capability: crm.pipeline.
-- Lead é uma pessoa que ainda NÃO é paciente. O histórico de cada lead é um livro de eventos imutável.

CREATE TABLE crm_leads (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 160),
  phone               text CHECK (phone IS NULL OR length(phone) <= 30),
  email               text CHECK (email IS NULL OR length(email) <= 200),
  source              text NOT NULL DEFAULT 'other' CHECK (source IN ('referral','instagram','google','website','whatsapp','walk_in','other')),
  interest            text CHECK (interest IS NULL OR length(interest) <= 200),
  stage               text NOT NULL DEFAULT 'new' CHECK (stage IN ('new','contacted','scheduled','won','lost')),
  lost_reason         text CHECK (lost_reason IS NULL OR length(btrim(lost_reason)) BETWEEN 3 AND 200),
  owner_id            uuid,                                   -- responsável pelo atendimento do lead
  next_contact_on     date,
  marketing_consent   boolean NOT NULL DEFAULT false,         -- autorização para receber comunicação de marketing
  marketing_consent_at timestamptz,
  patient_id          uuid,                                   -- preenchido quando o lead vira (ou é ligado a) paciente
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  CHECK ((stage = 'lost') = (lost_reason IS NOT NULL)),
  CHECK (marketing_consent = (marketing_consent_at IS NOT NULL)),
  CHECK (stage <> 'won' OR patient_id IS NOT NULL),            -- ganho = virou paciente
  CHECK (phone IS NOT NULL OR email IS NOT NULL)               -- precisa de um meio de contato
);
CREATE INDEX crm_leads_stage_idx ON crm_leads (tenant_id, stage, created_at DESC);
CREATE INDEX crm_leads_follow_idx ON crm_leads (tenant_id, next_contact_on) WHERE stage IN ('new','contacted','scheduled');

CREATE TABLE crm_lead_events (
  seq         bigint GENERATED ALWAYS AS IDENTITY,        -- ordem exata (eventos da mesma transação têm o mesmo horário)
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  lead_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('created','stage','note','assigned','consent','converted')),
  from_stage  text,
  to_stage    text,
  note        text CHECK (note IS NULL OR length(note) <= 500),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES crm_leads(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);
CREATE INDEX crm_lead_events_idx ON crm_lead_events (tenant_id, lead_id, created_at);
CREATE TRIGGER crm_lead_events_append_only BEFORE UPDATE OR DELETE ON crm_lead_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Lead ganho ou perdido só reabre por ação explícita (a rota registra o evento); leads não são excluídos.
CREATE FUNCTION crm_leads_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lead não pode ser excluído' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'identificação do lead é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.patient_id IS NOT NULL AND NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    RAISE EXCEPTION 'lead já convertido não troca de paciente' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER crm_leads_guard_trg BEFORE UPDATE OR DELETE ON crm_leads
  FOR EACH ROW EXECUTE FUNCTION crm_leads_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['crm_leads','crm_lead_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_own_tenant ON %I FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON crm_leads TO clinica_app;
GRANT SELECT, INSERT ON crm_lead_events TO clinica_app;
