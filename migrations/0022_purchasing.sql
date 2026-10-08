-- 0022_purchasing: fornecedores e pedidos de compra do estoque. Capability: inventory.core. Valores em centavos.
-- Pedido: rascunho → enviado → (parcial) → recebido; ou cancelado (sem nada recebido). A entrada no estoque acontece ao RECEBER:
-- cada recebimento é um movimento de entrada no livro (com custo, lote e validade), ligado à linha do pedido. Recebido nunca passa do pedido.

CREATE TABLE suppliers (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  phone       text CHECK (phone IS NULL OR length(phone) <= 30),
  email       text CHECK (email IS NULL OR length(email) <= 200),
  notes       text CHECK (notes IS NULL OR length(notes) <= 300),
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);
CREATE UNIQUE INDEX suppliers_name_idx ON suppliers (tenant_id, lower(btrim(name)));

CREATE TABLE purchase_order_counters (
  tenant_id   uuid PRIMARY KEY,
  last_number bigint NOT NULL DEFAULT 0
);

CREATE TABLE purchase_orders (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  number        bigint NOT NULL,
  supplier_id   uuid NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','partial','received','canceled')),
  expected_on   date,
  note          text CHECK (note IS NULL OR length(note) <= 300),
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 200),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  finished_at   timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  CHECK ((status IN ('received','canceled')) = (finished_at IS NOT NULL)),
  CHECK ((status = 'canceled') = (cancel_reason IS NOT NULL)),
  CHECK (status IN ('draft','canceled') OR sent_at IS NOT NULL)
);
CREATE INDEX purchase_orders_status_idx ON purchase_orders (tenant_id, status, created_at DESC);

CREATE TABLE purchase_order_lines (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  order_id         uuid NOT NULL,
  item_id          uuid NOT NULL,
  quantity         numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_cost_cents  bigint NOT NULL CHECK (unit_cost_cents >= 0),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES purchase_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES inventory_items(tenant_id, id),
  UNIQUE (tenant_id, order_id, item_id)
);

ALTER TABLE inventory_movements ADD COLUMN purchase_line_id uuid;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_po_line_fk FOREIGN KEY (tenant_id, purchase_line_id) REFERENCES purchase_order_lines(tenant_id, id);
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_po_line_in CHECK (purchase_line_id IS NULL OR kind = 'in');
CREATE INDEX inventory_movements_po_idx ON inventory_movements (tenant_id, purchase_line_id) WHERE purchase_line_id IS NOT NULL;

-- Pedido: transições controladas; terminal é imutável; nada é excluído.
CREATE FUNCTION purchase_orders_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pedido de compra não pode ser excluído: cancele-o' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.number <> OLD.number OR NEW.supplier_id <> OLD.supplier_id
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'identificação do pedido é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('received','canceled') THEN
    RAISE EXCEPTION 'pedido % é definitivo', OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft'   AND NEW.status IN ('sent','canceled')) OR
       (OLD.status = 'sent'    AND NEW.status IN ('partial','received','canceled')) OR
       (OLD.status = 'partial' AND NEW.status IN ('received'))) THEN
    RAISE EXCEPTION 'transição de pedido inválida: % → %', OLD.status, NEW.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.supplier_id <> OLD.supplier_id OR NEW.expected_on IS DISTINCT FROM OLD.expected_on OR NEW.note IS DISTINCT FROM OLD.note) THEN
    RAISE EXCEPTION 'pedido enviado não pode ser editado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_orders_guard_trg BEFORE UPDATE OR DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION purchase_orders_guard();

-- Linhas só mudam enquanto o pedido é rascunho.
CREATE FUNCTION purchase_order_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE st text; oid uuid; tid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN oid := OLD.order_id; tid := OLD.tenant_id; ELSE oid := NEW.order_id; tid := NEW.tenant_id; END IF;
  SELECT status INTO st FROM purchase_orders WHERE tenant_id = tid AND id = oid FOR SHARE;
  IF st IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'itens de pedido enviado são imutáveis' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_order_lines_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines FOR EACH ROW EXECUTE FUNCTION purchase_order_lines_guard();

-- Entrada ligada ao pedido: só com pedido enviado/parcial, item igual ao da linha e nunca acima do pedido (vale sob concorrência).
CREATE FUNCTION inventory_movements_po_cap() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE l record; st text; received numeric;
BEGIN
  IF NEW.purchase_line_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO l FROM purchase_order_lines WHERE tenant_id = NEW.tenant_id AND id = NEW.purchase_line_id FOR UPDATE;
  IF l.item_id <> NEW.item_id THEN
    RAISE EXCEPTION 'o item não corresponde à linha do pedido' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status INTO st FROM purchase_orders WHERE tenant_id = NEW.tenant_id AND id = l.order_id;
  IF st NOT IN ('sent','partial') THEN
    RAISE EXCEPTION 'pedido não está aguardando recebimento' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(SUM(delta), 0) INTO received FROM inventory_movements WHERE tenant_id = NEW.tenant_id AND purchase_line_id = NEW.purchase_line_id;
  IF received + NEW.delta > l.quantity THEN
    RAISE EXCEPTION 'recebimento acima da quantidade pedida' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_movements_po_cap_trg BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION inventory_movements_po_cap();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers','purchase_order_counters','purchase_orders','purchase_order_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_own_tenant ON %I FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON suppliers, purchase_order_counters, purchase_orders TO clinica_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_order_lines TO clinica_app;
