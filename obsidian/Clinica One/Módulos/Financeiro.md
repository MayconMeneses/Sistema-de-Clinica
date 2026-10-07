---
tags: [modulo]
projeto: Clínica One
atualizado: 2026-10-07
---

# Financeiro

Volta: [[00 - Índice]] · [[04 - Arquitetura]]

Cobrança, pagamento (Pix/cartão/dinheiro como forma registrada, sem gateway), estorno limitado ao pago; movimentos imutáveis e saldo derivado; centavos; idempotência. 
## Caixa, descontos e recibos (v0.8.0, plano com financeiro avançado)
- **Caixa:** um aberto por clínica (garantido pelo banco). Dinheiro só entra ou sai com o caixa aberto; Pix e cartão ficam ligados ao caixa aberto. Esperado = abertura + dinheiro recebido − dinheiro devolvido. Se o contado difere, a observação é obrigatória. Caixa fechado é imutável e o banco recusa lançamentos nele.
- **Descontos:** quem tem permissão de lançar pede; financeiro, administrador ou proprietário aprova. Quem pediu não aprova o próprio (exceção: proprietário, fica na auditoria). O valor não passa do saldo em aberto, revalidado na aprovação. Vira um movimento `discount` imutável.
- **Recibos:** número sequencial por clínica, só para pagamentos, tela para imprimir/salvar em PDF. **Não é documento fiscal.**
- Pendente: contas a pagar, conciliação, comissões/repasses, sangria/suprimento, caixa por unidade, NFS-e (terceiro), gateway de pagamento (decisão do proprietário).

![[08-caixa-mobile.png]]
![[08b-descontos-mobile.png]]
![[08c-recibo-mobile.png]]
