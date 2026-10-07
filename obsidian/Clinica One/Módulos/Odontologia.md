---
tags: [modulo]
projeto: Clínica One
atualizado: 2026-10-07
---

# Odontologia

Volta: [[00 - Índice]] · [[04 - Arquitetura]]

Odontograma permanente (32) e decíduo (20) por face, com **histórico imutável** (o estado atual é o último evento); plano de tratamento com prioridade e valor; "concluir e cobrar" gera a cobrança uma única vez. ![[anexos/07c-odontograma-mobile.png|300]] Pendente: imagens/radiografias, próteses e laboratórios, repasses.

## Orçamento com versões e aceite (v0.9.0)
- Fluxo: **rascunho** (editável) → **apresentado** (congelado) → **aceito** ou **recusado**. Para mudar algo depois de apresentado, cria-se uma **nova versão**; ao apresentá-la, a anterior vira **substituída**. Só há um rascunho e uma versão apresentada por orçamento (garantido pelo banco).
- **Aceite** é registrado pela clínica: nome de quem aceitou, se foi o paciente ou o responsável legal, quem registrou e quando. Paciente menor de idade só aceita pelo responsável. Orçamento vencido não é aceito (gera-se nova versão). **Não é assinatura eletrônica**; essa depende de provedor externo.
- O aceite cria os itens do plano de tratamento (uma vez só, mesmo com aceites simultâneos). Recusa não cria nada.
- Itens e conteúdo apresentados são imutáveis no banco; nada é excluído. A exportação do paciente inclui os orçamentos.
- Pendente: assinatura eletrônica do aceite, impressão/PDF do orçamento, desconto dentro do orçamento, parcelamento.

![[07d-orcamento-mobile.png]]
