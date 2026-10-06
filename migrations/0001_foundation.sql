-- 0001_foundation: catálogo da plataforma, tenants, RLS, auditoria append-only.
-- Executada como clinica_owner. Ver docs/adr/0002-multi-tenancy.md.
-- Rollback: roll-forward apenas (ver docs/adr/0002). Banco vazio em dev: recriar.

-- ---------------------------------------------------------------------------
-- Contexto de tenant confiável: definido pelo servidor com set_config(..., true)
-- dentro da transação. Ausente/vazio => NULL => nenhuma linha visível (deny).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- CONTROL PLANE — catálogo (leitura para o runtime, escrita só plataforma)
-- ---------------------------------------------------------------------------
CREATE TABLE plans (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  sort_order  int  NOT NULL
);

CREATE TABLE capabilities (
  code                text PRIMARY KEY,
  description         text NOT NULL,
  globally_available  boolean NOT NULL DEFAULT true,
  depends_on          text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE plan_capabilities (
  plan_code        text NOT NULL REFERENCES plans(code),
  capability_code  text NOT NULL REFERENCES capabilities(code),
  PRIMARY KEY (plan_code, capability_code)
);

-- Capability globalmente indisponível jamais entra em plano nem override.
CREATE FUNCTION reject_unavailable_capability() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE available boolean;
BEGIN
  IF TG_TABLE_NAME = 'tenant_entitlement_overrides' THEN
    IF NEW.mode <> 'grant' THEN
      RETURN NEW; -- bloquear algo indisponível é inofensivo
    END IF;
  END IF;
  SELECT globally_available INTO available FROM capabilities WHERE code = NEW.capability_code;
  IF available IS NOT TRUE THEN
    RAISE EXCEPTION 'capability % está globalmente indisponível', NEW.capability_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER plan_capabilities_available
  BEFORE INSERT OR UPDATE ON plan_capabilities
  FOR EACH ROW EXECUTE FUNCTION reject_unavailable_capability();

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'provisioning'
              CHECK (status IN ('provisioning','active','suspended','closed')),
  plan_code   text NOT NULL REFERENCES plans(code),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_entitlement_overrides (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  capability_code  text NOT NULL REFERENCES capabilities(code),
  mode             text NOT NULL CHECK (mode IN ('grant','block')),
  reason           text NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, capability_code)
);

CREATE TRIGGER overrides_available
  BEFORE INSERT OR UPDATE ON tenant_entitlement_overrides
  FOR EACH ROW EXECUTE FUNCTION reject_unavailable_capability();

-- ---------------------------------------------------------------------------
-- DATA PLANE — tabelas tenant-aware (chaves compostas para FKs seguras)
-- ---------------------------------------------------------------------------
CREATE TABLE units (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'America/Sao_Paulo',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE resources (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  unit_id     uuid NOT NULL,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('room','chair','equipment')),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id)
);

-- Auditoria do tenant: append-only, imposta por trigger (vale até para o owner).
CREATE TABLE audit_events (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  metadata     jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, id)
);

-- Auditoria da plataforma (control plane).
CREATE TABLE platform_audit_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  operator_id  text NOT NULL,
  action       text NOT NULL,
  tenant_id    uuid,
  justification text NOT NULL CHECK (length(btrim(justification)) > 0),
  metadata     jsonb NOT NULL DEFAULT '{}'
);

CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% é append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER platform_audit_append_only
  BEFORE UPDATE OR DELETE ON platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER platform_audit_no_truncate
  BEFORE TRUNCATE ON platform_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- RLS — FORCE inclusive para o owner das tabelas. Nenhum papel usa BYPASSRLS.
-- clinica_app: só o tenant do contexto. clinica_platform: políticas explícitas.
-- ---------------------------------------------------------------------------
ALTER TABLE tenants                      ENABLE ROW LEVEL SECURITY; ALTER TABLE tenants                      FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_entitlement_overrides ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant_entitlement_overrides FORCE ROW LEVEL SECURITY;
ALTER TABLE units                        ENABLE ROW LEVEL SECURITY; ALTER TABLE units                        FORCE ROW LEVEL SECURITY;
ALTER TABLE resources                    ENABLE ROW LEVEL SECURITY; ALTER TABLE resources                    FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events                 ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_events                 FORCE ROW LEVEL SECURITY;

CREATE POLICY app_own_tenant ON tenants FOR SELECT TO clinica_app
  USING (id = app_current_tenant());
CREATE POLICY platform_all ON tenants FOR ALL TO clinica_platform
  USING (true) WITH CHECK (true);

CREATE POLICY app_own_tenant ON tenant_entitlement_overrides FOR SELECT TO clinica_app
  USING (tenant_id = app_current_tenant());
CREATE POLICY platform_all ON tenant_entitlement_overrides FOR ALL TO clinica_platform
  USING (true) WITH CHECK (true);

CREATE POLICY app_own_tenant ON units FOR ALL TO clinica_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY app_own_tenant ON resources FOR ALL TO clinica_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY app_own_tenant_read ON audit_events FOR SELECT TO clinica_app
  USING (tenant_id = app_current_tenant());
CREATE POLICY app_own_tenant_insert ON audit_events FOR INSERT TO clinica_app
  WITH CHECK (tenant_id = app_current_tenant());

-- ---------------------------------------------------------------------------
-- GRANTS mínimos (least privilege)
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION app_current_tenant() TO clinica_app, clinica_platform;

GRANT SELECT ON plans, capabilities, plan_capabilities TO clinica_app, clinica_platform;
GRANT INSERT, UPDATE ON plans, capabilities, plan_capabilities TO clinica_platform;
GRANT DELETE ON plan_capabilities TO clinica_platform;

GRANT SELECT ON tenants, tenant_entitlement_overrides TO clinica_app;
GRANT SELECT, INSERT, UPDATE ON tenants TO clinica_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_entitlement_overrides TO clinica_platform;

GRANT SELECT, INSERT, UPDATE, DELETE ON units, resources TO clinica_app;
GRANT SELECT, INSERT ON audit_events TO clinica_app;
GRANT SELECT, INSERT ON platform_audit_events TO clinica_platform;
