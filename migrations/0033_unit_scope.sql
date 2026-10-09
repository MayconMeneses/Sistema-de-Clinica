-- 0033_unit_scope: estoque e leads passam a ter unidade (opcional). NULL = central / sem unidade (comportamento anterior).
-- O gerente de unidade enxerga os da sua unidade; o estoque central ele só consulta. Quem não tem escopo continua vendo tudo.
ALTER TABLE inventory_items ADD COLUMN unit_id uuid;
ALTER TABLE inventory_items ADD FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id);
CREATE INDEX inventory_items_unit_idx ON inventory_items (tenant_id, unit_id);

ALTER TABLE crm_leads ADD COLUMN unit_id uuid;
ALTER TABLE crm_leads ADD FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id);
CREATE INDEX crm_leads_unit_idx ON crm_leads (tenant_id, unit_id);
