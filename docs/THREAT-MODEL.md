# Threat model — versão inicial (Fase 1, escopo: fundação de dados)

Status: **ANALISADO, não revisado por especialista de segurança.** Não é evidência de segurança.

## Ativos
Dados de pacientes e prontuários (futuros), credenciais, catálogo de planos/entitlements, trilha de auditoria.

## Fronteiras de confiança
Navegador/portal ↔ API (não existe ainda) ↔ PostgreSQL. Control plane (`clinica_platform`) ↔ data plane (`clinica_app`).

## Ameaças e controles (somente o que existe)
| Ameaça | Controle | Estado |
|---|---|---|
| Tenant A lê/altera/exclui dados de B | RLS forçado, FK composta, contexto por transação | IMPLEMENTADO e testado (banco local) |
| Contexto de tenant vazar no pool | `set_config(..., true)` transacional | testado com pool de 1 conexão |
| Runtime eleva plano/entitlements | GRANTs mínimos, sem escrita em catálogo/tenants | testado |
| Habilitar `tiss.billing` por override | trigger no banco + resolução no backend | testado |
| Adulterar/apagar auditoria | privilégios + trigger append-only | testado |
| Papel com bypass de RLS | verificação de `rolsuper/rolbypassrls` nos testes | testado |

## Ameaças ainda SEM controle (PENDENTE)
Autenticação/sessão/MFA, IDOR na camada HTTP, CSRF/XSS/SSRF, uploads, rate limit, segredos/rotação, cache/fila/arquivo cruzando tenant, suporte temporário do Master, backup/restore, logs sem dados clínicos.

## Dependências (npm audit, 2026-10-06)
- Runtime (`--omit=dev`): 0 vulnerabilidades.
- Dev (cadeia do vitest 2.x, ex.: tinypool): 6 achados (2 críticos). Upgrade para vitest 5 falhou por conflito de peer dependency (ERESOLVE) e **não foi resolvido**. Risco: execução só local/CI de testes. Ação: tratar ao criar o CI.
