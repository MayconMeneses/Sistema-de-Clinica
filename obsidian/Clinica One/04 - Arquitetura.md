---
tags: [arquitetura]
projeto: Clínica One
atualizado: 2026-10-07
---


# Arquitetura

Volta: [[00 - Índice]]. Monólito modular em TypeScript/Node 22 + PostgreSQL 16. Decisões: [[Decisões/0001-stack]].

```
Navegador (React, mobile-first)  ──HTTP──►  API Fastify (src/server)
                                              ├─ routes/*  (um arquivo por domínio)
                                              ├─ context.ts (UMA transação por requisição: sessão → tenant → permissão → capability)
                                              ├─ modules/  entitlements · communications · patients
                                              └─ integrations/ portas + adaptadores (sandbox e reais)
Worker (src/worker) ── lê a outbox ── envia mensagens, aplica webhooks de entrega
PostgreSQL: 33 tabelas, RLS forçado, 4 papéis de banco sem BYPASSRLS
```

## Papéis de banco (menor privilégio)
| Papel | Uso | Enxerga |
|---|---|---|
| `clinica_owner` | migrations | tudo (só no deploy) |
| `clinica_app` | sistema da clínica | só o tenant do contexto (RLS) |
| `clinica_platform` | Painel Master | catálogo, tenants, metadados; **nunca** pacientes, senhas ou segredos |
| `clinica_worker` | fila de mensagens | só `outbox_events` e `webhook_receipts` |

## Padrões que se repetem
- **Uma transação por requisição**, com o tenant vindo da sessão (nunca do cliente).
- **Imutabilidade por trigger**: prontuário assinado, movimentos financeiros, achados dentais, consentimentos, auditoria.
- **Regras críticas no banco**: conflito de agenda (profissional, paciente, sala), bloqueios, capability indisponível, chaves de duplicidade.
- **Efeitos externos pela outbox** (na mesma transação do negócio) → [[Módulos/Comunicação e integrações]].

Telas: ![[anexos/09-agenda-desktop.png|600]]
