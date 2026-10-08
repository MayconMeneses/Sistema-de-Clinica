-- 0025_procedure_supplies: consumo de estoque ligado ao procedimento. Capability: inventory.core.
-- Kit = materiais que um procedimento usa (chave = nome do procedimento sem caixa/acentos de borda). Ao concluir o item do plano
-- odontológico, o sistema dá baixa dos materiais pelo critério FEFO. Falta de saldo NÃO impede concluir o procedimento: fica
-- registrada como pendência (shortage) para o estoque tratar. Cada (item do plano, material) é baixado no máximo uma vez.

CREATE TABLE procedure_supplies (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  procedure_key text NOT NULL CHECK (length(procedure_key) BETWEEN 2 AND 160 AND procedure_key = lower(btrim(procedure_key))),
  item_id     uuid NOT NULL,
  quantity    numeric(12,3) NOT NULL CHECK (quantity > 0 AND quantity <= 1000000),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, procedure_key, item_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES inventory_items(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE procedure_consumptions (
  tenant_id    uuid NOT NULL,
  plan_item_id uuid NOT NULL,
  item_id      uuid NOT NULL,
  quantity     numeric(12,3) NOT NULL CHECK (quantity > 0),
  status       text NOT NULL CHECK (status IN ('consumed','shortage','resolved')),
  note         text CHECK (note IS NULL OR length(note) <= 300),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_by  uuid,
  resolved_at  timestamptz,
  PRIMARY KEY (tenant_id, plan_item_id, item_id),
  FOREIGN KEY (tenant_id, plan_item_id) REFERENCES dental_plan_items(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES inventory_items(tenant_id, id),
  FOREIGN KEY (tenant_id, resolved_by) REFERENCES users(tenant_id, id),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE INDEX procedure_consumptions_open_idx ON procedure_consumptions (tenant_id, created_at) WHERE status = 'shortage';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['procedure_supplies','procedure_consumptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_own_tenant ON %I FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON procedure_supplies TO clinica_app;
GRANT SELECT, INSERT, UPDATE ON procedure_consumptions TO clinica_app;
