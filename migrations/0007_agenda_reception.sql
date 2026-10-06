-- 0007_agenda_reception: salas na agenda, horários de atendimento, bloqueios, lista de espera, séries e fila da recepção.

-- ---------------------------------------------------------------- Consulta: sala, série, fila
ALTER TABLE appointments DROP CONSTRAINT appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check CHECK (status IN
  ('scheduled','confirmed','checked_in','called','in_service','completed','cancelled','no_show'));
ALTER TABLE appointments
  ADD COLUMN resource_id    uuid,
  ADD COLUMN series_id      uuid,
  ADD COLUMN priority       text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','priority')),
  ADD COLUMN outside_hours  boolean NOT NULL DEFAULT false,   -- encaixe fora do horário de atendimento
  ADD COLUMN checked_in_at  timestamptz,
  ADD COLUMN called_at      timestamptz,
  ADD COLUMN started_at     timestamptz,
  ADD COLUMN completed_at   timestamptz;
ALTER TABLE appointments ADD CONSTRAINT appointments_resource_fk
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id);
-- Uma sala/cadeira/equipamento não atende duas consultas ao mesmo tempo (decidido pelo banco, vale sob concorrência).
ALTER TABLE appointments ADD CONSTRAINT appointments_no_resource_overlap EXCLUDE USING gist
  (tenant_id WITH =, resource_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
  WHERE (resource_id IS NOT NULL AND status NOT IN ('cancelled','no_show'));
CREATE INDEX appointments_series_idx ON appointments (tenant_id, series_id) WHERE series_id IS NOT NULL;

-- ---------------------------------------------------------------- Horário de atendimento (por profissional, dia da semana)
CREATE TABLE availability_rules (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  professional_id  uuid NOT NULL,
  weekday          smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),     -- 0 = domingo
  start_min        smallint NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min          smallint NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, professional_id) REFERENCES users(tenant_id, id),
  CHECK (end_min > start_min),
  CONSTRAINT availability_no_overlap EXCLUDE USING gist
    (tenant_id WITH =, professional_id WITH =, weekday WITH =, int4range(start_min, end_min) WITH &&)
);

-- ---------------------------------------------------------------- Bloqueios (feriado, folga, manutenção)
-- Sem profissional e sem sala = a clínica inteira.
CREATE TABLE schedule_blocks (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  professional_id  uuid,
  resource_id      uuid,
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  reason           text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 200),
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, professional_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  CHECK (ends_at > starts_at)
);
CREATE INDEX schedule_blocks_time_idx ON schedule_blocks (tenant_id, starts_at, ends_at);

-- O banco recusa agendar sobre bloqueio (mesmo por caminho que não passe pela API).
CREATE FUNCTION appointments_block_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('cancelled','no_show') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.starts_at = OLD.starts_at AND NEW.ends_at = OLD.ends_at
     AND NEW.professional_id = OLD.professional_id AND NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id THEN
    RETURN NEW;   -- mudança só de status não reavalia bloqueios
  END IF;
  IF EXISTS (
    SELECT 1 FROM schedule_blocks b
     WHERE b.tenant_id = NEW.tenant_id
       AND tstzrange(b.starts_at, b.ends_at) && tstzrange(NEW.starts_at, NEW.ends_at)
       AND ((b.professional_id IS NULL AND b.resource_id IS NULL)
            OR b.professional_id = NEW.professional_id
            OR (b.resource_id IS NOT NULL AND b.resource_id = NEW.resource_id))
  ) THEN
    RAISE EXCEPTION 'horário bloqueado na agenda' USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointments_block_guard_trg BEFORE INSERT OR UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_block_guard();

-- ---------------------------------------------------------------- Lista de espera
CREATE TABLE waitlist_entries (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  patient_id       uuid NOT NULL,
  professional_id  uuid,
  service          text,
  notes            text CHECK (length(notes) <= 300),
  priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','priority')),
  status           text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','scheduled','cancelled')),
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, professional_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  CHECK ((status = 'waiting') = (resolved_at IS NULL))
);
CREATE INDEX waitlist_open_idx ON waitlist_entries (tenant_id, created_at) WHERE status = 'waiting';

-- ---------------------------------------------------------------- RLS e privilégios
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['availability_rules','schedule_blocks','waitlist_entries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_own_tenant ON %I FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, DELETE ON availability_rules, schedule_blocks TO clinica_app;
GRANT SELECT, INSERT, UPDATE ON waitlist_entries TO clinica_app;
