-- 0003_app_core: identidade, pacientes, agenda, prontuário, financeiro (particular).
-- Todas as tabelas com tenant_id: RLS forçado, FKs compostas. Roll-forward apenas.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Diretório slug -> tenant (sem RLS): só resolve a clínica no login. Não expõe dados.
CREATE TABLE tenant_directory (
  slug       text PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  status     text NOT NULL
);
CREATE FUNCTION sync_tenant_directory() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO tenant_directory (slug, tenant_id, status) VALUES (NEW.slug, NEW.id, NEW.status)
  ON CONFLICT (slug) DO UPDATE SET status = EXCLUDED.status;
  RETURN NEW;
END $$;
CREATE TRIGGER tenants_sync_directory AFTER INSERT OR UPDATE OF status ON tenants
  FOR EACH ROW EXECUTE FUNCTION sync_tenant_directory();
GRANT SELECT ON tenant_directory TO clinica_app, clinica_platform;

-- ---------------------------------------------------------------- CONTROL PLANE
CREATE TABLE platform_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE CHECK (email = lower(email)),
  name           text NOT NULL,
  password_hash  text NOT NULL,
  totp_secret    text NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES platform_users(id),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON platform_users, platform_sessions TO clinica_platform;

-- ---------------------------------------------------------------- IDENTIDADE (tenant)
CREATE TABLE users (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  email            text NOT NULL CHECK (email = lower(email)),
  name             text NOT NULL,
  password_hash    text NOT NULL,
  role             text NOT NULL CHECK (role IN ('owner','admin','receptionist','professional','finance')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  session_version  int  NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, email)
);
CREATE TABLE sessions (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  user_id          uuid NOT NULL,
  token_hash       text NOT NULL UNIQUE,
  session_version  int  NOT NULL,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);

-- ---------------------------------------------------------------- PACIENTES
CREATE TABLE patients (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  social_name  text,
  birth_date   date,
  phone        text,
  email        text,
  document     text,
  alert        text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX patients_name_idx ON patients (tenant_id, lower(name));

-- ---------------------------------------------------------------- AGENDA
CREATE TABLE appointments (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  patient_id       uuid NOT NULL,
  professional_id  uuid NOT NULL,
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled','confirmed','checked_in','completed','cancelled','no_show')),
  service          text NOT NULL DEFAULT 'Consulta',
  price_cents      bigint NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  cancel_reason    text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, professional_id) REFERENCES users(tenant_id, id),
  CHECK (ends_at > starts_at),
  -- Conflito decidido pelo banco, não pela aplicação (vale sob concorrência).
  CONSTRAINT appointments_no_professional_overlap EXCLUDE USING gist
    (tenant_id WITH =, professional_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
    WHERE (status NOT IN ('cancelled','no_show')),
  CONSTRAINT appointments_no_patient_overlap EXCLUDE USING gist
    (tenant_id WITH =, patient_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
    WHERE (status NOT IN ('cancelled','no_show'))
);
CREATE INDEX appointments_time_idx ON appointments (tenant_id, starts_at);

-- ---------------------------------------------------------------- PRONTUÁRIO
CREATE TABLE clinical_notes (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  patient_id       uuid NOT NULL,
  author_id        uuid NOT NULL,
  appointment_id   uuid,
  body             text NOT NULL CHECK (length(btrim(body)) > 0),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed')),
  signed_at        timestamptz,
  parent_note_id   uuid,
  addendum_reason  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, author_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, parent_note_id) REFERENCES clinical_notes(tenant_id, id),
  CHECK ((parent_note_id IS NULL) = (addendum_reason IS NULL)),
  CHECK ((status = 'signed') = (signed_at IS NOT NULL))
);
CREATE INDEX clinical_notes_patient_idx ON clinical_notes (tenant_id, patient_id, created_at);

-- Prontuário assinado é imutável; nada é excluído; adendo só sobre nota assinada.
CREATE FUNCTION clinical_notes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'prontuário não pode ser excluído' USING ERRCODE = 'insufficient_privilege';
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'signed' THEN
      RAISE EXCEPTION 'prontuário assinado é imutável; registre um adendo' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.patient_id <> OLD.patient_id OR NEW.author_id <> OLD.author_id
       OR NEW.parent_note_id IS DISTINCT FROM OLD.parent_note_id THEN
      RAISE EXCEPTION 'vínculos do prontuário são imutáveis' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.parent_note_id IS NOT NULL THEN
      SELECT status INTO parent_status FROM clinical_notes
        WHERE tenant_id = NEW.tenant_id AND id = NEW.parent_note_id;
      IF parent_status IS DISTINCT FROM 'signed' THEN
        RAISE EXCEPTION 'adendo exige nota assinada' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER clinical_notes_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON clinical_notes
  FOR EACH ROW EXECUTE FUNCTION clinical_notes_guard();

-- ---------------------------------------------------------------- FINANCEIRO
-- Movimentos imutáveis (cobrança, pagamento, estorno). Saldo é derivado, nunca mutável.
CREATE TABLE financial_movements (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  patient_id       uuid NOT NULL,
  appointment_id   uuid,
  kind             text NOT NULL CHECK (kind IN ('charge','payment','refund')),
  method           text CHECK (method IN ('pix','card','cash')),
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  note             text,
  idempotency_key  text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients(tenant_id, id),
  FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments(tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK ((kind = 'charge') = (method IS NULL))
);
CREATE INDEX financial_movements_patient_idx ON financial_movements (tenant_id, patient_id, created_at);
CREATE TRIGGER financial_movements_append_only BEFORE UPDATE OR DELETE ON financial_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','sessions','patients','appointments','clinical_notes','financial_movements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_own_tenant ON %I FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
-- Control plane só cria o primeiro usuário (owner) de uma clínica nova; não lê dados da clínica.
CREATE POLICY platform_insert_owner ON users FOR INSERT TO clinica_platform
  WITH CHECK (role = 'owner');

GRANT SELECT, INSERT, UPDATE ON users, sessions, patients, appointments, clinical_notes TO clinica_app;
GRANT SELECT, INSERT ON financial_movements TO clinica_app;
GRANT INSERT ON users TO clinica_platform;
