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
| `BILLING_AUTO` | `1` liga a rotina horária de faturas/inadimplência (padrão: desligada, cobrança só manual no painel) | O | `0` | operação | — |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | envio pela Cloud API | S / C | para ligar WhatsApp | operações | conforme provedor |
| `WHATSAPP_APP_SECRET` | valida assinatura do webhook da Meta | S | idem | operações | conforme provedor |
| `WHATSAPP_VERIFY_TOKEN` | handshake do webhook | S | idem | operações | semestral |
| `WHATSAPP_API_BASE` | URL base (teste) | P | não | engenharia | — |
| `EMAIL_API_URL`, `EMAIL_API_KEY`, `EMAIL_FROM` | e-mail transacional | C / S / P | para ligar e-mail | operações | conforme provedor |
| `SMS_API_URL`, `SMS_API_KEY`, `SMS_FROM` | SMS | C / S / P | para ligar SMS | operações | conforme provedor |
| `WEBHOOK_SECRET_GENERIC` | HMAC do webhook genérico | S | se usar | operações | semestral |
| `PUBLIC_BASE_URL` | endereço público HTTPS do sistema; monta a URL de notificação do Mercado Pago (`/api/webhooks/mercadopago/<clínica>`). Sem ela, a confirmação do pagamento é só pelo botão "Verificar" | P | para pagamentos online | operações | — |
| `MERCADOPAGO_API_BASE` | URL base da API do Mercado Pago (só para testes com servidor simulado) | P | não | engenharia | — |
| *(por clínica, não é variável)* Access Token e segredo do webhook do Mercado Pago | cifrados no banco (`payment_settings`) com `DATA_ENCRYPTION_KEY`; informados em Gestão → Pagamentos; **nunca** em variável nem no Git | S | por clínica | proprietário da clínica | conforme o Mercado Pago |
| `DEMO_SKIP_MASTER_MFA` | `1` dispensa o código MFA do Master (login e ações críticas). **Só demonstração local**; o sistema recusa iniciar em produção se estiver definida | P | não | engenharia | — |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_IDS` | alertas de erro e comandos de operação por Telegram (`docs/ALERTAS.md`). Ids separados por vírgula; só esses chats podem usar os comandos | S / C | para receber alertas | operações | se vazar, revogar no @BotFather (`/revoke`) |
| `ALERTS_ENV_LABEL`, `ALERTS_DEDUPE_MINUTES`, `TELEGRAM_API_BASE` | nome do ambiente nos avisos (padrão produção/desenvolvimento), janela de agrupamento de repetidos (5 min), URL base (só testes) | C / P | não | operações | — |
| `BACKUP_PASSPHRASE` | senha de cifra dos backups (`scripts/backup-encrypted.sh`); guardar num cofre FORA do servidor de banco | S | para backup | segurança | anual |
| `BACKUP_DIR`, `BACKUP_RETENTION_DAYS`, `BACKUP_DB`, `BACKUP_UPLOAD_CMD`, `BACKUP_UPLOAD_DEST` | destino local, retenção (14 dias), banco e envio para fora do host | C | para backup | operações | — |
| `STORAGE_LOCAL_DIR` | pasta do armazenamento local | C | se usar disco | engenharia | — |
| `DEMO_PASSWORD` | senha dos dados de demonstração | S (dev) | **proibido** (o seed recusa produção) | — | — |

Nunca usar dados de produção em testes; nunca copiar segredos de produção para fixtures.
