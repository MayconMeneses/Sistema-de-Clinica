# Cobrança dos clientes e acesso do suporte

## Cobrança da plataforma (assinatura e inadimplência)
Faturas da plataforma **não** são o financeiro da clínica: ficam no plano de controle (`platform_invoices`) e cada clínica lê só as próprias (RLS).

- **Preço e limites** por plano (Plataforma › Cobrança › Planos): mensalidade, máx. de usuários ativos, pacientes e MB de arquivos. Vazio = sem preço / sem limite (nada muda para quem não configurar). Alterar exige MFA e justificativa.
- **Combinado por cliente**: valor próprio (0 = isento), dia de vencimento (1–28) e carência em dias.
- **Faturas**: "Gerar faturas do mês" cria uma por clínica e mês (idempotente) para quem tem preço. "Dar baixa" registra Pix/boleto/cartão/transferência; "Anular" exige motivo. Fatura paga ou anulada é definitiva (trigger no banco); valores e vencimento nunca mudam; nada é excluído.
- **Inadimplência**: até o vencimento, em dia; depois, "atrasada" (a clínica vê aviso em todas as telas, só o proprietário); passando da carência, "Avaliar inadimplência" suspende a clínica. **Pagar (ou anular) a fatura reativa sozinho, mas só se a suspensão foi por cobrança** — suspensão manual nunca é desfeita pela cobrança.
- **Rotina automática**: `BILLING_AUTO=1` gera as faturas e avalia a inadimplência a cada hora, com registro na auditoria da plataforma. Desligada por padrão.
- **Limites** barram só **novos** cadastros (usuários, pacientes, arquivos) com a mensagem "Limite do plano atingido"; o que existe continua. A checagem não é serializada entre requisições simultâneas: pode haver ultrapassagem pequena sob concorrência.
- A clínica vê plano, mensalidade, uso versus limite e faturas em **Gestão › Assinatura** (somente proprietário).

**Não há cobrança automática por cartão/Pix da plataforma**: a baixa é manual. Integrar um gateway (ex.: o Mercado Pago já usado nos pagamentos da clínica) exige conta própria da plataforma e validação real — não feito.

## Acesso temporário do suporte
Por padrão, o papel da plataforma **não enxerga nada** de uma clínica além do diretório e do que o Painel Master já mostra (proprietário, plano, integrações).

1. O **proprietário** libera em Gestão › Assinatura › Acesso do suporte: de 1 a 24 horas, com motivo. Uma concessão ativa por vez; ele pode encerrar antes.
2. Durante a concessão, o operador (com **MFA e justificativa**) abre Plataforma › Suporte e vê **somente**: equipe (nome, e-mail, perfil, situação, 2 etapas), unidades e as últimas 50 atividades (ação e tipo, sem metadados).
3. **Nunca** pacientes, prontuário, financeiro, mensagens, documentos. Isso é imposto no banco: as políticas RLS de `users`, `units` e `audit_events` para o papel da plataforma só valem com concessão ativa (`support_grant_active`), e `audit_events` só expõe colunas sem metadados; as tabelas clínicas não têm acesso algum.
4. Cada abertura grava `support_access_log` (visível para a clínica, imutável) e a auditoria da plataforma. A concessão só pode ser revogada, nunca estendida ou apagada.

Isto **não é "entrar como a clínica"** (impersonação): propositalmente não existe, para o suporte nunca agir em nome de um usuário nem tocar dado clínico.
