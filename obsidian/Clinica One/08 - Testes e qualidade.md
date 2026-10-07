---
tags: [testes]
projeto: Clínica One
atualizado: 2026-10-07
---


# Testes e qualidade

Volta: [[00 - Índice]].

**134 testes** automatizados contra PostgreSQL real (`npm run check`): isolamento entre clínicas (banco e HTTP), RBAC, concorrência (agenda, sala, financeiro, workers), prontuário imutável, MFA e anti-replay, outbox/webhooks, agenda/recepção, pacientes/privacidade.
**E2E no navegador** (`npm run e2e`): celular e desktop, 50+ passos; falha em erro de console/CSP, resposta 5xx, rolagem horizontal ou rótulo de menu cortado (390/360/320px).
**Teste de mutação manual**: desligar o trigger de bloqueio faz 3 testes falharem (os testes pegam o defeito).
Outros: `npm audit` (0), `npm run drill` (backup→restore→valida dados, RLS e isolamento; reprova se algo divergir), varredura simples de segredos.

Não feito: carga/stress/soak, acessibilidade automatizada (axe), multi-navegador, pentest, SAST. CI escrito (`.github/workflows/ci.yml`) mas **nunca executado**.
