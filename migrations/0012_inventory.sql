-- 0012_inventory: estoque. Capability: inventory.core.
-- O saldo é DERIVADO de um livro de movimentos imutável (entrada, saída, ajuste). Nada é editado nem apagado.

CREATE TABLE inventory_items (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  sku           text CHECK (sku IS NULL OR length(btrim(sku)) BETWEEN 1 AND 40),
  unit          text NOT NULL DEFAULT 'un' CHECK (length(btrim(unit)) BETWEEN 1 AND 10),
  min_quantity  numeric(12,3) NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  UNIQUE (tenant_id, sku)
);

CREATE TABLE inventory_movements (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  item_id          uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('in','out','adjust')),
  delta            numeric(12,3) NOT NULL CHECK (delta <> 0),   -- entrada > 0, saída < 0, ajuste ±
  unit_cost_cents  bigint CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  reason           text CHECK (reason IS NULL OR length(reason) <= 200),
  idempotency_key  text,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES inventory_items(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK ((kind = 'in' AND delta > 0) OR (kind = 'out' AND delta < 0) OR kind = 'adjust'),
  CHECK (kind <> 'adjust' OR length(btrim(coalesce(reason, ''))) >= 3),   -- ajuste sempre explicado
  CHECK (kind = 'in' OR unit_cost_cents IS NULL)
);
CREATE INDEX inventory_movements_item_idx ON inventory_movements (tenant_id, item_id, created_at DESC);
CREATE TRIGGER inventory_movements_append_only BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- O saldo nunca fica negativo, nem sob concorrência: o item é travado e o saldo recalculado antes de gravar.
CREATE FUNCTION inventory_movements_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE bal numeric;
BEGIN
  PERFORM 1 FROM inventory_items WHERE tenant_id = NEW.tenant_id AND id = NEW.item_id FOR UPDATE;
  SELECT COALESCE(SUM(delta), 0) INTO bal FROM inventory_movements WHERE tenant_id = NEW.tenant_id AND item_id = NEW.item_id;
  IF bal + NEW.delta < 0 THEN
    RAISE EXCEPTION 'saldo insuficiente em estoque' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_movements_balance_trg BEFORE INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION inventory_movements_balance();

-- A unidade de medida não muda depois de criada (o saldo perderia o sentido); itens não são excluídos, apenas inativados.
CREATE FUNCTION inventory_items_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'item de estoque não pode ser excluído: inative-o' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.unit <> OLD.unit OR NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'unidade de medida do item não pode mudar' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_items_guard_trg BEFORE UPDATE OR DELETE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION inventory_items_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_items','inventory_movements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_own_tenant ON %I FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON inventory_items TO clinica_app;
GRANT SELECT, INSERT ON inventory_movements TO clinica_app;
