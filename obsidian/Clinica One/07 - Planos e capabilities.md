---
tags: [planos]
projeto: Clínica One
atualizado: 2026-10-07
---


# Planos e capabilities

Volta: [[00 - Índice]] · [[Módulos/Painel Master]]. Preços e quotas **não definidos** (decisão do proprietário).

Planos: **Solo · Clínica Essencial · Clínica Gestão · Clínica Completa · Rede Enterprise**.
Capabilities (14): `patient.registry`, `schedule.core`, `schedule.online`, `clinical.record`, `finance.basic`, `finance.advanced`, `communication.inbox`, `crm.pipeline`, `inventory.core`, `dental.odontogram`, `care.telehealth`, `tiss.billing` (**indisponível globalmente**), `analytics.bi`, `integration.api`.

Resolução (no servidor): plano + concessões/bloqueios do Master + dependências + status da clínica + indisponibilidade global. Suspender uma clínica remove o acesso na hora. O banco recusa habilitar `tiss.billing`.
Ainda **não** modelados: add-ons, quotas, feature flags, rollout, inadimplência. Ver [[10 - Conformidade com o prompt mestre]].
