-- 0011_more_roles: gerente de unidade, estoque, marketing e auditor interno.
-- As permissões de cada papel ficam no código (src/server/auth/rbac.ts), negadas por padrão.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN
  ('owner','admin','unit_manager','receptionist','professional','finance','stock','marketing','auditor'));
