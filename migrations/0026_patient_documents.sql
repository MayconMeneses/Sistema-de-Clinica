-- 0026_patient_documents: anexos e documentos do paciente (exames, laudos, termos, documentos). Capability: clinical.record.
-- O conteúdo fica no banco (bytea, até 5 MB) sob a mesma RLS do paciente. Nada é excluído nem alterado: o documento só pode ser
-- ARQUIVADO com motivo (some da lista, continua guardado). Integridade conferida por SHA-256 a cada download.

CREATE TABLE patient_documents (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  patient_id     uuid NOT NULL,
  title          text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 120),
  category       text NOT NULL CHECK (category IN ('exam','report','consent','identity','other')),
  file_name      text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 160),
  mime_type      text NOT NULL CHECK (mime_type IN ('application/pdf','image/png','image/jpeg','image/webp')),
  size_bytes     integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content        bytea NOT NULL,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  archived_by    uuid,
  archived_at    timestamptz,
  archive_reason text CHECK (archive_reason IS NULL OR length(btrim(archive_reason)) BETWEEN 3 AND 200),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, archived_by) REFERENCES users(tenant_id, id),
  CHECK (octet_length(content) = size_bytes),
  CHECK ((archived_at IS NULL) = (archive_reason IS NULL) AND (archived_at IS NULL) = (archived_by IS NULL))
);
CREATE INDEX patient_documents_patient_idx ON patient_documents (tenant_id, patient_id, created_at DESC);

CREATE FUNCTION patient_documents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'documento não pode ser excluído: arquive-o com motivo' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'documento arquivado é definitivo' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.patient_id, NEW.title, NEW.category, NEW.file_name, NEW.mime_type, NEW.size_bytes, NEW.sha256, NEW.content, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.patient_id, OLD.title, OLD.category, OLD.file_name, OLD.mime_type, OLD.size_bytes, OLD.sha256, OLD.content, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'o conteúdo do documento é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_documents_guard_trg BEFORE UPDATE OR DELETE ON patient_documents FOR EACH ROW EXECUTE FUNCTION patient_documents_guard();

ALTER TABLE patient_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own_tenant ON patient_documents FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON patient_documents TO clinica_app;
