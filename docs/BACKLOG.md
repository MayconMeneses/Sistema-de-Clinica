# Backlog por fase (resumo — detalhes na spec mestre)

Legenda: ✅ IMPLEMENTADO+testado localmente · 🟡 PARCIAL · ⬜ PLANEJADO

## Fase 0
- 🟡 ADRs (0001 proposta, 0002 parcial, 0003/0004 pendentes), threat model inicial, backlog, critérios de aceite
- ⬜ Personas, jornadas, non-goals detalhados, mapa de dados, protótipos

## Fase 1 — Fundação (GATE: nada de paciente/prontuário real antes de fechar)
- ✅ PostgreSQL + migrations versionadas com checksum
- ✅ Tenant context + RLS + testes negativos com dois tenants (dados)
- 🟡 Auditoria (tabelas append-only existem; nenhum fluxo grava ainda)
- 🟡 Planos/capabilities/overrides (catálogo e resolução; faltam addons, quotas, flags, assinatura/inadimplência)
- ⬜ Identidade, sessões, MFA, papéis/permissões (RBAC/ABAC)
- ⬜ API HTTP, Painel Master mínimo, suporte temporário
- ⬜ Observabilidade, CI, backup e **restore testado**
- ⬜ Testes negativos de cache/fila/arquivo/webhook/relatório

## Fases 2–6
⬜ Conforme spec §41. Nenhuma iniciada. Convênios/TISS: bloqueado globalmente.
