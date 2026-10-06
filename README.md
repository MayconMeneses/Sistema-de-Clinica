# Clínica One — plataforma SaaS de gestão clínica

**Versão 0.7.0 · funcional em ambiente de desenvolvimento · NÃO pronta para produção nem para dados reais de pacientes.**
Interface em português do Brasil, **mobile-first** (menu inferior no celular, barra lateral no desktop, instalável na tela inicial).
Convênios/TISS estão bloqueados globalmente nesta fase.

## Rodar (requer Node 22 e PostgreSQL 16 locais)

```bash
npm install
npm run setup:dev     # cria banco + papéis de DEV, aplica migrations, cria dados DEMO fictícios e gera o frontend
npm start             # http://localhost:3000   (PORT=3100 npm start para outra porta)
```

O `npm run seed` imprime os acessos de demonstração (todos fictícios, **somente desenvolvimento**):

| Ambiente | Como entrar |
|---|---|
| Clínica demo (plano Completa) | identificador `demo` · `dono@demo.demo`, `anaadmin@demo.demo`, `ritarecepcao@demo.demo`, `drpauloprofissional@demo.demo`, `fabiofinanceiro@demo.demo` · senha `Demo@12345` |
| Consultório Solo (plano Solo) | identificador `solo-demo` · `dono@solo-demo.demo` |
| Painel Master (plataforma) | abrir `/#/master` · `master@demo.local` · senha `Demo@12345` · **código MFA**: `npm run totp` (ou cadastre o segredo impresso pelo seed em um app autenticador) |

Para testar no celular, abra `http://<IP-da-máquina>:3000` na mesma rede (cookies `Secure` só são exigidos em produção/HTTPS).

## Comandos

| Comando | O que faz |
|---|---|
| `npm run check` | typecheck (servidor + web) e 134 testes (PostgreSQL real) |
| `npm run drill` | backup → restore em banco temporário → valida dados, RLS e isolamento (reprova se algo divergir) |
| `npm run build` | typecheck + build do frontend em `web/dist` |
| `npm run e2e` | smoke no Chromium em celular e desktop (`E2E_URL=http://127.0.0.1:3000`), com screenshots |
| `npm run dev:server` / `npm run dev:web` | desenvolvimento com recarga (web em :5173 com proxy para a API) |
| `npm run totp` | código MFA atual do operador demo |

## O que funciona (IMPLEMENTADO e testado localmente)

**Painel Master** — login com senha + MFA (TOTP, cada código vale uma vez); criar clínica com proprietário; trocar plano; suspender/reativar (exige novo código MFA + justificativa); conceder/bloquear funcionalidades por clínica (o banco recusa habilitar `tiss.billing`); auditoria da plataforma. Recupera o MFA do proprietário que perdeu o aparelho (exige MFA + justificativa; só mexe em MFA/sessão). O Master **não lê** dados clínicos, senhas nem segredos (sem privilégio no banco, provado em teste).

**Sistema da clínica** — login por clínica; sessões server-side revogáveis; troca de senha encerra outras sessões; suspender usuário derruba sessões na hora.
- Pacientes: cadastro, busca, edição, alerta clínico (visível só à equipe clínica); **aviso de cadastro parecido** (documento, nome+nascimento, telefone+primeiro nome; normaliza acento, máscara e +55 no banco); **revisão de duplicados e mesclagem auditada** (nada é apagado: prontuário assinado e financeiro permanecem e aparecem no cadastro principal); **responsáveis**; **exportação dos dados** (respeita as permissões de quem exporta e é auditada); **solicitações de privacidade** do titular com prazo de referência de 15 dias e fila na Gestão.
- Agenda: dia/profissional, agendar, confirmar, reagendar, cancelar com motivo, faltou. **Conflito de profissional, paciente e sala decidido pelo PostgreSQL** (restrição de exclusão), inclusive sob concorrência. Horário de atendimento por profissional (fora dele só como **encaixe**, pela recepção), **bloqueios** (feriado, folga, manutenção; o banco recusa agendar sobre eles), **séries semanais** (tudo-ou-nada ou pulando datas com conflito) e **lista de espera**.
- Recepção: fila do dia com chegada (com prioridade), chamada, atendimento e conclusão; atualiza sozinha; concluir gera a cobrança uma única vez.
- Gestão: unidades, salas/cadeiras/equipamentos, horários e bloqueios.
- Prontuário: rascunho, assinatura, **assinado é imutável**, correção só por adendo com justificativa, leitura auditada, texto preservado no aparelho até salvar.
- Financeiro particular: cobrança, pagamento (Pix/cartão/dinheiro), estorno limitado ao pago, saldo derivado de movimentos imutáveis, valores em centavos, lançamento idempotente; concluir consulta gera a cobrança uma única vez.
- Equipe: criar usuário, suspender/reativar, redefinir senha e 2 etapas, trilha de auditoria.
- **Verificação em duas etapas (TOTP)** para usuários da clínica: ativar/desativar pela conta (no celular, o link abre o app autenticador), exigida no login, código de uso único; segredos **cifrados em repouso** (AES-256-GCM).
- **Comunicação com o paciente** (plano Essencial ou superior): autorização por canal (WhatsApp, e-mail, SMS) com histórico; ao agendar, remarcar ou cancelar, a mensagem entra numa **outbox transacional** e o worker envia (hoje em **sandbox**, simulado) com retry, backoff e dead-letter; lembrete 24 h antes; histórico no paciente; webhooks de entrega assinados. Painel de Integrações no Master. Detalhes e o que falta conectar: `docs/INTEGRACOES.md`.
- **Odontologia** (plano Completa/Enterprise): odontograma permanente (32) e decíduo (20) por face, **histórico imutável** (estado atual = último evento), leitura auditada; plano de tratamento com prioridade e valor, "concluir e cobrar" gera a cobrança uma única vez. Só profissional registra; proprietário lê.
- RBAC deny-by-default (recepção não acessa prontuário) e entitlements por plano/override, decididos **no backend**.

**Fundação** — PostgreSQL com RLS forçado, tenant vindo da sessão, FKs compostas, três papéis sem BYPASSRLS, migrations com checksum, auditoria append-only, limitador de tentativas compartilhado no banco, backup/restore validado por script, workflow de CI (`.github/workflows/ci.yml`).

## Configuração por ambiente
| Variável | Uso |
|---|---|
| `DATABASE_URL_APP`, `DATABASE_URL_PLATFORM`, `DATABASE_URL_OWNER` | conexões (papéis distintos; ver `.env.example`) — obrigatórias em produção |
| `DATA_ENCRYPTION_KEY` | chave de 32 bytes em base64 para cifrar segredos TOTP (`openssl rand -base64 32`) — **obrigatória em produção**; em dev usa uma chave fixa que não protege nada |
| `TRUST_PROXY=1` | atrás de proxy reverso, para o IP real nos limites e na auditoria |
| `NODE_ENV=production` | cookies `Secure`, HSTS, sem valores padrão de dev |

## O que NÃO existe ainda
Portal do paciente · orçamento odontológico com aceite, imagens/radiografias, próteses · envio **real** de WhatsApp/e-mail/SMS (depende de contratar provedor; já está montado em sandbox) · CRM · estoque · BI · NFS-e · integrações · recuperação de senha por e-mail (depende de provedor de e-mail) · acesso de suporte temporário · observabilidade · deploy/HTTPS. O CI está **escrito mas ainda não foi executado** no GitHub. Veja `docs/BACKLOG.md`.

## Documentos
`docs/CONFORMIDADE.md` (matriz contra o prompt mestre) · `docs/INTEGRACOES.md` · `docs/AMBIENTE.md` · `docs/BACKLOG.md` · `docs/THREAT-MODEL.md` · `docs/ACEITE-FASE-1.md` · `docs/adr/`

## Antes de qualquer uso real
Leia `docs/ACEITE-FASE-1.md` e `docs/THREAT-MODEL.md`. Pendências de decisão: `PENDENCIAS.md`. Nenhuma conformidade (LGPD, CFM, CFO) é declarada; exige revisão especializada.
