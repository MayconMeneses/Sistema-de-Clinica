# Dossiê para revisão jurídica e regulatória

**Finalidade:** entregar a um advogado de proteção de dados e/ou consultor de conformidade em saúde tudo o que ele precisa para revisar o Clínica One **sem ler o código**: o que o sistema faz com dados pessoais, que controles técnicos existem (com onde provar), e as perguntas que só ele pode responder.

> **Este documento não declara conformidade com a LGPD, o CFM, o CFO ou qualquer outra norma.** Ele descreve fatos técnicos. Citações de leis e resoluções abaixo são pontos de partida para o especialista confirmar, não conclusões jurídicas. As minutas em `docs/juridico/` são rascunhos para revisão e **não devem ser publicadas sem aprovação profissional**.

Estado do sistema: desenvolvimento, sem dados reais. Integrações externas em modo simulado (ver `docs/INTEGRACOES.md`).

## 1. Papéis no tratamento (a confirmar)
| Quem | Papel provável | Observação |
|---|---|---|
| Clínica (cliente) | **Controladora** dos dados de pacientes | decide finalidade e base legal |
| Operador do Clínica One | **Operadora** | trata dados em nome da clínica; precisa de contrato (minuta em `MINUTA-CONTRATO-OPERADOR.md`) |
| Operador do Clínica One | **Controlador** dos dados dos usuários da plataforma (equipe da clínica) e do faturamento | a confirmar |
| Provedores (hospedagem, e-mail, WhatsApp/SMS, pagamento) | **Suboperadores** | lista na seção 5; nenhum contratado ainda |

## 2. Mapa de dados (o que é guardado e por quê)
Sensibilidade: **S** = dado de saúde ou que o revela (LGPD art. 5º, II e art. 11 — a confirmar), **P** = pessoal comum, **F** = financeiro.

| Dado | Tabelas | Cat. | Finalidade técnica | Quem acessa (papel) | Proteções |
|---|---|---|---|---|---|
| Cadastro do paciente (nome, nascimento, documento, telefone, e-mail, endereço) | `patients`, `patient_guardians` | P | identificar, agendar, cobrar | dono, admin, gerente, recepção, profissional | RLS por clínica; leitura em lote auditada |
| Alerta clínico | `patients` | S | segurança do atendimento | só equipe clínica (profissional/dono) | RBAC `notes.read` |
| Prontuário (evoluções) | `clinical_notes` | S | registro assistencial | profissional e dono; recepção/admin **não** | assinatura imutável, adendo, leitura auditada |
| Odontograma e plano de tratamento | `dental_findings`, `dental_plan_items`, `dental_quotes*` | S | assistência | profissional escreve, dono lê | histórico imutável, leitura auditada |
| Documentos anexados (exames, laudos, termos) | `patient_documents` | S | registro assistencial | recepção, gerente, admin, dono, profissional | tipo validado pelo conteúdo, SHA-256, download auditado, sem exclusão |
| Agenda | `appointments`, `waitlist_entries` | S (revela atendimento) | operação | equipe de frente; gerente por unidade | RLS; escopo por unidade do gerente |
| Financeiro do paciente | `financial_movements`, `payment_intents`, `payment_refunds`, `discount_requests` | F | cobrança | financeiro, recepção, dono, admin | livro imutável; valores em centavos |
| Mensagens e consentimentos | `outbox_events`, `patient_consents` | P | lembretes/avisos | recepção, gerente | consentimento por canal versionado |
| CRM (leads) | `crm_leads`, `crm_lead_events` | P | captação | marketing, recepção, gerente | RLS |
| Solicitações do titular | `privacy_requests` | P | atender LGPD art. 18 | recepção, gerente, dono, admin | prazo de referência de 15 dias; fila |
| Usuários da clínica | `users`, `sessions` | P | autenticação | dono, admin | senha com hash; MFA cifrado (AES-256-GCM) |
| Acesso do paciente ao portal | `portal_invites`, `portal_sessions`, `portal_requests` | P | autoatendimento do paciente | o próprio paciente (só o que é dele); recepção, gerente, admin e dono gerenciam | link de uso único + data de nascimento; sessão isolada; auditoria `portal.*` |
| Auditoria | `audit_events` | P | rastreabilidade | dono, admin, auditor | append-only |
| Operação da plataforma | `platform_users`, `platform_audit_events`, `tenant_directory` | P | administrar clientes | operadores Master | o Master **não** lê dado clínico (sem privilégio no banco, testado) |

Fluxos para fora do sistema: cobrança (Mercado Pago recebe nome do pagador e valor), mensagens (WhatsApp/e-mail/SMS recebem nome, telefone e texto do lembrete), alertas de erro (Telegram recebe **apenas** componente, rota e erro higienizado, sem dado de paciente), **nenhum dado é enviado a serviços de analytics ou publicidade**.

## 3. Direitos do titular (LGPD art. 18) — o que o sistema faz hoje
| Direito | Estado | Como |
|---|---|---|
| Confirmação/acesso | ✅ | exportação dos dados do paciente (respeita permissões; auditada) |
| Correção | ✅ | edição do cadastro; correção de prontuário só por adendo |
| Anonimização, bloqueio ou eliminação | 🟡 | **não há exclusão** de prontuário/financeiro (guarda legal a confirmar); mesclagem preserva histórico; não há rotina de anonimização |
| Portabilidade | 🟡 | exportação existe; formato interoperável não definido |
| Informação sobre compartilhamento | 🟡 | depende da lista de suboperadores e da política de privacidade |
| Revogação de consentimento | ✅ | consentimento de comunicação por canal, com histórico |
| Prazo de resposta | ✅ | fila com prazo de referência (15 dias — a confirmar) |

## 4. Controles técnicos de segurança (com prova)
| Controle | Onde está / como provar |
|---|---|
| Isolamento entre clínicas no banco (RLS forçada, FKs compostas, papéis sem BYPASSRLS) | `docs/adr/0002-multi-tenancy.md`; `tests/tenant-isolation.test.ts` |
| RBAC deny-by-default; recepção/admin sem prontuário | `src/server/auth/rbac.ts`; testes de API |
| Autenticação: senha com hash, sessão revogável, MFA TOTP de uso único | `docs/ACESSO.md`; testes de auth/MFA |
| Cifragem de segredos em repouso (MFA, tokens de provedores) | AES-256-GCM, `DATA_ENCRYPTION_KEY` obrigatória em produção |
| Registros imutáveis (prontuário assinado, livros, documentos) | triggers no banco; testes |
| Auditoria de leituras e alterações sensíveis | tabela `audit_events` append-only |
| Limite de tentativas, CSRF, cookies `SameSite=Strict`/`Secure`/`HttpOnly`, CSP | `src/server/app.ts` |
| Backup/restore validado | `npm run drill` |
| Alertas sem dados pessoais | `src/ops/alerts.ts` (`scrub`), `tests/alerts.test.ts` |
| Modelo de ameaças | `docs/THREAT-MODEL.md` |

**Lacunas técnicas conhecidas (relevantes para o jurídico):** sem HTTPS/hospedagem definidos; sem backup automático fora do host; rotação da chave de segredos implementada (ver `docs/OPERACAO-CHAVES.md`), sem cifragem por campo dos dados clínicos; sem política de retenção/descarte implementada; sem teste de invasão externo; sem plano de resposta a incidentes testado (rascunho em `PLANO-INCIDENTES.md`).

## 5. Suboperadores previstos (nenhum contratado)
Hospedagem/nuvem · e-mail transacional · WhatsApp Business/SMS · Mercado Pago · Telegram (alertas, sem dado pessoal). Para cada um o especialista precisa avaliar: contrato/DPA, localização dos dados (transferência internacional — LGPD cap. V), e o que é enviado.

## 6. Perguntas para o especialista
**LGPD**
1. Quais **bases legais** adotar para cada finalidade (tutela da saúde, cumprimento de obrigação legal, execução de contrato, consentimento) e como registrar?
2. **Crianças e adolescentes** (art. 14): o cadastro tem responsável; o fluxo de consentimento está adequado?
3. Textos finais de **política de privacidade**, **termos de uso** e **consentimento de comunicação** (minutas fornecidas).
4. Papel exato (controlador × operador) e **contrato de operador** com as clínicas.
5. Necessidade e perfil do **encarregado (DPO)**, e canal do titular.
6. **Relatório de impacto (RIPD)** é recomendável/obrigatório para dado de saúde em escala?
7. **Incidentes** (art. 48): critérios e prazos para comunicar a ANPD e titulares; revisar o rascunho do plano.
8. **Transferência internacional**: provedores com servidores fora do Brasil.

**CFM / CFO / guarda de prontuário**
9. **Prazo de guarda** do prontuário e documentos (a literatura cita 20 anos, Lei 13.787/2018 e resoluções do CFM — confirmar) e o que fazer com o pedido de **eliminação** do titular frente à guarda obrigatória.
10. Requisitos para **prontuário eletrônico sem papel** (certificação SBIS/CFM, assinatura digital ICP-Brasil): a assinatura atual (login + registro imutável) é suficiente?
11. **Odontologia (CFO)**: exigências de prontuário odontológico, orçamento/contrato e termo de consentimento, e imagens radiográficas.
12. **Telemedicina**, receitas e atestados (não implementados) — quando entrarem, quais regras?

**Operação comercial**
13. Contrato de prestação do SaaS, SLA e limitação de responsabilidade.
14. Obrigações fiscais da plataforma (NFS-e) e das clínicas (recibos do sistema **não são fiscais**).
15. Uso de dados anonimizados para melhoria do produto: permitido? Hoje **não é feito**.

## 7. O que o especialista pode pedir ao desenvolvimento
Exportar a trilha de auditoria de um período · demonstrar o isolamento entre clínicas · listar quem acessou determinado prontuário · simular um pedido do titular · mostrar o procedimento de backup/restore (`npm run drill`).
