-- 0008_patients_privacy: responsáveis, duplicidade, mesclagem auditada e solicitações de privacidade.

-- ---------------------------------------------------------------- chaves de comparação e alias de mesclagem
ALTER TABLE patients
  ADD COLUMN name_key      text NOT NULL DEFAULT '',   -- nome sem acento/caixa/espaços extras (comparação)
  ADD COLUMN doc_digits    text NOT NULL DEFAULT '',   -- só dígitos do documento
  ADD COLUMN phone_digits  text NOT NULL DEFAULT '',   -- só dígitos do telefone
  ADD COLUMN merged_into   uuid;
ALTER TABLE patients ADD CONSTRAINT patients_merged_fk FOREIGN KEY (tenant_id, merged_into) REFERENCES patients(tenant_id, id);
ALTER TABLE patients ADD CONSTRAINT patients_not_self_merged CHECK (merged_into IS NULL OR merged_into <> id);

-- Regras de normalização ÚNICAS (no banco): comparação ignora acento, caixa, máscara e o prefixo +55.
CREATE FUNCTION name_key(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(regexp_replace(lower(translate(coalesce(t, ''),
    'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ', 'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn')), '\s+', ' ', 'g'))
$$;
CREATE FUNCTION doc_key(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT regexp_replace(coalesce(t, ''), '\D', '', 'g') $$;
CREATE FUNCTION phone_key(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(d) >= 12 AND d LIKE '55%' THEN substr(d, 3) ELSE d END FROM (SELECT doc_key(t) AS d) x
$$;

-- As chaves são mantidas pelo banco: nenhum caminho de escrita (API, seed, importação) fica sem elas.
CREATE FUNCTION patients_set_keys() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.name_key := name_key(NEW.name);
  NEW.doc_digits := doc_key(NEW.document);
  NEW.phone_digits := phone_key(NEW.phone);
  RETURN NEW;
END $$;
CREATE TRIGGER patients_keys_trg BEFORE INSERT OR UPDATE OF name, document, phone ON patients
  FOR EACH ROW EXECUTE FUNCTION patients_set_keys();

-- Preenche as chaves dos cadastros existentes (a migration roda como owner, que sob FORCE RLS não enxerga linhas).
ALTER TABLE patients NO FORCE ROW LEVEL SECURITY;
UPDATE patients SET name = name;   -- dispara o trigger
ALTER TABLE patients FORCE ROW LEVEL SECURITY;
CREATE INDEX patients_doc_idx   ON patients (tenant_id, doc_digits)   WHERE doc_digits <> '' AND merged_into IS NULL;
CREATE INDEX patients_phone_idx ON patients (tenant_id, phone_digits) WHERE phone_digits <> '' AND merged_into IS NULL;
CREATE INDEX patients_name_key_idx ON patients (tenant_id, name_key)  WHERE merged_into IS NULL;
GRANT UPDATE (merged_into) ON patients TO clinica_app;   -- (já tem UPDATE na tabela; explícito para clareza)

-- ---------------------------------------------------------------- responsáveis (pais, tutores, contatos)
CREATE TABLE patient_guardians (
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  patient_id           uuid NOT NULL,
  guardian_patient_id  uuid,                        -- quando o responsável também é paciente da clínica
  name                 text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 160),
  relationship         text NOT NULL CHECK (length(btrim(relationship)) BETWEEN 2 AND 60),
  phone                text,
  email                text,
  document             text,
  legal_guardian       boolean NOT NULL DEFAULT false,
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  ended_at             timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, guardian_patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  CHECK (guardian_patient_id IS NULL OR guardian_patient_id <> patient_id)
);
CREATE INDEX patient_guardians_idx ON patient_guardians (tenant_id, patient_id) WHERE ended_at IS NULL;

-- ---------------------------------------------------------------- mesclagem auditada e "não é duplicado"
CREATE TABLE patient_merges (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  source_id   uuid NOT NULL,
  target_id   uuid NOT NULL,
  reason      text NOT NULL CHECK (length(btrim(reason)) >= 5),
  copied      jsonb NOT NULL DEFAULT '[]',          -- campos de contato herdados do cadastro de origem
  merged_by   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, target_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, merged_by) REFERENCES users(tenant_id, id),
  CHECK (source_id <> target_id)
);
CREATE TRIGGER patient_merges_append_only BEFORE UPDATE OR DELETE ON patient_merges FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE patient_duplicate_dismissals (
  tenant_id     uuid NOT NULL,
  a_id          uuid NOT NULL,
  b_id          uuid NOT NULL,
  dismissed_by  uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, a_id, b_id),
  FOREIGN KEY (tenant_id, a_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, b_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, dismissed_by) REFERENCES users(tenant_id, id),
  CHECK (a_id < b_id)
);

-- ---------------------------------------------------------------- solicitações de privacidade (direitos do titular)
CREATE TABLE privacy_requests (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  patient_id   uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('access','correction','export','deletion','objection','information')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','rejected')),
  details      text CHECK (length(details) <= 1000),
  opened_by    uuid NOT NULL,
  opened_at    timestamptz NOT NULL DEFAULT now(),
  due_at       timestamptz NOT NULL DEFAULT now() + interval '15 days',  -- prazo de referência; confirmar com o jurídico
  resolved_by  uuid,
  resolved_at  timestamptz,
  resolution   text CHECK (length(resolution) <= 1000),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, opened_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, resolved_by) REFERENCES users(tenant_id, id),
  CHECK ((status IN ('done','rejected')) = (resolved_at IS NOT NULL)),
  CHECK (status NOT IN ('done','rejected') OR length(btrim(coalesce(resolution, ''))) >= 5)
);
CREATE INDEX privacy_requests_open_idx ON privacy_requests (tenant_id, due_at) WHERE status IN ('open','in_progress');
-- Solicitação resolvida é registro definitivo; nada é excluído.
CREATE FUNCTION privacy_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'solicitação de privacidade não pode ser excluída' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status IN ('done','rejected') THEN RAISE EXCEPTION 'solicitação já resolvida é imutável' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.patient_id <> OLD.patient_id OR NEW.kind <> OLD.kind OR NEW.opened_at <> OLD.opened_at OR NEW.due_at <> OLD.due_at THEN
    RAISE EXCEPTION 'dados da solicitação não mudam' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER privacy_requests_guard_trg BEFORE UPDATE OR DELETE ON privacy_requests FOR EACH ROW EXECUTE FUNCTION privacy_requests_guard();

-- ---------------------------------------------------------------- RLS e privilégios
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['patient_guardians','patient_merges','patient_duplicate_dismissals','privacy_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_own_tenant ON %I FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON patient_guardians TO clinica_app;
GRANT SELECT, INSERT ON patient_merges TO clinica_app;
GRANT SELECT, INSERT ON patient_duplicate_dismissals TO clinica_app;
GRANT SELECT, INSERT, UPDATE ON privacy_requests TO clinica_app;
