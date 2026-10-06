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
- 🟡 Recepção (check-in simples; falta fila, triagem, formulários, sala)
- ⬜ Unidades/salas/recursos, responsáveis/dependentes, consentimentos, anexos, documentos, recorrência, lista de espera, caixa (abertura/fechamento), merge de pacientes

## Fase 3
- ✅ Odontograma com histórico imutável e plano de tratamento com cobrança
- ⬜ Orçamento com versões e aceite, imagens/radiografias, próteses/laboratórios, repasses
- ✅ Camada de integrações: outbox transacional, worker (retry/backoff/dead-letter), webhooks assinados, consentimento, adaptadores WhatsApp/e-mail/SMS (sandbox + real escrito), armazenamento local
- ⛔ Envio real: depende de escolher/contratar provedores e validar adaptadores (`docs/INTEGRACOES.md`)
- ⬜ Inbox, templates editáveis, automações, opt-out por resposta, portal inicial

## Fases 4–6
⬜ Comunicação, portal, CRM, estoque, BI, NFS-e, integrações, regulados, IA. Convênios/TISS: bloqueado globalmente.
