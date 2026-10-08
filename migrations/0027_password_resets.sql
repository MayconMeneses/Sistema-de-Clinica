-- 0027_password_resets: recuperação de senha por e-mail. Capability: núcleo.
-- O link leva um token aleatório de uso único e validade curta. O banco guarda só o HASH do token (para conferir) e, até o envio
-- do e-mail, o token CIFRADO (AES-256-GCM) para a fila poder montar a mensagem; depois do envio o token cifrado é apagado.

CREATE TABLE password_resets (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  token_hash  text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_enc   text,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX password_resets_user_idx ON password_resets (tenant_id, user_id, created_at DESC);

CREATE FUNCTION password_resets_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'pedido de redefinição não pode ser excluído' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.used_at IS NOT NULL THEN RAISE EXCEPTION 'link de redefinição já usado' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.token_hash <> OLD.token_hash OR NEW.user_id <> OLD.user_id OR NEW.expires_at <> OLD.expires_at OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'dados do pedido de redefinição são imutáveis' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.used_at IS NOT NULL THEN NEW.token_enc := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER password_resets_guard_trg BEFORE UPDATE OR DELETE ON password_resets FOR EACH ROW EXECUTE FUNCTION password_resets_guard();

ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own_tenant ON password_resets FOR ALL TO clinica_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON password_resets TO clinica_app;
