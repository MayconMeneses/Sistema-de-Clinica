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

## Controles da camada HTTP (IMPLEMENTADO, testado localmente)
| Ameaça | Controle |
|---|---|
| Roubo de sessão por XSS | cookie HttpOnly, SameSite=Strict, CSP `script-src 'self'`, sem estilos/scripts inline |
| CSRF | SameSite=Strict + cabeçalho obrigatório + checagem de Origin nas mutações |
| Sessão forjada/entre clínicas | token aleatório de 256 bits guardado como hash; consulta sob RLS do tenant do cookie |
| Usuário suspenso / senha trocada | `session_version` + revogação imediata |
| Enumeração de usuário/clínica | resposta genérica e tempo equalizado no login |
| Brute force | limite de 5 falhas/15 min por IP+conta (**em memória**, processo único) |
| Vazamento em erros | handler central sem stack/SQL; `requestId` para suporte |
| SQL injection | consultas parametrizadas; colunas de UPDATE por allowlist |
| IDOR | RLS + FKs compostas; testes cruzando clínicas |
| Escalada de plano pelo cliente | runtime sem escrita em catálogo/tenants; entitlement no servidor |
| Master acessando prontuário | privilégio de banco inexistente; só cria o owner inicial |
| Reescrita de prontuário/financeiro | triggers de imutabilidade + movimentos append-only |

## Ameaças ainda SEM controle ou com controle parcial (PENDENTE)
- Segredo TOTP do Master guardado **sem criptografia** em repouso; sem cadastro/rotação de MFA pela interface.
- Rate limit em memória (não vale com várias instâncias); sem bloqueio por conta.
- Sem MFA para usuários da clínica; sem recuperação de senha; sessão não rotaciona após login.
- Sem HTTPS/HSTS efetivo (depende do deploy), sem WAF, sem gestão/rotação de segredos.
- Uploads, SSRF, webhooks, cache/fila/arquivo tenant-aware: componentes inexistentes.
- Acesso de suporte temporário do Master; logs sem dado clínico não auditados; backup/restore.
- Fuso horário fixo em São Paulo (UTC−3) na interface; fuso por unidade pendente.

## Dependências (npm audit, 2026-10-06)
- Runtime (`--omit=dev`): 0 vulnerabilidades.
- Dev (cadeia do vitest 2.x, ex.: tinypool): 6 achados (2 críticos). Upgrade para vitest 5 falhou por conflito de peer dependency (ERESOLVE) e **não foi resolvido**. Risco: execução só local/CI de testes. Ação: tratar ao criar o CI.
