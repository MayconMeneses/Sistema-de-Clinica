---
tags: [modulo]
projeto: Clínica One
atualizado: 2026-10-07
---

# Identidade e MFA

Volta: [[00 - Índice]] · [[04 - Arquitetura]]

Login por clínica, sessões revogáveis (trocar senha ou suspender usuário derruba as sessões), MFA TOTP opcional na clínica (link `otpauth://` abre o app autenticador no celular), redefinição de MFA pelo administrador; proprietário recuperado pelo Master (MFA + justificativa). Decisão: [[Decisões/0003-identidade]]. Pendente: convite e recuperação de senha por e-mail (precisa de provedor), códigos de recuperação.
