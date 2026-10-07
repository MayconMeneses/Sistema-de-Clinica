---
tags: [decisao, adr]
projeto: Clínica One
atualizado: 2026-10-07
origem: docs/adr/0003-identidade.md
---

> Volta: [[00 - Índice]] · [[04 - Arquitetura]]

# ADR-0003 — Identidade e sessões

Status: **IMPLEMENTADA (parcial)** — decisão de provedor externo continua pendente do proprietário.

## Implementado
- Senhas com scrypt (N=16384) e política mínima de 10 caracteres.
- Sessão server-side: token aleatório de 256 bits no cookie (`<tenant>.<segredo>`), hash SHA-256 no banco, expiração (clínica 12 h, Master 2 h), `session_version` para revogação imediata.
- O tenant do cookie é só uma dica: a sessão é consultada sob o RLS desse tenant, então um segredo de outra clínica não valida.
- Master: senha + TOTP (RFC 6238) obrigatórios; reautenticação com novo código para suspender/reativar e recuperar o MFA do proprietário.
- Clínica: TOTP opcional por usuário (ativar/desativar exigem senha + código); código de uso único; reset por administrador (colaboradores) ou pelo Master (proprietário).
- Segredos TOTP cifrados em repouso (AES-256-GCM, `DATA_ENCRYPTION_KEY`); limitador de tentativas compartilhado no PostgreSQL.

## Pendente
MFA obrigatório por política da clínica, códigos de recuperação, recuperação e convite por e-mail, rotação de sessão, rotação da chave de cifragem/KMS, provedor de identidade externo (comparar custo, lock-in, região). Substituição futura é possível porque a autenticação está isolada em `src/server/auth` e `src/server/context.ts`.
