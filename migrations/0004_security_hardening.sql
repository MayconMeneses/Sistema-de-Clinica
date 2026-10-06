-- 0004_security_hardening: MFA da clínica, anti-replay de TOTP, rate limit compartilhado, recuperação do owner pelo Master.

ALTER TABLE users
  ADD COLUMN totp_secret     text,            -- cifrado pela aplicação (AES-256-GCM), nunca em claro
  ADD COLUMN totp_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN totp_last_step  bigint;          -- último passo de 30s aceito (impede reuso do mesmo código)
ALTER TABLE users ADD CONSTRAINT users_totp_enabled_needs_secret CHECK (NOT totp_enabled OR totp_secret IS NOT NULL);
ALTER TABLE platform_users ADD COLUMN totp_last_step bigint;

-- Contador de falhas compartilhado entre instâncias (substitui o limitador em memória).
-- Chave = SHA-256 de ip|conta; sem dado pessoal em claro. Sem coluna tenant_id (não é dado de clínica).
CREATE TABLE rate_limits (
  key_hash      text PRIMARY KEY,
  window_start  timestamptz NOT NULL DEFAULT now(),
  failures      int NOT NULL DEFAULT 0
);
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limits TO clinica_app, clinica_platform;

-- Recuperação de acesso do proprietário pelo suporte da plataforma, sem ler dados clínicos:
-- só metadados do owner e só as colunas de MFA/sessão podem ser alteradas.
CREATE POLICY platform_read_owner ON users FOR SELECT TO clinica_platform USING (role = 'owner');
CREATE POLICY platform_reset_owner ON users FOR UPDATE TO clinica_platform
  USING (role = 'owner') WITH CHECK (role = 'owner');
GRANT SELECT (id, tenant_id, role, email, name, status, totp_enabled, session_version) ON users TO clinica_platform;
GRANT UPDATE (totp_secret, totp_enabled, totp_last_step, session_version) ON users TO clinica_platform;
