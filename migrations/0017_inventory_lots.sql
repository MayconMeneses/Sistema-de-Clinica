-- 0017_inventory_lots: lotes e validade no estoque. Capability: inventory.core.
-- Lote = código + validade de um item. Entradas podem informar o lote; saídas consomem primeiro o que vence antes (FEFO) e nunca de lote vencido.
-- O saldo por lote nunca fica negativo (decidido pelo banco). Lotes são imutáveis.

CREATE TABLE inventory_lots (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  item_id     uuid NOT NULL,
  code        text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 40),
  expires_on  date,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES inventory_items(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  UNIQUE (tenant_id, item_id, code)
);
CREATE TRIGGER inventory_lots_append_only BEFORE UPDATE OR DELETE ON inventory_lots
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE inventory_movements ADD COLUMN lot_id uuid;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_lot_fk FOREIGN KEY (tenant_id, lot_id) REFERENCES inventory_lots(tenant_id, id);
CREATE INDEX inventory_movements_lot_idx ON inventory_movements (tenant_id, lot_id) WHERE lot_id IS NOT NULL;

-- Mesma regra de antes (saldo do item nunca negativo) + o lote pertence ao item e o saldo do lote nunca fica negativo.
CREATE OR REPLACE FUNCTION inventory_movements_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE bal numeric; lotbal numeric;
BEGIN
  PERFORM 1 FROM inventory_items WHERE tenant_id = NEW.tenant_id AND id = NEW.item_id FOR UPDATE;
  SELECT COALESCE(SUM(delta), 0) INTO bal FROM inventory_movements WHERE tenant_id = NEW.tenant_id AND item_id = NEW.item_id;
  IF bal + NEW.delta < 0 THEN
    RAISE EXCEPTION 'saldo insuficiente em estoque' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lot_id IS NOT NULL THEN
    PERFORM 1 FROM inventory_lots WHERE tenant_id = NEW.tenant_id AND id = NEW.lot_id AND item_id = NEW.item_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'o lote não pertence a este item' USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(SUM(delta), 0) INTO lotbal FROM inventory_movements WHERE tenant_id = NEW.tenant_id AND lot_id = NEW.lot_id;
    IF lotbal + NEW.delta < 0 THEN
      RAISE EXCEPTION 'saldo insuficiente no lote' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE inventory_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_lots FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own_tenant ON inventory_lots FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT ON inventory_lots TO clinica_app;
