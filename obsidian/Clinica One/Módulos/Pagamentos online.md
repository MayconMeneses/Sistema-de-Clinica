---
tags: [modulo]
projeto: Clínica One
atualizado: 2026-10-07
---

# Pagamentos online (Mercado Pago)

Volta: [[00 - Índice]] · [[04 - Arquitetura]] · [[Módulos/Financeiro]]

**Estado:** montado de ponta a ponta e testado com um Mercado Pago **simulado**; **não validado com o Mercado Pago real** (falta a credencial da clínica). Guia completo e roteiro de validação: `docs/PAGAMENTOS.md`.

- Gera **Pix** (QR e copia e cola) ou **link de pagamento** na aba Financeiro do paciente. Confirmação por **webhook assinado** ou botão **Verificar**; a tela do Pix confere sozinha a cada 5 s.
- Ao confirmar: **um** pagamento lançado no financeiro, com **recibo numerado**. **Estorno** total pelo sistema, ou pelo painel do Mercado Pago (chega por webhook). Cancelar cobrança pendente; se o paciente já pagou, o pagamento prevalece.
- **Cada clínica usa a própria conta.** Access Token e segredo do webhook ficam **cifrados** e nunca voltam pela API.
- O webhook **reconsulta o pagamento no Mercado Pago**, confere **referência e valor** e é idempotente. Divergência vira auditoria, não pagamento.
- Perfis: gerar, verificar e cancelar (recepção, financeiro, gerente, admin, dono); estornar (quem aprova); configurar (dono e admin).
- Limites: só estorno total, sem parcelamento nem taxas, sem cartão digitado no sistema.
- Testes: `tests/payments.test.ts` (12 cenários, incluindo falhas do provedor e isolamento entre clínicas).

![[anexos/12-pagamento-online-mobile.png|300]] ![[anexos/12b-pagamentos-config-mobile.png|300]]
