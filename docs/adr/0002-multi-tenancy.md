# ADR-0002 — Multi-tenancy: banco compartilhado com RLS

Status: **IMPLEMENTADA (parcial)** — evidência em `tests/tenant-isolation.test.ts`

## Decisão
Banco e tabelas compartilhados, `tenant_id` obrigatório, PostgreSQL RLS com `FORCE ROW LEVEL SECURITY`.

- Contexto: `withTenant()` abre transação e executa `set_config('app.tenant_id', $1, true)`. O valor deve vir da sessão confiável, nunca do cliente.
- Sem contexto => `app_current_tenant()` é NULL => zero linhas e escrita negada.
- Chaves primárias e FKs compostas `(tenant_id, id)` impedem referência entre tenants.
- Três papéis, **nenhum** superuser ou `BYPASSRLS`: `clinica_owner` (migrations), `clinica_app` (runtime da clínica), `clinica_platform` (control plane, com policies explícitas por tabela).
- Um teste falha se surgir tabela com `tenant_id` sem RLS forçado.
- Banco dedicado para Enterprise continua possível: nada na aplicação depende de um único banco.

## Rollback
Migrations são roll-forward. Rollback de schema/dados exige ação compensatória planejada; não testado.

## Limites conhecidos
Cache, filas, busca, arquivos, relatórios e webhooks tenant-aware ainda **não existem**, portanto os testes negativos correspondentes (spec §26) estão PENDENTES.
