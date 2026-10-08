-- 0020_user_units: vínculo de usuários com unidades (escopo por unidade do gerente).
-- Gerente de unidade (unit_manager) só enxerga e altera a agenda das unidades a que está vinculado.
-- Profissionais também são vinculados a unidades: uma consulta SEM sala pertence às unidades do profissional.
CREATE TABLE user_units (
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  unit_id     uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, unit_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id)
);
CREATE INDEX user_units_unit_idx ON user_units (tenant_id, unit_id);

ALTER TABLE user_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_units FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own_tenant ON user_units FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, DELETE ON user_units TO clinica_app;
