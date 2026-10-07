-- 0009_cash_desk: caixa (abertura/fechamento), descontos com aprovação e recibos numerados. Valores em centavos.
-- Recibo NÃO é documento fiscal (nota fiscal/NFS-e depende de integração externa, ainda não feita).

-- ---------------------------------------------------------------- Sessões de caixa
CREATE TABLE cash_sessions (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  opened_by        uuid NOT NULL,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  opening_cents    bigint NOT NULL CHECK (opening_cents >= 0),
  closed_by        uuid,
  closed_at        timestamptz,
  expected_cents   bigint,           -- abertura + dinheiro recebido − dinheiro devolvido
  counted_cents    bigint CHECK (counted_cents >= 0),
  difference_cents bigint,           -- contado − esperado (sobra/falta)
  close_note       text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, opened_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, closed_by) REFERENCES users(tenant_id, id),
  CHECK ((closed_at IS NULL) = (closed_by IS NULL)),
  CHECK ((closed_at IS NULL) = (counted_cents IS NULL)),
  CHECK ((closed_at IS NULL) = (expected_cents IS NULL)),
  CHECK ((closed_at IS NULL) = (difference_cents IS NULL)),
  CHECK (difference_cents IS NULL OR difference_cents = 0 OR length(btrim(coalesce(close_note, ''))) >= 3)
);
-- No máximo um caixa aberto por clínica (decidido pelo banco, vale sob concorrência).
CREATE UNIQUE INDEX cash_sessions_one_open ON cash_sessions (tenant_id) WHERE closed_at IS NULL;
CREATE INDEX cash_sessions_time_idx ON cash_sessions (tenant_id, opened_at DESC);

-- Só o fechamento (uma vez) altera a linha; caixa fechado e abertura ficam imutáveis; nada é apagado.
CREATE FUNCTION cash_sessions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cash_sessions é append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'caixa fechado é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.opened_by <> OLD.opened_by
     OR NEW.opened_at <> OLD.opened_at OR NEW.opening_cents <> OLD.opening_cents THEN
    RAISE EXCEPTION 'dados de abertura do caixa são imutáveis' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_sessions_guard_trg BEFORE UPDATE OR DELETE ON cash_sessions
  FOR EACH ROW EXECUTE FUNCTION cash_sessions_guard();

-- ---------------------------------------------------------------- Contador de recibos por clínica
CREATE TABLE receipt_counters (
  tenant_id  uuid PRIMARY KEY,
  last_number bigint NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------- Pedidos de desconto (com aprovação)
CREATE TABLE discount_requests (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  patient_id    uuid NOT NULL,
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  reason        text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by  uuid NOT NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid,
  decided_at    timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 300),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users(tenant_id, id),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'pending') = (decided_by IS NULL))
);
CREATE INDEX discount_requests_status_idx ON discount_requests (tenant_id, status, requested_at DESC);

-- Decisão acontece uma vez (pendente → aprovado/recusado); depois a linha não muda; nada é apagado.
CREATE FUNCTION discount_requests_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'discount_requests é append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'pedido de desconto já decidido é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.patient_id <> OLD.patient_id
     OR NEW.amount_cents <> OLD.amount_cents OR NEW.reason <> OLD.reason
     OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'dados do pedido de desconto são imutáveis' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER discount_requests_guard_trg BEFORE UPDATE OR DELETE ON discount_requests
  FOR EACH ROW EXECUTE FUNCTION discount_requests_guard();

-- ---------------------------------------------------------------- Movimentos: desconto, caixa e recibo
-- Remove as checagens antigas (kind/method) e recria incluindo 'discount'.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'financial_movements'::regclass AND contype = 'c' LOOP
    EXECUTE format('ALTER TABLE financial_movements DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE financial_movements
  ADD COLUMN cash_session_id     uuid,
  ADD COLUMN receipt_number      bigint,
  ADD COLUMN discount_request_id uuid;
ALTER TABLE financial_movements
  ADD CONSTRAINT financial_movements_kind_check CHECK (kind IN ('charge','payment','refund','discount')),
  ADD CONSTRAINT financial_movements_amount_check CHECK (amount_cents > 0),
  -- cobrança e desconto não têm forma de pagamento; pagamento e estorno têm.
  ADD CONSTRAINT financial_movements_method_check CHECK ((kind IN ('charge','discount')) = (method IS NULL)),
  ADD CONSTRAINT financial_movements_receipt_check CHECK (kind = 'payment' OR receipt_number IS NULL),
  -- desconto sempre nasce de um pedido aprovado.
  ADD CONSTRAINT financial_movements_discount_check CHECK ((kind = 'discount') = (discount_request_id IS NOT NULL)),
  ADD CONSTRAINT financial_movements_cash_fk FOREIGN KEY (tenant_id, cash_session_id) REFERENCES cash_sessions(tenant_id, id),
  ADD CONSTRAINT financial_movements_discount_fk FOREIGN KEY (tenant_id, discount_request_id) REFERENCES discount_requests(tenant_id, id),
  ADD CONSTRAINT financial_movements_receipt_unique UNIQUE (tenant_id, receipt_number),
  ADD CONSTRAINT financial_movements_discount_once UNIQUE (tenant_id, discount_request_id);
CREATE INDEX financial_movements_cash_idx ON financial_movements (tenant_id, cash_session_id) WHERE cash_session_id IS NOT NULL;

-- O banco recusa lançar em caixa fechado (mesmo por caminho que não passe pela API).
-- FOR SHARE espera um fechamento em andamento (que usa FOR UPDATE) e garante que o total do fechamento inclui tudo.
CREATE FUNCTION financial_movements_cash_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE closed timestamptz;
BEGIN
  IF NEW.cash_session_id IS NOT NULL THEN
    SELECT closed_at INTO closed FROM cash_sessions WHERE tenant_id = NEW.tenant_id AND id = NEW.cash_session_id FOR SHARE;
    IF closed IS NOT NULL THEN
      RAISE EXCEPTION 'caixa fechado não aceita lançamentos' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_movements_cash_open_trg BEFORE INSERT ON financial_movements
  FOR EACH ROW EXECUTE FUNCTION financial_movements_cash_open();

-- ---------------------------------------------------------------- RLS e privilégios
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cash_sessions','receipt_counters','discount_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_own_tenant ON %I FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON cash_sessions, receipt_counters, discount_requests TO clinica_app;
