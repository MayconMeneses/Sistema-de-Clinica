# ADR-0003 — Identidade e sessões

Status: **PLANEJADA** — nada implementado.

Requisitos (spec §29): sessões server-side revogáveis com versão de sessão, cookies HttpOnly/Secure/SameSite, MFA obrigatório para o Master, reautenticação em ações críticas, troca de senha revoga sessões, usuário suspenso perde acesso imediatamente.
Opções a comparar antes de decidir: provedor externo de identidade vs. implementação própria (custo, lock-in, região, MFA). Decisão pendente do proprietário.
