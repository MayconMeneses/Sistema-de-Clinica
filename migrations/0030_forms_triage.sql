-- 0030_forms_triage: formulários antes da consulta (anamnese etc.) e triagem. Capability: clinical.forms.
-- Modelos são versionados (editar = nova versão; o que foi respondido continua ligado à versão que o paciente viu).
-- Respostas e triagem são dado de saúde: imutáveis depois de enviadas, lidas só por quem acessa o prontuário.

INSERT INTO capabilities (code, description, globally_available, depends_on) VALUES
  ('clinical.forms', 'Formulários pré-consulta e triagem', true, '{clinical.record}');
INSERT INTO plan_capabilities (plan_code, capability_code) VALUES
  ('essencial','clinical.forms'), ('gestao','clinical.forms'), ('completa','clinical.forms'), ('enterprise','clinical.forms');

CREATE TABLE form_templates (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  key         text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  version     int  NOT NULL CHECK (version >= 1),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  fields      jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array' AND jsonb_array_length(fields) BETWEEN 1 AND 60),
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, key, version),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE form_requests (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  patient_id      uuid NOT NULL,
  appointment_id  uuid,
  template_id     uuid NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','canceled')),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  answers         jsonb,
  submitted_at    timestamptz,
  submitted_via   text CHECK (submitted_via IN ('portal','staff')),
  submitted_by    uuid,
  canceled_at     timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments(tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES form_templates(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, submitted_by) REFERENCES users(tenant_id, id),
  CHECK ((status = 'submitted') = (answers IS NOT NULL AND submitted_at IS NOT NULL AND submitted_via IS NOT NULL)),
  CHECK ((status = 'canceled') = (canceled_at IS NOT NULL))
);
CREATE INDEX form_requests_patient_idx ON form_requests (tenant_id, patient_id, created_at DESC);
CREATE UNIQUE INDEX form_requests_one_pending ON form_requests (tenant_id, patient_id, template_id, COALESCE(appointment_id, '00000000-0000-0000-0000-000000000000')) WHERE status = 'pending';

CREATE TABLE triage_records (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  patient_id       uuid NOT NULL,
  appointment_id   uuid,
  recorded_by      uuid NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  weight_kg        numeric(5,1) CHECK (weight_kg IS NULL OR weight_kg BETWEEN 1 AND 500),
  height_cm        numeric(4,1) CHECK (height_cm IS NULL OR height_cm BETWEEN 20 AND 260),
  bp_systolic      smallint CHECK (bp_systolic IS NULL OR bp_systolic BETWEEN 40 AND 300),
  bp_diastolic     smallint CHECK (bp_diastolic IS NULL OR bp_diastolic BETWEEN 20 AND 200),
  heart_rate       smallint CHECK (heart_rate IS NULL OR heart_rate BETWEEN 20 AND 300),
  temperature_c    numeric(3,1) CHECK (temperature_c IS NULL OR temperature_c BETWEEN 30 AND 45),
  pain_scale       smallint CHECK (pain_scale IS NULL OR pain_scale BETWEEN 0 AND 10),
  allergies        text CHECK (allergies IS NULL OR length(allergies) <= 300),
  medications      text CHECK (medications IS NULL OR length(medications) <= 300),
  complaint        text CHECK (complaint IS NULL OR length(complaint) <= 300),
  notes            text CHECK (notes IS NULL OR length(notes) <= 500),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments(tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES users(tenant_id, id),
  CHECK ((bp_systolic IS NULL) = (bp_diastolic IS NULL)),
  CHECK (bp_systolic IS NULL OR bp_systolic > bp_diastolic),
  CHECK (num_nonnulls(weight_kg, height_cm, bp_systolic, heart_rate, temperature_c, pain_scale, allergies, medications, complaint, notes) >= 1)
);
CREATE INDEX triage_patient_idx ON triage_records (tenant_id, patient_id, recorded_at DESC);
CREATE INDEX triage_appt_idx ON triage_records (tenant_id, appointment_id) WHERE appointment_id IS NOT NULL;

-- Modelo: só "active" muda. Resposta enviada ou formulário cancelado é definitivo. Triagem é append-only (correção = nova triagem).
CREATE FUNCTION form_templates_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'modelo de formulário não pode ser excluído: desative-o' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.key, NEW.version, NEW.name, NEW.fields, NEW.created_by, NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.key, OLD.version, OLD.name, OLD.fields, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'o conteúdo do modelo é imutável: crie uma nova versão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER form_templates_guard_trg BEFORE UPDATE OR DELETE ON form_templates FOR EACH ROW EXECUTE FUNCTION form_templates_guard();

CREATE FUNCTION form_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'formulário não pode ser excluído: cancele-o' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'formulário % é definitivo', OLD.status USING ERRCODE = 'insufficient_privilege'; END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.patient_id, NEW.appointment_id, NEW.template_id, NEW.created_by, NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.patient_id, OLD.appointment_id, OLD.template_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'identificação do formulário é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER form_requests_guard_trg BEFORE UPDATE OR DELETE ON form_requests FOR EACH ROW EXECUTE FUNCTION form_requests_guard();
CREATE TRIGGER triage_records_append_only BEFORE UPDATE OR DELETE ON triage_records FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['form_templates','form_requests','triage_records'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_own_tenant ON %I FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON form_templates, form_requests TO clinica_app;
GRANT SELECT, INSERT ON triage_records TO clinica_app;
