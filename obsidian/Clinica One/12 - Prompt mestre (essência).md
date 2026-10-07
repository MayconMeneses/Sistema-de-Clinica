---
tags: [prompt, requisitos]
projeto: Clínica One
atualizado: 2026-10-07
---


# Prompt mestre — essência

Volta: [[00 - Índice]] · [[10 - Conformidade com o prompt mestre]]. **O texto integral do prompt é a primeira mensagem da conversa de construção**; esta nota guarda os princípios que guiam o trabalho.

## Regras de conduta
- Nunca inventar execução, teste, evidência, integração ou conformidade; distinguir planejado/implementado/validado/bloqueado.
- Build verde ≠ pronto; backup existente ≠ recuperação testada; nada de "conformidade LGPD/CFM/CFO" sem validação humana.
- Segurança, integridade, privacidade e isolamento multi-tenant são não negociáveis. Menor solução suficiente.

## Produto
SaaS multiempresa para solo → rede; núcleo + módulos + capabilities + planos (Solo, Essencial, Gestão, Completa, Enterprise); **convênios/TISS fora da primeira fase**; três ambientes (Master, clínica, portal do paciente).

## Arquitetura
Monólito modular; control plane ≠ data plane; PostgreSQL com RLS; tenant vindo da sessão; outbox para efeitos externos; imutabilidade (prontuário, financeiro, estoque); dinheiro em centavos; auditoria.

## Roadmap
Fase 0 descoberta → **Fase 1 fundação (gate: nada de dado real antes de provar isolamento, autorização e auditoria)** → Fase 2 operação clínica → Fase 3 odontologia/comunicação → Fase 4 gestão avançada → Fase 5 regulado (TISS, telemedicina…) → Fase 6 IA e escala.

## Definition of Done
Requisito e aceite registrados · autorização no backend · testes positivos e negativos · auditoria · acessibilidade · documentação · riscos residuais declarados · evidência ligada ao commit.
