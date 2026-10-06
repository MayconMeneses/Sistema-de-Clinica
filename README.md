# Clínica One — plataforma SaaS de gestão clínica

**Status: Fase 1 EM ANDAMENTO (fundação parcial). Não é produto, não há dados reais, não é seguro para produção.**
Especificação: ver prompt mestre do projeto. Convênios/TISS: bloqueados globalmente nesta fase.

## O que existe (IMPLEMENTADO e testado localmente)
- Migrations SQL versionadas (`migrations/`) e runner com checksum.
- Multi-tenancy com PostgreSQL RLS forçado, contexto transacional de tenant e três papéis sem BYPASSRLS.
- Catálogo de 5 planos e 14 capabilities; resolução de entitlements no backend; `tiss.billing` bloqueado também no banco.
- Auditoria append-only (tenant e plataforma).

## O que NÃO existe
Identidade/MFA, API HTTP, Painel Master, pacientes, agenda, prontuário, financeiro, integrações, CI, backup/restore, observabilidade. Ver `docs/BACKLOG.md`.

## Rodar localmente (requer PostgreSQL 16 e Node 22)
```
npm install
npm run db:setup        # cria banco e papéis de DEV (superuser local via 'su postgres')
npm run db:migrate      # com DATABASE_URL_OWNER (ver .env.example)
npm run check           # typecheck + testes
```
Os testes acumulam tenants de teste com slug aleatório; recrie o banco de dev para limpar (`dropdb clinica_one && npm run db:setup`).

## Documentação
`docs/adr/`, `docs/THREAT-MODEL.md`, `docs/BACKLOG.md`, `docs/ACEITE-FASE-1.md`, `PENDENCIAS.md`.
