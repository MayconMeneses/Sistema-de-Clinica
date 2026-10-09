-- 0034_portal_booking: o paciente marca a própria consulta pelo portal, só em horários livres de profissionais liberados pela clínica.
-- Desligado por padrão. A regra de conflito continua sendo do banco (sobreposição e bloqueios), não do aplicativo.
CREATE TABLE portal_booking_settings (
  tenant_id              uuid PRIMARY KEY REFERENCES tenants(id),
  enabled                boolean  NOT NULL DEFAULT false,
  slot_minutes           smallint NOT NULL DEFAULT 30 CHECK (slot_minutes BETWEEN 10 AND 240),
  min_notice_hours       smallint NOT NULL DEFAULT 12 CHECK (min_notice_hours BETWEEN 0 AND 168),
  max_days_ahead         smallint NOT NULL DEFAULT 30 CHECK (max_days_ahead BETWEEN 1 AND 180),
  max_active_per_patient smallint NOT NULL DEFAULT 2  CHECK (max_active_per_patient BETWEEN 1 AND 10),
  service                text     NOT NULL DEFAULT 'Consulta' CHECK (length(btrim(service)) BETWEEN 2 AND 120),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE portal_bookable_professionals (
  tenant_id       uuid NOT NULL,
  professional_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, professional_id),
  FOREIGN KEY (tenant_id, professional_id) REFERENCES users(tenant_id, id)
);

-- de onde veio o agendamento (limita quantas marcações pelo portal o paciente mantém abertas)
ALTER TABLE appointments ADD COLUMN booked_via text CHECK (booked_via IN ('portal'));
CREATE INDEX appointments_portal_idx ON appointments (tenant_id, patient_id) WHERE booked_via = 'portal';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['portal_booking_settings','portal_bookable_professionals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_own_tenant ON %I FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON portal_booking_settings, portal_bookable_professionals TO clinica_app;
