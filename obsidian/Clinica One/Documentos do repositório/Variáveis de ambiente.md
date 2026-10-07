---
tags: [documento, repositorio]
projeto: Clínica One
atualizado: 2026-10-07
origem: docs/AMBIENTE.md
---

> Cópia de `docs/AMBIENTE.md`. Volta: [[00 - Índice]]

# Inventário de variáveis de ambiente (spec §40)

Sensibilidade: **S** = segredo (nunca no Git/log/front) · **C** = configuração sensível · **P** = pública. Os valores `dev_*` do repositório são só de desenvolvimento local.

| Variável | Finalidade | Sens. | Obrigatória em produção | Owner | Rotação |
|---|---|---|---|---|---|
| `NODE_ENV` | `production` liga cookies Secure, HSTS e exige as variáveis abaixo | P | sim | engenharia | — |
| `PORT`, `HOST` | endereço de escuta | P | não | engenharia | — |
| `TRUST_PROXY` | `1` atrás de proxy reverso (IP real nos limites/auditoria) | P | se houver proxy | engenharia | — |
| `LOG_LEVEL` | nível de log | P | não | engenharia | — |
| `DATABASE_URL_APP` | runtime da clínica (sem BYPASSRLS) | S | sim | engenharia | trimestral |
| `DATABASE_URL_PLATFORM` | control plane (Painel Master) | S | sim | engenharia | trimestral |
| `DATABASE_URL_WORKER` | worker da outbox (só `outbox_events`/`webhook_receipts`) | S | sim | engenharia | trimestral |
| `DATABASE_URL_OWNER` | migrations (usar só no deploy) | S | no deploy | engenharia | trimestral |
| `DATA_ENCRYPTION_KEY` | AES-256-GCM dos segredos TOTP (32 bytes base64) | S | **sim** | segurança | anual + plano de recifragem (ainda não implementado) |
| `WORKER_INLINE` | `0` desliga o worker embutido | P | `0` | engenharia | — |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | envio pela Cloud API | S / C | para ligar WhatsApp | operações | conforme provedor |
| `WHATSAPP_APP_SECRET` | valida assinatura do webhook da Meta | S | idem | operações | conforme provedor |
| `WHATSAPP_VERIFY_TOKEN` | handshake do webhook | S | idem | operações | semestral |
| `WHATSAPP_API_BASE` | URL base (teste) | P | não | engenharia | — |
| `EMAIL_API_URL`, `EMAIL_API_KEY`, `EMAIL_FROM` | e-mail transacional | C / S / P | para ligar e-mail | operações | conforme provedor |
| `SMS_API_URL`, `SMS_API_KEY`, `SMS_FROM` | SMS | C / S / P | para ligar SMS | operações | conforme provedor |
| `WEBHOOK_SECRET_GENERIC` | HMAC do webhook genérico | S | se usar | operações | semestral |
| `STORAGE_LOCAL_DIR` | pasta do armazenamento local | C | se usar disco | engenharia | — |
| `DEMO_PASSWORD` | senha dos dados de demonstração | S (dev) | **proibido** (o seed recusa produção) | — | — |

Nunca usar dados de produção em testes; nunca copiar segredos de produção para fixtures.
