---
tags: [acesso, demo]
projeto: Clínica One
atualizado: 2026-10-07
---


# Acessos de demonstração (fictícios)

Volta: [[00 - Índice]] · [[02 - Como acessar]]. **Somente demonstração local.** O seed recusa rodar com `NODE_ENV=production`.

| Quem | Identificador | E-mail | Senha |
|---|---|---|---|
| Dono (vê tudo) | `demo` | `dono@demo.demo` | `Demo@12345` |
| Administradora | `demo` | `anaadmin@demo.demo` | `Demo@12345` |
| Recepção | `demo` | `ritarecepcao@demo.demo` | `Demo@12345` |
| Profissional | `demo` | `drpauloprofissional@demo.demo` | `Demo@12345` |
| Profissional 2 | `demo` | `dracarlaprofissional@demo.demo` | `Demo@12345` |
| Financeiro | `demo` | `fabiofinanceiro@demo.demo` | `Demo@12345` |
| Consultório Solo | `solo-demo` | `dono@solo-demo.demo` | `Demo@12345` |
| **Master** (`/#/master`) | — | `master@demo.local` | `Demo@12345` + código MFA |

Código MFA do Master: `npm run totp` (ou `docker compose exec app npm run totp`). Cada código vale uma vez.

O que cada perfil enxerga (RBAC, deny-by-default): a recepção **não** acessa prontuário nem odontograma; o administrador **não** lê prontuário; só o profissional registra prontuário e achados dentais; financeiro só vê o financeiro. Ver [[06 - Segurança e privacidade]].
