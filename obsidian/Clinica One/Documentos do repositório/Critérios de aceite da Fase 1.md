---
tags: [documento, repositorio]
projeto: Clínica One
atualizado: 2026-10-07
origem: docs/ACEITE-FASE-1.md
---

> Cópia de `docs/ACEITE-FASE-1.md`. Volta: [[00 - Índice]]

# Critérios de aceite — Fase 1 (gate)

| # | Critério | Estado |
|---|---|---|
| 1 | Dois tenants isolados em leitura/escrita/exclusão/inserção cruzada | ✅ banco (27 testes) e HTTP (cookie forjado, IDOR, FK) — PostgreSQL local |
| 2 | Autorização no backend, deny by default | ✅ RBAC + entitlements testados; ABAC (unidade, relacionamento) pendente |
| 3 | Auditoria durável e imutável | ✅ gravada nas ações sensíveis; append-only por trigger |
| 4 | Identidade com sessões revogáveis e MFA | ✅ clínica e Master (TOTP, uso único, segredo cifrado) |
| 5 | Painel Master mínimo com auditoria e MFA | ✅ (sem suporte temporário) |
| 6 | CI com typecheck, testes e migrations | 🟡 workflow escrito; **não executado** no GitHub |
| 7 | Backup com restore executado e validado | ✅ `npm run drill` (dados, RLS, isolamento) em PostgreSQL local; ⚠ sem backup agendado/criptografado/fora do host e RPO/RTO não definidos |
| 8 | Cache/fila/arquivo/webhook/relatório tenant-aware | n/a — componentes inexistentes |

**Gate AINDA NÃO atendido: faltam executar o CI no GitHub, suporte temporário auditado, HTTPS/gestão de segredos e rotação, backup real (agendado, criptografado, fora do host) com RPO/RTO definidos, e revisão de segurança por especialista. Não usar com dados reais.**
