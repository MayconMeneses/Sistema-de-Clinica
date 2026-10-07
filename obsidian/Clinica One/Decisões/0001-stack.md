---
tags: [decisao, adr]
projeto: Clínica One
atualizado: 2026-10-07
origem: docs/adr/0001-stack.md
---

> Volta: [[00 - Índice]] · [[04 - Arquitetura]]

# ADR-0001 — Stack inicial

Status: **PROPOSTA** (aguarda confirmação do proprietário)

## Decisão proposta
Monólito modular em TypeScript/Node 22, PostgreSQL 16, migrations SQL versionadas com checksum, driver `pg` (SQL explícito, necessário para RLS), testes com Vitest contra PostgreSQL real. React fica para quando houver telas.

## Alternativas consideradas
- ORM completo: esconde SQL de RLS e `set_config`; adiará para quando houver necessidade comprovada.
- Microserviços: sem justificativa de escala, isolamento ou equipe (spec §24).

## Consequências
Reversível: o SQL é portável dentro do PostgreSQL. Framework HTTP, fila, cloud e região **não** foram decididos (ver `PENDENCIAS.md`).
