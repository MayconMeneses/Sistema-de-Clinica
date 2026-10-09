# Backlog por fase

Legenda: ✅ IMPLEMENTADO e testado localmente · 🟡 PARCIAL · ⬜ PLANEJADO

## Fase 0
- 🟡 ADRs (0001 proposta, 0002 implementada, 0003 parcial, 0004 pendente), threat model, aceite
- ⬜ Personas, jornadas, mapa de dados, protótipos

## Fase 1 — Fundação (GATE: nenhum dado real antes de fechar)
- ✅ PostgreSQL, migrations, tenant context, RLS, testes negativos (dados e HTTP)
- ✅ Identidade da clínica: login, sessões revogáveis, troca de senha, suspensão imediata, rate limit
- ✅ Master com MFA (TOTP, uso único) e reautenticação em ações críticas; recuperação do MFA do proprietário
- ✅ RBAC deny-by-default; entitlements no backend; `tiss.billing` bloqueado
- ✅ Auditoria (clínica e plataforma) em ações sensíveis
- 🟡 Capabilities: faltam addons, quotas, feature flags, assinatura/inadimplência
- ✅ MFA (TOTP) para usuários da clínica; segredos cifrados em repouso; limitador de tentativas no banco
- ✅ Recuperação de senha por e-mail (link de uso único, 30 min, derruba sessões; em sandbox o link aparece no log do worker; envio real depende do provedor de e-mail)
- ⬜ Convite de usuário por e-mail, gestão de dispositivos (rotação da chave de cifragem: ✅ ver docs/OPERACAO-CHAVES.md)
- ⬜ Acesso de suporte temporário (justificado, limitado, revogável)
- ✅ Backup + restore em banco temporário com validação (`npm run drill`), reprova ao detectar perda
- 🟡 CI escrito (`.github/workflows/ci.yml`), **nunca executado no GitHub**
- ✅ Alertas de erro por Telegram (componente + clínica), comandos `/status /erros /clinicas /fila /silenciar /ativar /testar`, erros da tela (docs/ALERTAS.md); falta validar com o Telegram real
- ⬜ Canal de alerta por cliente (futuro); métricas/traces; backup agendado/criptografado fora do host, secrets/rotação, HTTPS/deploy

## Fase 2 — Operação clínica essencial
- ✅ Pacientes, agenda com conflito transacional, prontuário com assinatura/adendo, financeiro particular
- ✅ Unidades/salas/equipamentos, horário de atendimento, encaixe, bloqueios, séries semanais, lista de espera, fila da recepção (chegada→chamada→atendimento→conclusão)
- ✅ Formulários pré-consulta e triagem: modelos versionados (anamnese pronta + editor), paciente responde pelo portal ou a recepção preenche, respostas imutáveis lidas só por quem acessa o prontuário, triagem append-only, selos na fila da recepção (`docs/PORTAL.md`). Os modelos prontos precisam de revisão do profissional responsável
- 🟡 Recepção (falta checkout com pagamento)
- ✅ Responsáveis, detecção e revisão de duplicidade, mesclagem auditada, exportação do paciente, solicitações de privacidade (LGPD: ferramentas)
- ✅ Caixa (abertura/fechamento com conferência), descontos com aprovação, recibos numerados (não fiscais) — exigem o plano com financeiro avançado
- ✅ Agenda em visão de dia, semana e mês (contagem por dia calculada no banco)
- ✅ Sangria e suprimento do caixa (imutáveis, só com caixa aberto, entram no dinheiro esperado)
- ✅ Contas a pagar: lançamento, parcelas mensais, atraso/vence em breve, pagamento (com juros/desconto), cancelamento com motivo, imutáveis depois de pagas
- ✅ Comissões e repasses: percentual por profissional com histórico, produção (cobranças de atendimento/procedimento concluído), repasse calculado no servidor, sem sobreposição de períodos, anulação com motivo
- ✅ Anexos e documentos do paciente: PDF/PNG/JPG/WEBP até 5 MB, tipo conferido pelo conteúdo, SHA-256 verificado no download, histórico de acesso, sem exclusão (só arquivar com motivo)
- ⬜ Comissão sobre valor recebido (hoje é sobre produção), caixa por unidade

## Fase 3
- ✅ Odontograma com histórico imutável e plano de tratamento com cobrança
- ✅ Orçamento com versões e aceite registrado pela clínica (o aceite gera os itens do plano de tratamento)
- ✅ Imagens e radiografias: aba Imagens (PNG/JPG/WEBP até 5 MB, dente e data do exame, miniatura leve, filtro por dente, visualizador e comparação lado a lado), mesma segregação do prontuário e liberação opcional no portal. Falta: DICOM, zoom/medidas e ligar a imagem ao achado do odontograma
- ⬜ Próteses/laboratórios, repasses, assinatura eletrônica do aceite (provedor externo)
- ✅ Camada de integrações: outbox transacional, worker (retry/backoff/dead-letter), webhooks assinados, consentimento, adaptadores WhatsApp/e-mail/SMS (sandbox + real escrito), armazenamento local
- ⛔ Envio real: depende de escolher/contratar provedores e validar adaptadores (`docs/INTEGRACOES.md`)
- ⬜ Inbox, templates editáveis, automações, opt-out por resposta, portal inicial

## Fases 4–6
- ✅ Papéis: gerente de unidade, estoque, marketing e auditor interno
- ✅ Escopo por unidade do gerente na **agenda**: vínculo usuário↔unidade (gerente e profissional); o gerente vê e altera só consultas, salas, horários, bloqueios, lista de espera, recepção, painel e indicadores de atendimento das suas unidades; sem unidade vinculada, não vê nada
- ⬜ Escopo por unidade para pacientes, financeiro, estoque e CRM (hoje o gerente vê essas áreas da clínica inteira; indicadores dessas áreas ficam indisponíveis para ele)
- ✅ Estoque: itens, livro de movimentos imutável (entrada/saída/ajuste explicado), saldo derivado que nunca fica negativo, alerta de mínimo
- ✅ CRM: leads, funil (novo → contatado → agendado → paciente/perdido), histórico imutável, consentimento de marketing registrado, conversão em paciente com aviso de duplicidade
- ✅ Indicadores (BI básico): atendimentos, faltas, pacientes novos, financeiro, CRM e estoque, por período; cada seção respeita plano e perfil
- ✅ Estoque: lotes e validade (entrada com lote, saída pelo que vence antes, vencido não sai nem conta no mínimo, baixa por vencimento, alertas)
- ✅ Estoque: inventário por contagem (um aberto por vez, saldo fotografado ao contar, diferença vira ajuste explicado, perdas saem primeiro dos lotes que vencem antes)
- ✅ Estoque: fornecedores e pedidos de compra (rascunho → enviado → recebido em parte/total; recebimento entra no estoque com custo, lote e validade; teto de recebimento garantido pelo banco; numeração por clínica)
- ✅ Estoque: consumo ligado ao procedimento (kits por procedimento, baixa FEFO ao concluir o item do plano, falta de saldo vira pendência)
- ✅ CRM: agendar consulta direto do lead (converte em paciente e marca a consulta, tudo ou nada)
- ⬜ CRM: campanhas e envio (depende de provedor de mensagens)
- ✅ BI: exportação dos indicadores em CSV (Excel pt-BR, só agregados, respeita plano e perfil, auditada)
- ⬜ BI: catálogo de métricas versionado, comparação entre períodos, ocupação por sala/profissional
- ✅ **Pagamentos online (Mercado Pago):** Pix e link, confirmação por webhook assinado ou botão Verificar, conciliação com recibo, cancelamento e estorno; credenciais por clínica, cifradas. **Não validado com o Mercado Pago real** (roteiro em `docs/PAGAMENTOS.md`)
- ✅ Catálogo único de integrações (`src/integrations/catalog.ts`); portas e sandbox de **NFS-e** e **assinatura eletrônica** (adaptadores reais pendentes de decisão/contrato)
- ✅ Backup cifrado (`scripts/backup-encrypted.sh`) exercitado no CI; **sem agendamento nem destino em nuvem** (dependem do ambiente)
- ✅ Pagamentos: estorno parcial (cobrança segue paga até a soma devolvida fechar o valor; cada devolução é um movimento imutável; estorno feito direto no painel do provedor é conciliado)
- ✅ Pagamentos: parcelamento no cartão (link, até 12x, parcela mínima R$ 5,00)
- ⬜ Pagamentos: taxas do provedor, conciliação bancária
- ✅ Portal do paciente (link de uso único + data de nascimento; consultas, confirmação, cancelamento, pedidos e documentos liberados; docs/PORTAL.md). Falta: envio automático do link e agendamento com horários livres
- ⬜ Papéis da plataforma (Master), NFS-e, integrações reais, regulados, IA. Convênios/TISS: bloqueado globalmente.
- ✅ Cobrança dos clientes da plataforma: preço e limites por plano, combinado por cliente, faturas imutáveis, carência, suspensão e reativação por cobrança, aviso ao proprietário, limites de usuários/pacientes/arquivos (`docs/COBRANCA-E-SUPORTE.md`). Baixa é manual; falta gateway próprio da plataforma
- ✅ Acesso temporário do suporte: concedido pela clínica (≤ 24 h), somente leitura de equipe/unidades/atividades, imposto por RLS, com histórico visível à clínica
- ✅ Indicadores comparando meses (colunas, linha e variação)
- ✅ Escopo por unidade em pacientes (e tudo que depende deles), estoque e CRM; dados da clínica inteira (caixa, contas a pagar, compras, inventário geral) ficam fora do gerente de unidade. Regras em `src/server/scope-policy.ts`; teste falha se rota nova não for classificada
- ✅ Papéis da plataforma: administrador, gerência de clínicas, cobrança, suporte e auditor; gestão de operadores (`docs/COBRANCA-E-SUPORTE.md`)
- ✅ Dockerfile em 3 etapas, sem root, com `tini` e `HEALTHCHECK` (verificado construindo e rodando)
- 🟡 Teste de invasão: duas rodadas locais; o independente (terceiros) continua pendente
