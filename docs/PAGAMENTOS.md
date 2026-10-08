# Pagamentos online (Mercado Pago)

**Estado:** montado de ponta a ponta e testado com um **Mercado Pago simulado** (servidor HTTP local) e com um modo de teste interno. **Não foi validado com o Mercado Pago real**: isso exige as credenciais da clínica. Faça o roteiro de validação abaixo antes de cobrar pacientes.

## O que o sistema faz
- Gera **Pix** (QR Code e “copia e cola”) ou **link de pagamento** (cartão, Pix ou saldo) para um paciente, na aba Financeiro da ficha.
- Confirma o pagamento **sozinho** (webhook do Mercado Pago) ou pelo botão **Verificar**. A tela do Pix também confere a cada 5 segundos.
- Ao confirmar, lança **um** movimento de pagamento no financeiro (imutável, com **recibo numerado**) e o saldo do paciente muda como em qualquer pagamento.
- **Estorno** (total ou parcial) pelo sistema: pede ao Mercado Pago e lança o estorno. Estorno feito direto no painel do Mercado Pago também chega pelo webhook e vira um movimento de estorno.
- **Cancelar** cobrança pendente. Se o paciente pagou no meio do caminho, o pagamento prevalece e é registrado.

## Como funciona por dentro (segurança e dinheiro)
- **Cada clínica usa a própria conta** (o dinheiro cai nela). O Access Token e o segredo do webhook ficam **cifrados** (AES-256-GCM, `DATA_ENCRYPTION_KEY`) em `payment_settings`; a API **nunca** os devolve (só os 4 últimos dígitos do token). Só o runtime da clínica lê (RLS), a plataforma e o worker não têm acesso.
- **Webhook** `POST /api/webhooks/mercadopago/<id da clínica>`: (1) valida a assinatura `x-signature` com o segredo daquela clínica (janela de 10 min); (2) **reconsulta o pagamento no Mercado Pago** com o token da clínica — o corpo da notificação não é confiável; (3) só aplica se a **referência** for o id da cobrança e o **valor** bater; senão grava auditoria (`payment.amount_mismatch` / `payment.reference_mismatch`) e não muda nada; (4) é idempotente (entrega repetida ou simultânea vale uma). Clínica inexistente, desligada ou sem segredo recebem a mesma resposta (503): não revela quais clínicas existem.
- **Idempotência de ponta a ponta:** o id da cobrança é derivado da chave de idempotência da tela. Repetir a chamada (duplo clique, falha de rede) cai na mesma cobrança e na mesma referência do provedor (`X-Idempotency-Key`). O provedor é chamado **antes** de gravar: se falhar, nada fica gravado.
- **Banco:** valor, paciente e forma da cobrança são imutáveis; estados finais são definitivos (`pending → approved|rejected|cancelled|expired`, `approved → refunded`); nada é apagado; pago exige o movimento financeiro ligado.
- **Perfis:** gerar/verificar/cancelar = recepção, financeiro, gerente, administrador, proprietário. **Estornar** = quem aprova (financeiro, gerente, administrador, proprietário). **Configurar** = proprietário e administrador. Plano com `payments.gateway` (Gestão, Completa, Enterprise: suposição de desenvolvimento).

## Como ligar (clínica)
1. No servidor, defina `PUBLIC_BASE_URL` (HTTPS, ex.: `https://clinica.exemplo.com.br`). Sem ela o sistema funciona, mas o Mercado Pago não consegue avisar e a confirmação é só pelo botão **Verificar**.
2. No Mercado Pago, em “Suas integrações”, crie um aplicativo e copie o **Access Token**. **Use primeiro o de TESTE.**
3. Em Webhooks, cadastre a URL mostrada em **Gestão → Pagamentos**, marque o evento **Pagamentos** e copie a **assinatura secreta**.
4. Em **Gestão → Pagamentos**, cole o token e o segredo, escolha **Mercado Pago** e salve.

## Roteiro para validar com o Mercado Pago real (ainda não feito)
1. Com credenciais de teste: gerar Pix de R$ 1,00, pagar com usuário de teste, conferir “Pago” e o recibo.
2. Gerar link de pagamento, pagar com cartão de teste, conferir.
3. Estornar pelo sistema e conferir o estorno no painel do Mercado Pago e no financeiro.
4. Estornar pelo painel do Mercado Pago e conferir que o sistema reflete (webhook).
5. Enviar a notificação de teste do painel (id fictício): o sistema deve responder 200 e ignorar.
6. Só então trocar para as credenciais de produção e repetir com R$ 1,00 real.
Se algo no formato da API divergir, o ajuste fica concentrado em `src/integrations/payments/mercadopago.ts`.

## Limitações conhecidas (honestas)
- Estorno parcial: veja a seção “Estorno parcial” abaixo.
- **Chargeback** é tratado como estorno.
- Sem cartão digitado no sistema (por segurança e escopo PCI): só link e Pix.
- Sem parcelamento configurável, sem repasse/conciliação bancária, sem NFS-e (ver `docs/INTEGRACOES.md`).
- O modo de teste interno guarda o estado só na memória do servidor: reiniciar apaga as cobranças simuladas pendentes.
- Taxas do Mercado Pago não são calculadas nem lançadas.

## Código
`src/integrations/payments/` (porta, adaptador Mercado Pago, sandbox, verificação de assinatura) · `src/modules/payments/service.ts` (conciliação) · `src/server/routes/payments.ts` e `routes/webhooks.ts` · `migrations/0014_payments.sql` · testes em `tests/payments.test.ts`.

## Estorno parcial

- **Estornar** aceita um valor (opcional). Sem valor, devolve tudo que resta; com valor, devolve só aquela parte. Pode ser repetido até a soma devolvida igualar o valor pago.
- Enquanto sobrar valor, a cobrança continua **Paga** (com a etiqueta "Estornado R$ x"); ao completar o valor ela vira **Estornada**.
- Cada devolução gera um movimento de estorno imutável no financeiro do paciente e uma linha em `payment_refunds`; o saldo em aberto do paciente volta a subir na mesma medida.
- A chave de idempotência enviada ao Mercado Pago depende do que já foi devolvido (`refund-<id>` no total; `refund-<id>-<já devolvido>-<valor>` no parcial): repetir o mesmo clique não devolve duas vezes.
- Devolução feita direto no painel do Mercado Pago é conciliada ao verificar/receber a notificação: o sistema lança só a diferença.
- Continua **não validado com o Mercado Pago real** (o parcial usa `POST /v1/payments/{id}/refunds` com `amount`, conforme a documentação; teste com credenciais de teste antes de usar).
