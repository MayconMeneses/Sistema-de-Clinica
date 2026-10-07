---
tags: [status, visao-geral]
projeto: Clínica One
atualizado: 2026-10-07
---


# Visão geral e status

**Clínica One** — SaaS para dentista/médico/psicólogo individual até rede de clínicas, com núcleo comum + módulos + capabilities + planos comerciais. Convênios/TISS: **bloqueados globalmente** nesta fase. Volta: [[00 - Índice]].

## Três ambientes
1. **Painel Master** (a empresa dona do SaaS): clínicas, planos, funcionalidades, integrações, auditoria. [[Módulos/Painel Master]]
2. **Sistema da clínica** (o produto alugado): pacientes, agenda, recepção, prontuário, odontologia, financeiro, equipe.
3. **Portal do paciente**: **planejado, não iniciado.**

## Números (v0.7.0)
- 8 migrations · 33 tabelas · 34 políticas de segurança por linha (RLS)
- 134 testes automatizados (PostgreSQL real) + teste de navegador (E2E, celular e desktop)
- `npm audit`: 0 vulnerabilidades · backup/restore validado por script
- Código: API Fastify (`src/server`), módulos (`src/modules`), integrações (`src/integrations`), worker (`src/worker`), interface React mobile-first (`web/src`)

## O que NÃO é verdade ainda
- Não está pronto para dados reais (gate da Fase 1 aberto): [[Documentos do repositório/Critérios de aceite da Fase 1]]
- Envio real de WhatsApp/e-mail/SMS: adaptadores escritos e testados só contra servidor falso; precisam de contrato com provedores
- CI escrito, nunca executado no GitHub · Docker escrito, nunca executado (sem Docker no ambiente de construção)
- Nenhuma conformidade (LGPD, CFM, CFO) é declarada: exige revisão especializada

Detalhe do que falta: [[09 - Roadmap e pendências]] e [[10 - Conformidade com o prompt mestre]].
