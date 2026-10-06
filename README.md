# Clínica One — plataforma SaaS de gestão clínica

**Versão 0.3.0 · funcional em ambiente de desenvolvimento · NÃO pronta para produção nem para dados reais de pacientes.**
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
| `npm run check` | typecheck (servidor + web) e 59 testes (PostgreSQL real) |
| `npm run build` | typecheck + build do frontend em `web/dist` |
| `npm run e2e` | smoke no Chromium em celular e desktop (`E2E_URL=http://127.0.0.1:3000`), com screenshots |
| `npm run dev:server` / `npm run dev:web` | desenvolvimento com recarga (web em :5173 com proxy para a API) |
| `npm run totp` | código MFA atual do operador demo |

## O que funciona (IMPLEMENTADO e testado localmente)

**Painel Master** — login com senha + MFA (TOTP); criar clínica com proprietário; trocar plano; suspender/reativar (exige novo código MFA + justificativa); conceder/bloquear funcionalidades por clínica (o banco recusa habilitar `tiss.billing`); auditoria da plataforma. O Master **não lê** dados clínicos (sem privilégio no banco).

**Sistema da clínica** — login por clínica; sessões server-side revogáveis; troca de senha encerra outras sessões; suspender usuário derruba sessões na hora.
- Pacientes: cadastro, busca, edição, alerta clínico (visível só à equipe clínica).
- Agenda: dia/profissional, agendar, confirmar, chegada, concluir, faltou, reagendar, cancelar com motivo. **Conflito de horário decidido pelo PostgreSQL** (restrição de exclusão), inclusive sob concorrência.
- Prontuário: rascunho, assinatura, **assinado é imutável**, correção só por adendo com justificativa, leitura auditada, texto preservado no aparelho até salvar.
- Financeiro particular: cobrança, pagamento (Pix/cartão/dinheiro), estorno limitado ao pago, saldo derivado de movimentos imutáveis, valores em centavos, lançamento idempotente; concluir consulta gera a cobrança uma única vez.
- Equipe: criar usuário, suspender/reativar, redefinir senha, trilha de auditoria.
- RBAC deny-by-default (recepção não acessa prontuário) e entitlements por plano/override, decididos **no backend**.

**Fundação** — PostgreSQL com RLS forçado, tenant vindo da sessão, FKs compostas, três papéis sem BYPASSRLS, migrations com checksum, auditoria append-only.

## O que NÃO existe ainda
Portal do paciente · odontologia · WhatsApp/e-mail/SMS · CRM · estoque · BI · NFS-e · integrações · cadastro de MFA para usuários da clínica · recuperação de senha por e-mail · acesso de suporte temporário · CI · backup/restore testado · observabilidade · deploy/HTTPS. Veja `docs/BACKLOG.md`.

## Antes de qualquer uso real
Leia `docs/ACEITE-FASE-1.md` e `docs/THREAT-MODEL.md`. Pendências de decisão: `PENDENCIAS.md`. Nenhuma conformidade (LGPD, CFM, CFO) é declarada; exige revisão especializada.
