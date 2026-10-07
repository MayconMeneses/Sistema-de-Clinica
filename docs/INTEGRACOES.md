# Integrações — o que está pronto e o que falta conectar

Princípio: tudo que depende de terceiros fica atrás de uma **porta** (interface) com adaptador de **sandbox** (funciona sem rede) e adaptador **real** (escrito, aguardando credenciais). Trocar do sandbox para o real é configurar variáveis de ambiente e mudar o modo da clínica no Painel Master — sem alterar código de negócio.

## Como o envio funciona (já operante em sandbox)
1. Agenda grava a mensagem na **outbox** (`outbox_events`) **na mesma transação** da consulta. Falhou a consulta → nada enfileirado.
2. Só enfileira com plano que inclua `communication.inbox`. Sem **consentimento vigente** + contato, grava `skipped (no_consent)` para a clínica ver o motivo.
3. O **worker** (`npm run worker`, ou embutido no servidor em dev) reivindica eventos com `FOR UPDATE SKIP LOCKED`, relê paciente/consentimento/consulta **no momento do envio** e só então chama o adaptador. Consentimento revogado ou consulta alterada → `skipped`.
4. Falha transitória (rede, timeout, 429, 5xx, provedor sem credencial): backoff exponencial com jitter (30 s × 2ⁿ, teto 1 h, ±50 %), até 6 tentativas. Falha definitiva (4xx) ou tentativas esgotadas → **dead-letter**; o Master recoloca na fila (exige MFA + justificativa) sem ver o conteúdo.
5. **Webhooks** de entrega: assinatura HMAC sobre o corpo bruto, janela de 5 min (formato genérico), deduplicação por evento, tolerância a eventos fora de ordem, status que nunca regride, dead-letter após 5 tentativas.
6. Entrega: pelo menos uma vez; o id do evento vai como `Idempotency-Key` ao provedor.

## Estado por integração
O **catálogo único** está em `src/integrations/catalog.ts` (o Painel Master mostra o mesmo conteúdo): para cada integração, o que já está montado, as variáveis que faltam e o que depende de decisão ou contrato.

| Integração | Porta | Sandbox | Adaptador real | Validado com o provedor real | O que falta |
|---|---|---|---|---|---|
| WhatsApp (Meta Cloud API) | ✅ | ✅ | ✅ escrito | ❌ | credenciais, número verificado, **templates aprovados** com os nomes `appointment_*`, webhook da Meta |
| E-mail transacional | ✅ | ✅ | ✅ genérico (POST JSON + Bearer) | ❌ | escolher provedor, domínio/SPF/DKIM; ajustar o formato do corpo ao provedor |
| SMS | ✅ | ✅ | ✅ genérico | ❌ | escolher provedor e ajustar o formato |
| Alertas de erro (Telegram) | ✅ | ✅ | ✅ escrito | ❌ | criar o bot no @BotFather e informar `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_IDS` (docs/ALERTAS.md) |
| **Pagamentos online (Mercado Pago)** | ✅ | ✅ | ✅ escrito (Pix, link, consulta, cancelamento, estorno, webhook assinado) | ❌ | **credenciais de cada clínica** (Access Token e segredo do webhook em Gestão → Pagamentos), `PUBLIC_BASE_URL`, roteiro de validação em `docs/PAGAMENTOS.md` |
| NFS-e | ✅ porta (`src/integrations/nfse.ts`) | ✅ | ⬜ | ❌ | **município/provedor da prefeitura**, certificado digital, regime tributário, código de serviço; ligar ao recibo |
| Assinatura eletrônica | ✅ porta (`src/integrations/signature.ts`) | ✅ | ⬜ | ❌ | provedor, nível de assinatura e validade jurídica (validar com especialista); ligar ao aceite do orçamento |
| Armazenamento de arquivos | ✅ | — | ✅ disco local (isolado por tenant, sem path traversal) | n/a | adaptador S3-compatível (mesma porta); rota de upload com validação de tipo/tamanho/antivírus |
| Backup cifrado | — | — | ✅ `scripts/backup-encrypted.sh` (cifra, verifica, restaura; exercitado no CI) | ❌ | nuvem/região, agendamento, cofre da senha, papel de backup (ver cabeçalho do script) |
| Calendários (Google/Microsoft) | ⬜ | ⬜ | ⬜ | ❌ | OAuth, escopos |
| Error tracking / métricas | ⬜ | — | ⬜ | ❌ | escolher ferramenta |

`validado com o provedor real = ❌` significa: o adaptador foi testado contra um servidor HTTP falso local (classificação de erros, timeout, idempotência, formato da requisição), **não** contra o serviço verdadeiro.

## Para ligar um canal em produção (checklist)
1. Definir as variáveis em `docs/AMBIENTE.md` no gerenciador de segredos do ambiente (nunca no Git).
2. Configurar o webhook do provedor para `POST /api/webhooks/<provedor>` (`whatsapp` ou `generic`) com o segredo correspondente.
3. No Painel Master → clínica → Canais de mensagem → "Usar produção" (o sistema recusa se faltar credencial).
4. Enviar uma mensagem de teste a um número de equipe e conferir entrega no histórico do paciente.
5. Rodar o worker como processo separado (`WORKER_INLINE=0 npm start` + `npm run worker`) e monitorar a fila no Painel Master.

## Pendências de regra de negócio antes do uso real
Base legal e texto do consentimento (LGPD) revisados por especialista; janela de contato permitida; resposta "SAIR" (opt-out por mensagem de entrada) ainda **não** implementada; política de retenção das mensagens.
