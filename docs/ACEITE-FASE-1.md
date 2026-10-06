# Critérios de aceite — Fase 1 (gate)

1. Dois tenants provados isolados em leitura, escrita, exclusão e inserção cruzada — **atendido para dados em PostgreSQL local**.
2. Autorização no backend com deny by default — **parcial** (DB e entitlements; RBAC/ABAC pendentes).
3. Auditoria durável e imutável — **parcial** (estrutura sim, uso não).
4. Identidade com MFA e sessões revogáveis — **não atendido**.
5. Painel Master mínimo com auditoria e MFA — **não atendido**.
6. CI executando typecheck, testes e verificação de migrations — **não atendido**.
7. Backup com restore executado e validado — **não atendido**.

**A Fase 1 NÃO está concluída; o gate continua fechado.**
