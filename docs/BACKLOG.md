# Backlog por fase

Legenda: ✅ IMPLEMENTADO e testado localmente · 🟡 PARCIAL · ⬜ PLANEJADO

## Fase 0
- 🟡 ADRs (0001 proposta, 0002 implementada, 0003 parcial, 0004 pendente), threat model, aceite
- ⬜ Personas, jornadas, mapa de dados, protótipos

## Fase 1 — Fundação (GATE: nenhum dado real antes de fechar)
- ✅ PostgreSQL, migrations, tenant context, RLS, testes negativos (dados e HTTP)
- ✅ Identidade da clínica: login, sessões revogáveis, troca de senha, suspensão imediata, rate limit
- ✅ Master com MFA (TOTP) e reautenticação em ações críticas
- ✅ RBAC deny-by-default; entitlements no backend; `tiss.billing` bloqueado
- ✅ Auditoria (clínica e plataforma) em ações sensíveis
- 🟡 Capabilities: faltam addons, quotas, feature flags, assinatura/inadimplência
- ⬜ MFA para usuários da clínica, recuperação de senha, convite por e-mail, gestão de dispositivos
- ⬜ Acesso de suporte temporário (justificado, limitado, revogável)
- ⬜ Observabilidade, CI, **backup e restore testado**, secrets/rotação, HTTPS/deploy

## Fase 2 — Operação clínica essencial
- ✅ Pacientes, agenda com conflito transacional, prontuário com assinatura/adendo, financeiro particular
- 🟡 Recepção (check-in simples; falta fila, triagem, formulários, sala)
- ⬜ Unidades/salas/recursos, responsáveis/dependentes, consentimentos, anexos, documentos, recorrência, lista de espera, caixa (abertura/fechamento), merge de pacientes

## Fases 3–6
⬜ Odontologia, comunicação, portal, CRM, estoque, BI, NFS-e, integrações, regulados, IA. Convênios/TISS: bloqueado globalmente.
