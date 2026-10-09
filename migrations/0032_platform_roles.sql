-- 0032_platform_roles: papéis dos operadores da plataforma (antes todo operador tinha o mesmo poder).
-- Operadores existentes viram 'admin' (nada muda para eles); novos entram com o papel mínimo necessário.
ALTER TABLE platform_users
  ADD COLUMN role text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','clinics','billing','support','auditor'));
