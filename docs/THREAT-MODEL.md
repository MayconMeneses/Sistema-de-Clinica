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
| Brute force | 5 falhas/15 min por IP+conta, contador **no PostgreSQL** (vale com várias instâncias; chave hasheada) |
| Reuso de código TOTP capturado | cada passo de 30s só é aceito uma vez (`totp_last_step`) |
| Vazamento do banco expor MFA | segredos TOTP cifrados com AES-256-GCM (chave fora do banco) |
| Perda do MFA do proprietário | recuperação pelo Master com MFA + justificativa, restrita a colunas de MFA/sessão |
| Odontograma/plano adulterados | eventos append-only; item finalizado imutável; leitura auditada |
| Perda de dados | `npm run drill` restaura e valida dados, RLS e isolamento (reprova se divergir) |
| Vazamento em erros | handler central sem stack/SQL; `requestId` para suporte |
| SQL injection | consultas parametrizadas; colunas de UPDATE por allowlist |
| IDOR | RLS + FKs compostas; testes cruzando clínicas |
| Escalada de plano pelo cliente | runtime sem escrita em catálogo/tenants; entitlement no servidor |
| Master acessando prontuário | privilégio de banco inexistente; só cria o owner inicial |
| Reescrita de prontuário/financeiro | triggers de imutabilidade + movimentos append-only |

## Ameaças ainda SEM controle ou com controle parcial (PENDENTE)
- Chave de cifragem (`DATA_ENCRYPTION_KEY`) sem rotação nem KMS; em dev é uma chave fixa pública.
- Sem recuperação de senha por e-mail; sessão não rotaciona após login; sem bloqueio permanente de conta.
- Janela do TOTP de ±1 passo; sem códigos de recuperação.
- Sem HTTPS/HSTS efetivo (depende do deploy), sem WAF, sem gestão/rotação de segredos.
- Uploads, SSRF, webhooks, cache/fila/arquivo tenant-aware: componentes inexistentes.
- Acesso de suporte temporário do Master; logs sem dado clínico não auditados; backup/restore.
- Fuso horário fixo em São Paulo (UTC−3) na interface; fuso por unidade pendente.

## Dependências (npm audit, 2026-10-06)
- 0 vulnerabilidades (runtime e dev) após subir vite 7, plugin-react 5 e vitest 5 em conjunto.
