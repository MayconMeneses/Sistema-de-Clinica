-- 0029_clinical_images: imagens e radiografias do paciente (categorias xray e photo) sobre a tabela de documentos.
-- Acréscimos: dente (FDI) e data do exame (opcionais) e uma MINIATURA pequena (JPEG gerada no navegador) para a galeria carregar leve.
-- Nada muda para os documentos que já existem: o conteúdo continua imutável e só se arquiva com motivo.

ALTER TABLE patient_documents DROP CONSTRAINT patient_documents_category_check;
ALTER TABLE patient_documents ADD CONSTRAINT patient_documents_category_check CHECK (category IN ('exam','report','consent','identity','other','xray','photo'));
ALTER TABLE patient_documents
  ADD COLUMN tooth      text CHECK (tooth IS NULL OR tooth ~ '^(1[1-8]|2[1-8]|3[1-8]|4[1-8]|5[1-5]|6[1-5]|7[1-5]|8[1-5])$'),
  ADD COLUMN taken_on   date,
  ADD COLUMN thumbnail  bytea CHECK (thumbnail IS NULL OR octet_length(thumbnail) <= 81920);
ALTER TABLE patient_documents ADD CONSTRAINT patient_documents_image_only CHECK (category NOT IN ('xray','photo') OR mime_type IN ('image/png','image/jpeg','image/webp'));
CREATE INDEX patient_documents_images_idx ON patient_documents (tenant_id, patient_id, tooth, taken_on DESC NULLS LAST) WHERE category IN ('xray','photo');

CREATE OR REPLACE FUNCTION patient_documents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'documento não pode ser excluído: arquive-o com motivo' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'documento arquivado é definitivo' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.patient_id, NEW.title, NEW.category, NEW.file_name, NEW.mime_type, NEW.size_bytes, NEW.sha256, NEW.content, NEW.created_by, NEW.created_at, NEW.tooth, NEW.taken_on, NEW.thumbnail)
     IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.patient_id, OLD.title, OLD.category, OLD.file_name, OLD.mime_type, OLD.size_bytes, OLD.sha256, OLD.content, OLD.created_by, OLD.created_at, OLD.tooth, OLD.taken_on, OLD.thumbnail) THEN
    RAISE EXCEPTION 'o conteúdo do documento é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
