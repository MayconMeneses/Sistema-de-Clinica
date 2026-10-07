-- 0010_dental_quotes: orçamento odontológico com versões e aceite. Capability: dental.odontogram.
-- O aceite é REGISTRADO PELA CLÍNICA (quem aceitou, em que condição, quando). Não é assinatura eletrônica
-- (assinatura com validade jurídica depende de provedor externo, ainda não integrado).

CREATE TABLE dental_quotes (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  patient_id       uuid NOT NULL,
  group_id         uuid NOT NULL,                -- todas as versões de um mesmo orçamento compartilham o group_id
  version          int  NOT NULL CHECK (version >= 1),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','presented','accepted','rejected','superseded')),
  notes            text CHECK (notes IS NULL OR length(notes) <= 500),
  valid_until      date,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  presented_by     uuid,
  presented_at     timestamptz,
  decided_by       uuid,                         -- quem da clínica registrou o aceite ou a recusa
  decided_at       timestamptz,
  accepted_by_name text CHECK (accepted_by_name IS NULL OR length(btrim(accepted_by_name)) BETWEEN 2 AND 120),
  accepted_by_role text CHECK (accepted_by_role IN ('patient','guardian')),
  decision_note    text CHECK (decision_note IS NULL OR length(decision_note) <= 300),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, presented_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users(tenant_id, id),
  UNIQUE (tenant_id, group_id, version),
  CHECK ((status = 'draft') = (presented_at IS NULL)),
  CHECK ((status IN ('accepted','rejected')) = (decided_at IS NOT NULL)),
  CHECK ((status = 'accepted') = (accepted_by_name IS NOT NULL)),
  CHECK ((status = 'accepted') = (accepted_by_role IS NOT NULL))
);
-- Por orçamento: no máximo um rascunho e uma versão apresentada ao mesmo tempo.
CREATE UNIQUE INDEX dental_quotes_one_draft ON dental_quotes (tenant_id, group_id) WHERE status = 'draft';
CREATE UNIQUE INDEX dental_quotes_one_presented ON dental_quotes (tenant_id, group_id) WHERE status = 'presented';
CREATE INDEX dental_quotes_patient_idx ON dental_quotes (tenant_id, patient_id, created_at DESC);

CREATE TABLE dental_quote_items (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  quote_id     uuid NOT NULL,
  position     smallint NOT NULL CHECK (position >= 0),
  tooth        text CHECK (tooth ~ '^(1[1-8]|2[1-8]|3[1-8]|4[1-8]|5[1-5]|6[1-5]|7[1-5]|8[1-5])$'),
  procedure    text NOT NULL CHECK (length(btrim(procedure)) BETWEEN 2 AND 160),
  price_cents  bigint NOT NULL CHECK (price_cents >= 0),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES dental_quotes(tenant_id, id),
  UNIQUE (tenant_id, quote_id, position)
);

-- Itens do plano gerados pelo aceite ficam ligados ao item do orçamento (um item do orçamento gera um item do plano, uma vez).
ALTER TABLE dental_plan_items ADD COLUMN quote_item_id uuid;
ALTER TABLE dental_plan_items ADD CONSTRAINT dental_plan_quote_item_fk
  FOREIGN KEY (tenant_id, quote_item_id) REFERENCES dental_quote_items(tenant_id, id);
ALTER TABLE dental_plan_items ADD CONSTRAINT dental_plan_quote_item_once UNIQUE (tenant_id, quote_item_id);

-- ---------------------------------------------------------------- Regras no banco
-- Transições: draft → presented; presented → accepted | rejected | superseded. Todo o resto é terminal e imutável.
CREATE FUNCTION dental_quotes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'orçamento não pode ser excluído' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.patient_id <> OLD.patient_id
     OR NEW.group_id <> OLD.group_id OR NEW.version <> OLD.version
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'identificação do orçamento é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft','presented') THEN
      RAISE EXCEPTION 'rascunho só pode ser apresentado' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;  -- notas e validade ainda podem mudar no rascunho
  END IF;
  -- a partir daqui o conteúdo está congelado
  IF NEW.notes IS DISTINCT FROM OLD.notes OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
     OR NEW.presented_by IS DISTINCT FROM OLD.presented_by OR NEW.presented_at IS DISTINCT FROM OLD.presented_at THEN
    RAISE EXCEPTION 'orçamento apresentado é imutável: crie uma nova versão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'presented' AND NEW.status IN ('accepted','rejected','superseded') THEN
    IF NEW.status = 'superseded' AND (NEW.decided_at IS NOT NULL OR NEW.accepted_by_name IS NOT NULL) THEN
      RAISE EXCEPTION 'versão substituída não registra decisão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = OLD.status AND ROW(NEW.decided_by, NEW.decided_at, NEW.accepted_by_name, NEW.accepted_by_role, NEW.decision_note)
       IS NOT DISTINCT FROM ROW(OLD.decided_by, OLD.decided_at, OLD.accepted_by_name, OLD.accepted_by_role, OLD.decision_note) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'orçamento % é definitivo', OLD.status USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER dental_quotes_guard_trg BEFORE UPDATE OR DELETE ON dental_quotes
  FOR EACH ROW EXECUTE FUNCTION dental_quotes_guard();

-- Itens só mudam enquanto o orçamento é rascunho (FOR SHARE espera uma apresentação em andamento).
CREATE FUNCTION dental_quote_items_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE st text; qid uuid; tid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN qid := OLD.quote_id; tid := OLD.tenant_id; ELSE qid := NEW.quote_id; tid := NEW.tenant_id; END IF;
  SELECT status INTO st FROM dental_quotes WHERE tenant_id = tid AND id = qid FOR SHARE;
  IF st IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'itens de orçamento apresentado são imutáveis: crie uma nova versão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dental_quote_items_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON dental_quote_items
  FOR EACH ROW EXECUTE FUNCTION dental_quote_items_guard();

-- ---------------------------------------------------------------- RLS e privilégios
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dental_quotes','dental_quote_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_own_tenant ON %I FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON dental_quotes TO clinica_app;
GRANT SELECT, INSERT, DELETE ON dental_quote_items TO clinica_app;
