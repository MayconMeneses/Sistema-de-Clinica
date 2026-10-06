# Critérios de aceite — Fase 1 (gate)

| # | Critério | Estado |
|---|---|---|
| 1 | Dois tenants isolados em leitura/escrita/exclusão/inserção cruzada | ✅ banco (27 testes) e HTTP (cookie forjado, IDOR, FK) — PostgreSQL local |
| 2 | Autorização no backend, deny by default | ✅ RBAC + entitlements testados; ABAC (unidade, relacionamento) pendente |
| 3 | Auditoria durável e imutável | ✅ gravada nas ações sensíveis; append-only por trigger |
| 4 | Identidade com sessões revogáveis | ✅ clínica; **MFA só no Master** |
| 5 | Painel Master mínimo com auditoria e MFA | ✅ (sem suporte temporário) |
| 6 | CI com typecheck, testes e migrations | ❌ não existe |
| 7 | Backup com restore executado e validado | ❌ não executado |
| 8 | Cache/fila/arquivo/webhook/relatório tenant-aware | n/a — componentes inexistentes |

**Gate NÃO atendido (itens 6 e 7, MFA da clínica, suporte temporário, HTTPS/segredos). Não usar com dados reais.**
