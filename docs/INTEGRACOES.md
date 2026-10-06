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
| Integração | Porta | Sandbox | Adaptador real | Validado com o provedor real | O que falta |
|---|---|---|---|---|---|
| WhatsApp (Meta Cloud API) | ✅ | ✅ | ✅ escrito | ❌ | credenciais, número verificado, **templates aprovados** com os nomes `appointment_*`, webhook da Meta |
| E-mail transacional | ✅ | ✅ | ✅ genérico (POST JSON + Bearer) | ❌ | escolher provedor, domínio/SPF/DKIM; ajustar o formato do corpo ao provedor |
| SMS | ✅ | ✅ | ✅ genérico | ❌ | escolher provedor e ajustar o formato |
| Armazenamento de arquivos | ✅ | — | ✅ disco local (isolado por tenant, sem path traversal) | n/a | trocar por S3-compatível (mesma porta); rota de upload com validação de tipo/tamanho/antivírus ainda não existe |
| Pagamentos (Pix/cartão) | ⬜ | ⬜ | ⬜ | ❌ | **decisão do gateway**; porta, cobrança, webhook de confirmação |
| Calendários (Google/Microsoft) | ⬜ | ⬜ | ⬜ | ❌ | OAuth, escopos |
| NFS-e | ⬜ | ⬜ | ⬜ | ❌ | **decisão do município/provedor** |
| Assinatura eletrônica | ⬜ | ⬜ | ⬜ | ❌ | provedor e regras profissionais (validar) |
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
