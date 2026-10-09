-- 0031_platform_billing_support: cobrança dos clientes da plataforma (assinatura/inadimplência/limites) e acesso temporário do suporte.
-- Faturas da plataforma NÃO são financeiro da clínica: ficam no plano de controle, a clínica só lê as próprias.

-- Preço e limites por plano. NULL = sem preço / sem limite (nada muda para quem não configurar).
ALTER TABLE plans
  ADD COLUMN price_cents    int CHECK (price_cents IS NULL OR price_cents >= 0),
  ADD COLUMN max_users      int CHECK (max_users IS NULL OR max_users >= 1),
  ADD COLUMN max_patients   int CHECK (max_patients IS NULL OR max_patients >= 1),
  ADD COLUMN max_storage_mb int CHECK (max_storage_mb IS NULL OR max_storage_mb >= 1);

CREATE TABLE tenant_billing (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(id),
  price_override_cents int CHECK (price_override_cents IS NULL OR price_override_cents >= 0),
  due_day              smallint NOT NULL DEFAULT 10 CHECK (due_day BETWEEN 1 AND 28),
  grace_days           smallint NOT NULL DEFAULT 7 CHECK (grace_days BETWEEN 0 AND 60),
  suspended_by_billing boolean NOT NULL DEFAULT false,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_invoices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  period      date NOT NULL CHECK (period = date_trunc('month', period)::date),
  plan_code   text NOT NULL,
  amount_cents int NOT NULL CHECK (amount_cents > 0),
  due_date    date NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  paid_at     timestamptz,
  paid_method text CHECK (paid_method IN ('pix','boleto','card','transfer','other')),
  paid_reference text CHECK (paid_reference IS NULL OR length(paid_reference) <= 120),
  void_reason text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 3 AND 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL AND paid_method IS NOT NULL)),
  CHECK ((status = 'void') = (void_reason IS NOT NULL))
);
CREATE INDEX platform_invoices_open_idx ON platform_invoices (due_date) WHERE status = 'open';

-- Fatura: valores e vencimento nunca mudam; aberta → paga ou anulada, e aí é definitiva. Sem exclusão.
CREATE FUNCTION platform_invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'fatura não pode ser excluída: anule-a' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'fatura % é definitiva', OLD.status USING ERRCODE = 'insufficient_privilege'; END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.period, NEW.plan_code, NEW.amount_cents, NEW.due_date, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.period, OLD.plan_code, OLD.amount_cents, OLD.due_date, OLD.created_at) THEN
    RAISE EXCEPTION 'valores e vencimento da fatura são imutáveis' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_invoices_guard_trg BEFORE UPDATE OR DELETE ON platform_invoices FOR EACH ROW EXECUTE FUNCTION platform_invoices_guard();

-- Acesso temporário do suporte: a CLÍNICA libera (por até 24 h), o suporte só lê configuração e cadastro de equipe,
-- nunca dado de paciente. O banco impõe: sem concessão ativa, o papel da plataforma não enxerga nada da clínica.
CREATE TABLE support_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  granted_by  uuid NOT NULL,
  reason      text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  FOREIGN KEY (tenant_id, granted_by) REFERENCES users(tenant_id, id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours')
);
CREATE INDEX support_grants_active_idx ON support_grants (tenant_id, expires_at) WHERE revoked_at IS NULL;

CREATE FUNCTION support_grants_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'concessão de suporte não pode ser excluída: revogue-a' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- só "revoked_at" muda, uma vez (e nunca estende o prazo)
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR ROW(NEW.id, NEW.tenant_id, NEW.granted_by, NEW.reason, NEW.created_at, NEW.expires_at) IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.granted_by, OLD.reason, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'concessão de suporte só pode ser revogada' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER support_grants_guard_trg BEFORE UPDATE OR DELETE ON support_grants FOR EACH ROW EXECUTE FUNCTION support_grants_guard();

CREATE TABLE support_access_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  grant_id    uuid NOT NULL REFERENCES support_grants(id),
  operator_id text NOT NULL,
  resource    text NOT NULL CHECK (length(resource) <= 60),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_access_log_idx ON support_access_log (tenant_id, occurred_at DESC);
CREATE TRIGGER support_access_log_append_only BEFORE UPDATE OR DELETE ON support_access_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_billing','platform_invoices','support_grants','support_access_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_own_tenant_read ON %I FOR SELECT TO clinica_app USING (tenant_id = app_current_tenant())', t);
    EXECUTE format('CREATE POLICY platform_all ON %I FOR ALL TO clinica_platform USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
CREATE POLICY app_grant ON support_grants FOR INSERT TO clinica_app WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY app_revoke ON support_grants FOR UPDATE TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT ON tenant_billing, platform_invoices, support_grants, support_access_log TO clinica_app;
GRANT INSERT, UPDATE ON support_grants TO clinica_app;
GRANT SELECT, INSERT, UPDATE ON tenant_billing, platform_invoices TO clinica_platform;
GRANT SELECT ON support_grants TO clinica_platform;
GRANT SELECT, INSERT ON support_access_log TO clinica_platform;

-- O suporte enxerga equipe, unidades e a trilha de auditoria (sem metadados) SOMENTE durante uma concessão ativa.
-- SECURITY INVOKER de propósito: com FORCE RLS o dono da função não enxergaria support_grants; quem consulta é o papel da plataforma.
CREATE FUNCTION support_grant_active(t uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM support_grants WHERE tenant_id = t AND revoked_at IS NULL AND expires_at > now())
$$;
REVOKE ALL ON FUNCTION support_grant_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION support_grant_active(uuid) TO clinica_platform;
CREATE POLICY platform_support_read ON users FOR SELECT TO clinica_platform USING (support_grant_active(tenant_id));
CREATE POLICY platform_support_read ON units FOR SELECT TO clinica_platform USING (support_grant_active(tenant_id));
CREATE POLICY platform_support_read ON audit_events FOR SELECT TO clinica_platform USING (support_grant_active(tenant_id));
GRANT SELECT (id, tenant_id, name) ON units TO clinica_platform;
GRANT SELECT (id, tenant_id, occurred_at, actor_id, action, entity_type) ON audit_events TO clinica_platform;
