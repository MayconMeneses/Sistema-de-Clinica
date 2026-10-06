-- 0005_dental: odontograma com histórico imutável e plano de tratamento. Capability: dental.odontogram.

-- Cada registro é um EVENTO (append-only). O estado atual é derivado do último evento por dente/face.
CREATE TABLE dental_findings (
  seq          bigint GENERATED ALWAYS AS IDENTITY,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  patient_id   uuid NOT NULL,
  tooth        text NOT NULL CHECK (tooth ~ '^(1[1-8]|2[1-8]|3[1-8]|4[1-8]|5[1-5]|6[1-5]|7[1-5]|8[1-5])$'),  -- FDI: permanente e decídua
  surface      text CHECK (surface IN ('M','D','O','V','L')),       -- mesial, distal, oclusal, vestibular, lingual; NULL = dente inteiro
  condition    text NOT NULL CHECK (condition IN
                 ('healthy','caries','restoration','sealant','fracture','missing','crown','endodontic','implant','extraction_planned')),
  note         text CHECK (length(note) <= 500),
  recorded_by  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES users(tenant_id, id),
  CHECK (surface IS NULL OR condition IN ('healthy','caries','restoration','sealant','fracture'))
);
CREATE INDEX dental_findings_patient_idx ON dental_findings (tenant_id, patient_id, tooth, seq DESC);
CREATE TRIGGER dental_findings_append_only BEFORE UPDATE OR DELETE ON dental_findings
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE dental_plan_items (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  patient_id    uuid NOT NULL,
  tooth         text CHECK (tooth ~ '^(1[1-8]|2[1-8]|3[1-8]|4[1-8]|5[1-5]|6[1-5]|7[1-5]|8[1-5])$'),
  procedure     text NOT NULL CHECK (length(btrim(procedure)) BETWEEN 2 AND 160),
  price_cents   bigint NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  priority      smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  status        text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','done','cancelled')),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  CHECK ((status = 'done') = (completed_at IS NOT NULL))
);
CREATE INDEX dental_plan_patient_idx ON dental_plan_items (tenant_id, patient_id, created_at);

-- Item concluído ou cancelado é definitivo; nada é excluído.
CREATE FUNCTION dental_plan_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'item do plano não pode ser excluído' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('done','cancelled') THEN
    RAISE EXCEPTION 'item do plano finalizado é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.patient_id <> OLD.patient_id OR NEW.procedure <> OLD.procedure OR NEW.price_cents <> OLD.price_cents
     OR NEW.tooth IS DISTINCT FROM OLD.tooth THEN
    RAISE EXCEPTION 'procedimento, dente e valor não mudam; cancele e crie outro item' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dental_plan_guard_trg BEFORE UPDATE OR DELETE ON dental_plan_items
  FOR EACH ROW EXECUTE FUNCTION dental_plan_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dental_findings','dental_plan_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_own_tenant ON %I FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON dental_findings TO clinica_app;
GRANT SELECT, INSERT, UPDATE ON dental_plan_items TO clinica_app;
