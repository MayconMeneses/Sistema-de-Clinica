---
tags: [modulo]
projeto: Clínica One
atualizado: 2026-10-07
---

# Estoque

Volta: [[00 - Índice]] · [[04 - Arquitetura]]

Capability `inventory.core` (planos Gestão, Completa e Enterprise). Perfis: estoque, gerente de unidade, administrador e proprietário movimentam; auditor lê.

- **Itens** (nome, código opcional, unidade, estoque mínimo). Itens não são excluídos, só inativados. A unidade de medida não muda depois de criada.
- **Livro de movimentos imutável:** entrada (com custo opcional), saída e ajuste (o motivo é obrigatório). O **saldo é derivado** da soma. Erros se corrigem com um ajuste explicado, nunca editando o passado.
- **O saldo nunca fica negativo**, nem com saídas simultâneas: o banco trava o item e confere antes de gravar (testado com três saídas ao mesmo tempo).
- Quantidades com até 3 casas decimais. Idempotência por chave. Alerta de "Baixo" quando o saldo é menor ou igual ao mínimo.
- Pendente: lotes e validade, inventário por contagem, fornecedores e pedidos de compra, consumo ligado ao procedimento.

![[anexos/09-estoque-mobile.png|300]]
