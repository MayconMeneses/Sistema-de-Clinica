---
tags: [historico]
projeto: Clínica One
atualizado: 2026-10-07
---


# Histórico de versões

Volta: [[00 - Índice]]. Branch: `claude/wizardly-carson-xuhql2`.

| Versão | Commit | O que entrou |
|---|---|---|
| Fase 1 | `640f7e9` | Fundação: PostgreSQL, migrations, RLS, papéis, auditoria, entitlements, ADRs, modelo de ameaças |
| 0.3.0 | `1bd9c3a` | API, login/sessões, Painel Master (MFA), pacientes, agenda, prontuário imutável, financeiro, equipe, interface mobile-first |
| 0.4.0 | `6c6455e` | 0 vulnerabilidades; segredos TOTP cifrados; anti-replay; limite de tentativas no banco; MFA da clínica; **odontograma**; drill de backup; CI escrito |
| 0.5.0 | `a747bde` | Integrações em sandbox (outbox, worker, webhooks, consentimento); correção de logs com dados de paciente |
| 0.6.0 | `14b7ac1` | Salas, horários, bloqueios, séries, lista de espera, fila da recepção |
| 0.7.0 | `4d68485` | Duplicidade, mesclagem, responsáveis, exportação, solicitações de privacidade |
| 0.8.0 | `21c1502` | Caixa, descontos com aprovação, recibos numerados; atualização automática do app e do servidor |
| 0.9.0 | `a0b243c` | Orçamento odontológico com versões e aceite |
| 0.10.0 | `8c53132` | Agenda semanal e mensal; papéis (gerente, estoque, marketing, auditor); estoque; CRM; indicadores (BI); menu "Mais" no celular |
| 0.11.0 | publicada | Pagamentos online (Mercado Pago); catálogo único de integrações; portas de NFS-e e assinatura; backup cifrado |
| 0.12.0 | (esta versão) | Alertas de erro por Telegram (componente + clínica) e comandos de operação; telemetria de erros da tela |
| fix | `bb8bde5` | Menu inferior legível em 360px/320px + teste permanente |
| acesso | (este) | Docker, guia de acesso, cofre do Obsidian |

## Erros encontrados e corrigidos pelo caminho (resumo)
Query string de busca nos logs · pool fechado duas vezes · lista de consentimentos mostrando "sem autorização" antes de carregar · telefone com +55 escapando da duplicidade · seed sem chaves de duplicidade · menu inferior cortado em telas estreitas · testes com asserção que nunca falhava e E2E dependente de ordem.
