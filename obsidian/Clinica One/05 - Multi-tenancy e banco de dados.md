---
tags: [banco, seguranca]
projeto: Clínica One
atualizado: 2026-10-07
---


# Multi-tenancy e banco de dados

Volta: [[00 - Índice]] · [[Decisões/0002-multi-tenancy]].

- Banco e tabelas **compartilhados**; `tenant_id` obrigatório; **RLS com FORCE** (vale até para o dono das tabelas).
- Contexto do tenant: `set_config('app.tenant_id', …, true)` dentro da transação. Sem contexto → 0 linhas e escrita negada.
- Chaves primárias e FKs **compostas** `(tenant_id, id)`: impossível referenciar dado de outra clínica.
- Teste-guarda: falha se surgir tabela com `tenant_id` sem RLS forçado (exceções conscientes: auditoria da plataforma e diretório slug→tenant).
- Banco dedicado por cliente enterprise continua possível.

## Migrations (8)
| # | Conteúdo |
|---|---|
| 0001 | fundação: tenants, planos, capabilities, RLS, auditoria append-only |
| 0002 | catálogo: 5 planos, 14 capabilities |
| 0003 | identidade, pacientes, agenda, prontuário, financeiro |
| 0004 | MFA da clínica, anti-replay de TOTP, rate limit no banco, recuperação do dono |
| 0005 | odontograma (eventos imutáveis) e plano de tratamento |
| 0006 | consentimento, outbox, conexões de integração, webhooks recebidos |
| 0007 | salas na agenda, horários, bloqueios, lista de espera, séries, fila |
| 0008 | chaves de duplicidade (trigger), responsáveis, mesclagem, privacidade |
