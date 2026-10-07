# Alertas de erro e comandos de operação (Telegram)

O sistema avisa a equipe da plataforma no Telegram quando algo dá errado, dizendo **qual sistema/componente** e **qual clínica (cliente)**. O mesmo bot aceita **comandos** para consultar a saúde do sistema.

> **Estado:** escrito e testado contra um servidor Telegram falso (`tests/alerts.test.ts`). **Não foi validado com o Telegram de verdade**: falta o token do bot e o id do chat (passo a passo abaixo). Usa a API oficial de bots (`sendMessage` e `getUpdates`, sem precisar de endereço público).

## Como ligar (5 minutos)

1. No Telegram, abra o **@BotFather**, envie `/newbot`, escolha nome e usuário. Ele devolve o **token** (guarde como senha; nunca no Git nem no chat).
2. Abra a conversa com o seu bot novo e envie `/start`. O bot responde "Este chat não está autorizado. Seu id é `123456789`": esse número é o seu **chat id**. (Para um grupo: adicione o bot ao grupo, envie `/start` lá e use o id, que começa com `-`.)
3. Informe as variáveis e reinicie o sistema:
   - Docker (`docker-compose.auto.yml`): crie um arquivo `.env` ao lado dele com
     ```
     TELEGRAM_BOT_TOKEN=123456:ABC...
     TELEGRAM_CHAT_IDS=123456789
     ALERTS_ENV_LABEL=produção
     ```
     e rode `docker compose -f docker-compose.auto.yml up -d`.
   - Vários chats: separe por vírgula (`TELEGRAM_CHAT_IDS=123456789,-100987654321`).
4. Envie `/testar` ao bot: deve chegar "Teste de alerta". Se o token vazar, revogue no @BotFather (`/revoke`).

Sem token e chat: em desenvolvimento os avisos ficam só na memória (sandbox); em produção o canal fica desligado (o sistema funciona igual, só não avisa).

## O que gera um aviso

| Aviso | Quando | Componente |
|---|---|---|
| 🔴 Erro interno (500) | qualquer erro inesperado numa requisição (inclui a clínica e a **rota como padrão**, ex.: `POST /api/patients/:id`) | `api` |
| 🔴 Falha fatal | exceção não tratada: o processo reinicia | `api` / `worker` |
| 🔴 Banco não responde (e 🔵 voltou) | verificação a cada minuto no worker | `banco` |
| 🟠 Worker falhando repetidamente | 3 ciclos seguidos com erro | `worker` |
| 🟠 Mensagens esgotaram as tentativas | WhatsApp/e-mail/SMS foram para a fila de falhas | `mensageria` |
| 🟠 Webhooks sem correspondência | notificações do gateway não conciliadas | `pagamentos` |
| 🟠 Erro na tela do usuário | `window.onerror`/promessa rejeitada no navegador (até 3 por aba, 5/min por IP) | `web` |
| 🔵 Novo cliente / suspenso / reativado / encerrado / trocou de plano | ações no Painel Master | `clientes` |

Cada aviso mostra: gravidade, componente, ambiente, título, **clínica** (nome + início do id), rota e hora (Brasília).

## Comandos (só nos chats de `TELEGRAM_CHAT_IDS`)

| Comando | O que faz |
|---|---|
| `/status` | banco, versão, tempo no ar, clínicas ativas, fila, se os avisos estão silenciados |
| `/erros` | últimos 10 erros desde que o sistema ligou |
| `/clinicas` | clientes por situação (ativas/suspensas/encerradas) |
| `/fila` | fila de mensagens e webhooks por situação |
| `/silenciar N` | silencia avisos não críticos por N minutos (1–1440); **críticos continuam** |
| `/ativar` | volta a receber tudo |
| `/testar` | envia um aviso de teste |
| `/ajuda` | lista os comandos |

Quem não está na lista não executa nada; um `/start` de estranho só devolve o id do próprio chat (no máximo uma vez por hora).

## O que um aviso NUNCA contém

Dados de paciente, SQL, stack trace, tokens, senhas, e-mails, CPF, URLs com parâmetros. Todo texto passa por higienização (`scrub`): e-mails, CPFs, ids, URLs, segredos longos e números longos viram `[email]`, `[cpf]`, `[id]`, `[url]`… A rota aparece como padrão, nunca como a URL real. Coberto por testes.

## Controle de volume

- **Agrupamento:** o mesmo erro (mesmo componente + rota + título) só avisa a cada 5 min (`ALERTS_DEDUPE_MINUTES`); o aviso seguinte informa "repetido Nx".
- **Trava de enxurrada:** no máximo 20 avisos em 10 min; passado disso sai um único "Muitos alertas" e o resto fica em `/erros`.
- Falhas ao alertar nunca derrubam o sistema.

## Funcionamento técnico

- Código: `src/integrations/alerts/telegram.ts` (cliente e transporte), `src/ops/alerts.ts` (Notifier, higienização, agrupamento), `src/ops/telegram-bot.ts` (comandos), ganchos em `src/server/http.ts`, `context.ts`, `routes/master.ts`, `routes/telemetry.ts` e `src/worker/main.ts`.
- Estado (silêncio e posição do bot) em `ops_alert_state` (migração 0015), sem dados de clínica. O worker lê só `tenant_directory` (slug/situação) para nomear clientes.
- O bot lê mensagens por *long polling* **no worker** (um único leitor; o Telegram recusa dois). Em desenvolvimento/Docker o worker roda junto do servidor.

## Futuros clientes

Hoje o canal é **da plataforma** (equipe que opera o sistema), e todo aviso já traz o nome da clínica. Para o futuro, a estrutura já separa componente e clínica, então dá para:
1. dar a cada cliente um canal próprio (cada clínica cadastra o seu bot/grupo, token cifrado como as demais credenciais por clínica) e rotear só os avisos dela;
2. comandos por cliente (`/clinica <nome> status`);
3. avisos de ciclo de vida (já existem: novo cliente, suspensão, troca de plano) alimentando um painel de saúde por cliente.
Nada disso depende de mudança no formato dos avisos.
