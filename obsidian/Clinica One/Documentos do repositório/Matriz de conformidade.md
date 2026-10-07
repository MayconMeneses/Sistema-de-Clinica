---
tags: [documento, repositorio]
projeto: Clínica One
atualizado: 2026-10-07
origem: docs/CONFORMIDADE.md
---

> Cópia de `docs/CONFORMIDADE.md`. Volta: [[00 - Índice]]

# Matriz de conformidade com o prompt mestre

Legenda: ✅ atendido e testado localmente · 🟡 parcial · ⬜ não iniciado · ⛔ depende de decisão/terceiro · n/a não se aplica.
Estado em v0.7.0. "Testado" = teste automatizado em PostgreSQL real (ver `npm run check`) ou E2E no navegador. Nada aqui declara conformidade legal/regulatória.

| § | Requisito | Estado | Evidência / lacuna |
|---|---|---|---|
| 1 | Não inventar execução/resultado; distinguir estados | ✅ | docs com estados explícitos; integrações marcadas "não validado com o provedor real" |
| 2 | SaaS multiempresa, núcleo + módulos + capabilities, sem forks | 🟡 | núcleo + capabilities ✅; pacotes de especialidade só odontologia |
| 3 | Planos comerciais ≠ convênios; TISS bloqueado | ✅ | trigger no banco + resolução no backend + testes |
| 4.1 | Master: criar, suspender, reativar, trocar plano, conceder/bloquear, integrações | ✅ | testes API + E2E |
| 4.1 | Master: editar clínica, encerrar (UI), quotas, consumo, inadimplência, manutenção governada | ⬜ | `closed` existe na API, sem UI; resto não iniciado |
| 4.1 | Acesso de suporte temporário (justificado, limitado, revogável, auditado) | ⬜ | apenas recuperação de MFA do proprietário |
| 4.1 | Ações críticas com MFA, justificativa, auditoria | ✅ | suspender, reativar, recuperar MFA, recolocar fila |
| 4.2 | Admin da clínica isolado do resto | ✅ | RLS + testes cruzados |
| 4.3 | Portal do paciente | ⬜ | |
| 5 | 5 planos | ✅ | catálogo (preços/quotas ⛔ decisão do proprietário) |
| 6 | Capabilities e entitlement no backend | 🟡 | plano, override, dependência, status, indisponibilidade global, RBAC ✅; add-ons, quotas, feature flag, rollout, inadimplência, unidade, política de segurança ⬜ |
| 7 | Catálogo de add-ons, medição e alertas de consumo | ⬜ | |
| 8 | Papéis da plataforma | 🟡 | operador único; faltam papéis (financeiro, suporte, auditor…) |
| 8 | Papéis da clínica | 🟡 | 5 de 13 (dono, admin, recepção, profissional, financeiro); permissões novas: gestão da organização, horários/bloqueios, encaixe |
| 8 | RBAC + ABAC, deny-by-default | 🟡 | RBAC ✅ deny-by-default ✅; ABAC só por permissão clínica (falta unidade/relacionamento/finalidade) |
| 9 | Organização/unidades/salas/recursos | 🟡 | unidades, salas/cadeiras/equipamentos com API e tela (Gestão) ✅; endereço, contatos, horários da unidade, feriados da unidade, identidade visual, equipamentos com manutenção ⬜ |
| 10 | Pacientes | 🟡 | cadastro, busca, alerta restrito, consentimento de comunicação versionado, **responsáveis**, **aviso e revisão de duplicidade**, **mesclagem auditada** (histórico imutável preservado por alias), **exportação** respeitando permissões, **solicitações de privacidade** com prazo ✅; anexos/documentos, dependentes como cadastro ligado, identificadores adicionais, histórico de alterações campo a campo, origem do paciente/lead ⬜ |
| 11 | Agenda | 🟡 | dia/profissional, conflito de profissional, paciente **e sala** decidido pelo banco (concorrência testada), horário de atendimento, encaixe, bloqueios (clínica/profissional/sala, validados no banco), séries semanais com conflito parcial, lista de espera, cancelar/reagendar/falta ✅; visão semanal/mensal, agenda por serviço, duração por serviço/profissional, sinal/pagamento antecipado, agendamento online, calendários externos ⬜ |
| 12 | Recepção/jornada | 🟡 | chegada, prioridade, fila, chamada, em atendimento, conclusão com cobrança, tempo de espera, atualização automática ✅; pré-cadastro, triagem, formulários pendentes, atraso, checkout com pagamento, pesquisa, recall ⬜ |
| 13 | Prontuário | 🟡 | evolução, rascunho, assinatura imutável, adendo, leitura auditada ✅; formulários, sinais vitais, prescrição, atestados, anexos, impressão ⬜ |
| 14 | Odontologia | 🟡 | odontograma adulto/infantil com histórico imutável, plano com cobrança ✅; orçamento com versões/aceite, comparação temporal, imagens, próteses/laboratórios, repasses ⬜ |
| 15 | Pacotes por especialidade | ⬜ | |
| 16 | Financeiro particular | 🟡 | cobrança/pagamento/estorno por movimentos imutáveis, centavos, idempotência ✅; caixa (abertura/fechamento, diferença explicada), descontos com aprovação e segregação de funções, recibos numerados ✅; contas a pagar, conciliação, comissões, pacotes, inadimplência, sangria/suprimento, caixa por unidade, NFS-e ⬜ |
| 17 | TISS futuro | 🟡 | capability bloqueada; sem modelo de dados |
| 18 | Comunicação | 🟡 | canais (porta+sandbox+adaptador), confirmação/lembrete/cancelamento/remarcação, consentimento ✅; inbox, templates editáveis, automações, opt-out por resposta, SLA, bot ⬜ |
| 19–21 | CRM, estoque, teleatendimento | ⬜ | |
| 22 | Relatórios/BI | 🟡 | indicadores básicos no início; catálogo de métricas (definição/fórmula/owner) ⬜ |
| 23 | Integrações: adaptador, idempotência, retry/backoff/jitter, timeout, webhooks assinados com replay/dedupe/dead-letter, outbox, health | ✅ | `tests/integrations.test.ts` (29); ⬜ rate limit por integração, custo, reconciliação, exit strategy |
| 23 | Provedores reais (WhatsApp, e-mail, SMS) | ⛔ | adaptadores escritos, **não validados** com o provedor |
| 23 | Pagamentos, calendários, NFS-e, assinatura, error tracking | ⛔ | decisões pendentes |
| 24 | Monólito modular; módulos sem acessar tabelas alheias | 🟡 | módulos `entitlements`, `communications`, rotas por domínio; fronteiras ainda não impostas por ferramenta |
| 25 | Stack por ADR | 🟡 | ADR-0001 **proposta** (aguarda confirmação) |
| 26 | Multi-tenancy RLS; testes negativos | ✅ | dados, HTTP, arquivo (storage), webhook/evento cruzado; cache/relatório n/a (não existem) |
| 27 | Entidades principais | 🟡 | cerca de metade |
| 28 | Regras de dados | ✅ | UUID, UTC, centavos, imutabilidade, movimentos, conflito no banco; ⬜ estoque, retenção/descarte, tabela de anexos |
| 29 | Autenticação/sessões | 🟡 | login, logout, troca de senha, MFA, revogação, expiração, rate limit ✅; convite, recuperação, lista de dispositivos, rotação ⬜ |
| 30 | Segurança | 🟡 | RLS, CSP, CSRF, headers, validação, payload, logs sem dado de paciente, `npm audit` 0, varredura de segredos ✅; SAST, pentest, incidente, upload seguro (rota), rotação ⬜ |
| 31 | LGPD | 🟡 | ferramentas: consentimento versionado, acesso/exportação, registro e prazo de solicitações do titular, trilha de auditoria, minimização nos logs; **faltam**: base legal por finalidade, retenção/descarte, anonimização, incidentes, RIPD, suboperadores, textos jurídicos. Exige revisão humana especializada; nada aqui declara conformidade |
| 32 | Regras profissionais/interoperabilidade | ⛔ | validação humana necessária |
| 33 | IA | ⬜ | nenhuma IA no produto (intencional) |
| 34 | Observabilidade | 🟡 | logs estruturados, request id, health/ready ✅; métricas, traces, error tracking, alertas, runbooks ⬜ |
| 35 | Backup/restore | 🟡 | `npm run drill` valida restore ✅; RPO/RTO ⛔; backup agendado/criptografado/fora do host ⬜ |
| 36 | UX/acessibilidade | 🟡 | pt-BR, responsivo, labels, foco, estados vazio/erro/loading, confirmação ✅; contraste e teclado **não auditados** formalmente |
| 37 | API e contratos | 🟡 | validação, erros seguros, request id, idempotência no financeiro ✅; paginação por cursor, OpenAPI, contract tests ⬜ |
| 38 | Testes | 🟡 | unit, integração, RLS, segurança negativa, concorrência, E2E ✅; carga/stress/soak, acessibilidade automatizada, multi-navegador ⬜ |
| 39 | Git/CI/release | 🟡 | commits coerentes ✅; CI **escrito, nunca executado**; PR/proteção da main/tags ⬜ |
| 40 | Ambientes e variáveis | 🟡 | inventário em `docs/AMBIENTE.md`; staging/produção ⛔ |
| 41 | Roadmap | 🟡 | Fases 0–3 parcialmente; Fase 1 **gate aberto** (`docs/ACEITE-FASE-1.md`) |
| 43 | Decisões do proprietário registradas | ✅ | `PENDENCIAS.md` |
| 44–47 | Governança, DoD, formato, paradas | 🟡 | seguidas; formato de resposta resumido |
| 48 | Primeira execução (ordem) | ✅ | repositório confirmado, ADRs, threat model, RLS antes de pacientes |
