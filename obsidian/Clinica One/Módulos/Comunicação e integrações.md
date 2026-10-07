---
tags: [modulo]
projeto: Clínica One
atualizado: 2026-10-07
---

# Comunicação e integrações

Volta: [[00 - Índice]] · [[04 - Arquitetura]]

Outbox transacional + worker (retry com backoff e jitter, dead-letter), consentimento por canal, confirmação/lembrete 24h/cancelamento/remarcação, webhooks de entrega, adaptadores WhatsApp/e-mail/SMS (sandbox + real escrito, **não validado** com provedor), armazenamento local isolado por tenant. ![[anexos/06c-mensagens-mobile.png|300]] Guia completo: [[Documentos do repositório/Integrações]] e variáveis em [[Documentos do repositório/Variáveis de ambiente]].
