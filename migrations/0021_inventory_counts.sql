-- 0021_inventory_counts: inventário de estoque por contagem. Capability: inventory.core.
-- Uma contagem registra, por item, o saldo no instante da contagem e a quantidade contada. Ao concluir, a diferença vira
-- movimentos de AJUSTE no livro (imutável) com o motivo "Inventário". Movimentos feitos depois da contagem são preservados.

CREATE TABLE inventory_counts (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  title        text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 120),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','canceled')),
  note         text CHECK (note IS NULL OR length(note) <= 300),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_by  uuid,
  finished_at  timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, finished_by) REFERENCES users(tenant_id, id),
  CHECK ((status = 'open') = (finished_at IS NULL))
);
-- No máximo uma contagem aberta por clínica.
CREATE UNIQUE INDEX inventory_counts_one_open ON inventory_counts (tenant_id) WHERE status = 'open';

CREATE TABLE inventory_count_lines (
  tenant_id         uuid NOT NULL,
  count_id          uuid NOT NULL,
  item_id           uuid NOT NULL,
  counted           numeric(12,3) CHECK (counted IS NULL OR counted >= 0),
  balance_at_count  numeric(12,3),
  counted_by        uuid,
  counted_at        timestamptz,
  PRIMARY KEY (tenant_id, count_id, item_id),
  FOREIGN KEY (tenant_id, count_id) REFERENCES inventory_counts(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES inventory_items(tenant_id, id),
  FOREIGN KEY (tenant_id, counted_by) REFERENCES users(tenant_id, id),
  CHECK ((counted IS NULL) = (balance_at_count IS NULL))
);

-- Contagem concluída ou cancelada é definitiva; nada é excluído. Linhas só mudam enquanto a contagem está aberta.
CREATE FUNCTION inventory_counts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventário não pode ser excluído: cancele-o' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'inventário % é definitivo', OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'identificação do inventário é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_counts_guard_trg BEFORE UPDATE OR DELETE ON inventory_counts FOR EACH ROW EXECUTE FUNCTION inventory_counts_guard();

CREATE FUNCTION inventory_count_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE st text; cid uuid; tid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN cid := OLD.count_id; tid := OLD.tenant_id; ELSE cid := NEW.count_id; tid := NEW.tenant_id; END IF;
  SELECT status INTO st FROM inventory_counts WHERE tenant_id = tid AND id = cid FOR SHARE;
  IF st IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'inventário encerrado não aceita alterações' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_count_lines_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON inventory_count_lines FOR EACH ROW EXECUTE FUNCTION inventory_count_lines_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_counts','inventory_count_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_own_tenant ON %I FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON inventory_counts, inventory_count_lines TO clinica_app;
