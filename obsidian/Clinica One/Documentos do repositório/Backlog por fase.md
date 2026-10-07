---
tags: [documento, repositorio]
projeto: Clínica One
atualizado: 2026-10-07
origem: docs/BACKLOG.md
---

> Cópia de `docs/BACKLOG.md`. Volta: [[00 - Índice]]

# Backlog por fase

Legenda: ✅ IMPLEMENTADO e testado localmente · 🟡 PARCIAL · ⬜ PLANEJADO

## Fase 0
- 🟡 ADRs (0001 proposta, 0002 implementada, 0003 parcial, 0004 pendente), threat model, aceite
- ⬜ Personas, jornadas, mapa de dados, protótipos

## Fase 1 — Fundação (GATE: nenhum dado real antes de fechar)
- ✅ PostgreSQL, migrations, tenant context, RLS, testes negativos (dados e HTTP)
- ✅ Identidade da clínica: login, sessões revogáveis, troca de senha, suspensão imediata, rate limit
- ✅ Master com MFA (TOTP, uso único) e reautenticação em ações críticas; recuperação do MFA do proprietário
- ✅ RBAC deny-by-default; entitlements no backend; `tiss.billing` bloqueado
- ✅ Auditoria (clínica e plataforma) em ações sensíveis
- 🟡 Capabilities: faltam addons, quotas, feature flags, assinatura/inadimplência
- ✅ MFA (TOTP) para usuários da clínica; segredos cifrados em repouso; limitador de tentativas no banco
- ⬜ Recuperação de senha e convite por e-mail (precisa de provedor), gestão de dispositivos, rotação da chave de cifragem
- ⬜ Acesso de suporte temporário (justificado, limitado, revogável)
- ✅ Backup + restore em banco temporário com validação (`npm run drill`), reprova ao detectar perda
- 🟡 CI escrito (`.github/workflows/ci.yml`), **nunca executado no GitHub**
- ⬜ Observabilidade, backup agendado/criptografado fora do host, secrets/rotação, HTTPS/deploy

## Fase 2 — Operação clínica essencial
- ✅ Pacientes, agenda com conflito transacional, prontuário com assinatura/adendo, financeiro particular
- ✅ Unidades/salas/equipamentos, horário de atendimento, encaixe, bloqueios, séries semanais, lista de espera, fila da recepção (chegada→chamada→atendimento→conclusão)
- 🟡 Recepção (falta triagem, formulários pendentes, checkout com pagamento)
- ✅ Responsáveis, detecção e revisão de duplicidade, mesclagem auditada, exportação do paciente, solicitações de privacidade (LGPD: ferramentas)
- ✅ Caixa (abertura/fechamento com conferência), descontos com aprovação, recibos numerados (não fiscais) — exigem o plano com financeiro avançado
- ✅ Agenda em visão de dia, semana e mês (contagem por dia calculada no banco)
- ⬜ Anexos e documentos, sangria/suprimento do caixa, caixa por unidade

## Fase 3
- ✅ Odontograma com histórico imutável e plano de tratamento com cobrança
- ✅ Orçamento com versões e aceite registrado pela clínica (o aceite gera os itens do plano de tratamento)
- ⬜ Imagens/radiografias, próteses/laboratórios, repasses, assinatura eletrônica do aceite (provedor externo)
- ✅ Camada de integrações: outbox transacional, worker (retry/backoff/dead-letter), webhooks assinados, consentimento, adaptadores WhatsApp/e-mail/SMS (sandbox + real escrito), armazenamento local
- ⛔ Envio real: depende de escolher/contratar provedores e validar adaptadores (`docs/INTEGRACOES.md`)
- ⬜ Inbox, templates editáveis, automações, opt-out por resposta, portal inicial

## Fases 4–6
- ✅ Papéis: gerente de unidade, estoque, marketing e auditor interno (alcance: clínica toda; **escopo por unidade ainda não existe**)
- ✅ Estoque: itens, livro de movimentos imutável (entrada/saída/ajuste explicado), saldo derivado que nunca fica negativo, alerta de mínimo
- ✅ CRM: leads, funil (novo → contatado → agendado → paciente/perdido), histórico imutável, consentimento de marketing registrado, conversão em paciente com aviso de duplicidade
- ✅ Indicadores (BI básico): atendimentos, faltas, pacientes novos, financeiro, CRM e estoque, por período; cada seção respeita plano e perfil
- ⬜ Estoque: lotes e validade, inventário por contagem, fornecedores e pedidos de compra, consumo ligado ao procedimento
- ⬜ CRM: campanhas e envio (depende de provedor de mensagens), agendamento direto a partir do lead
- ⬜ BI: catálogo de métricas versionado, exportação, comparação entre períodos, ocupação por sala/profissional
- ✅ **Pagamentos online (Mercado Pago):** Pix e link, confirmação por webhook assinado ou botão Verificar, conciliação com recibo, cancelamento e estorno; credenciais por clínica, cifradas. **Não validado com o Mercado Pago real** (roteiro em `docs/PAGAMENTOS.md`)
- ✅ Catálogo único de integrações (`src/integrations/catalog.ts`); portas e sandbox de **NFS-e** e **assinatura eletrônica** (adaptadores reais pendentes de decisão/contrato)
- ✅ Backup cifrado (`scripts/backup-encrypted.sh`) exercitado no CI; **sem agendamento nem destino em nuvem** (dependem do ambiente)
- ⬜ Pagamentos: estorno parcial, parcelamento, taxas do provedor, conciliação bancária
- ⬜ Papéis da plataforma (Master), portal do paciente, NFS-e, integrações reais, regulados, IA. Convênios/TISS: bloqueado globalmente.
