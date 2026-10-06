# ADR-0003 — Identidade e sessões

Status: **IMPLEMENTADA (parcial)** — decisão de provedor externo continua pendente do proprietário.

## Implementado
- Senhas com scrypt (N=16384) e política mínima de 10 caracteres.
- Sessão server-side: token aleatório de 256 bits no cookie (`<tenant>.<segredo>`), hash SHA-256 no banco, expiração (clínica 12 h, Master 2 h), `session_version` para revogação imediata.
- O tenant do cookie é só uma dica: a sessão é consultada sob o RLS desse tenant, então um segredo de outra clínica não valida.
- Master: senha + TOTP (RFC 6238) obrigatórios; reautenticação com novo código para suspender/reativar.

## Pendente
MFA da clínica, recuperação e convite por e-mail, rotação de sessão, criptografia do segredo TOTP, provedor de identidade externo (comparar custo, lock-in, região). Substituição futura é possível porque a autenticação está isolada em `src/server/auth` e `src/server/context.ts`.
