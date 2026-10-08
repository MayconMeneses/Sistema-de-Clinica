# Auditoria de segurança — Clínica One (v0.12.1+)

> **Esta auditoria não prova que o sistema é seguro.** Foi uma revisão de código e testes automatizados com dados sintéticos, em ambiente local. Não houve teste de invasão externo, revisão por terceiros, teste de carga nem validação em ambiente de produção (que não existe). Nenhuma conformidade (LGPD, CFM, CFO) é declarada.
> Referências usadas: OWASP ASVS 5.0, WSTG, API Security Top 10 2023, recomendações de PostgreSQL, Node.js, Fastify, React e Docker.

## 1. Resumo executivo

**Estado inicial:** árvore de trabalho limpa (nada preexistente a preservar), branch `claude/wizardly-carson-xuhql2`, 43 commits.

**O que está bem (confirmado por teste, não só por documentação):**
- Isolamento entre clínicas: 51 tabelas com RLS habilitada e forçada, papéis de banco sem superusuário nem `BYPASSRLS`, contexto da clínica vindo da sessão e aplicado por transação. Uma varredura nova usa os ids reais de uma clínica em **todas** as rotas, autenticado como dono de outra clínica: nenhuma leitura ou escrita cruzada (mais de 500 chamadas).
- Toda rota autenticada exige sessão (401 sem sessão) e respeita o papel (403), e nenhuma devolve erro 5xx a entradas vazias ou inválidas.
- Webhooks: assinatura HMAC com comparação em tempo constante, janela de tempo, reconsulta ao provedor e idempotência.
- Sem vulnerabilidades conhecidas nas dependências (`npm audit`: 0), sem segredo real no código nem no histórico.

**Achados corrigidos nesta auditoria (13):** ver seção 3. Os mais relevantes: força do hash de senha abaixo do recomendado, ausência de limite por IP e por conta no código MFA, log de erro que poderia gravar valores de linhas do banco, exames e laudos visíveis à recepção, e backup cifrado sem autenticação do conteúdo.

**O que ainda impede uma conclusão segura (não é código):** não há hospedagem, HTTPS, backup agendado fora do host nem monitoramento reais; integrações externas só foram testadas em sandbox ou servidor falso; falta revisão jurídica; falta teste de invasão independente; o escopo por unidade cobre só a agenda.

## 2. Escopo e arquitetura confirmada
- **Stack (versões lidas do `package.json`):** Node 22, TypeScript 5, Fastify 5, `pg` 8, zod 4, React 19, Vite 7, Vitest 5, PostgreSQL 16 (CI e local), Docker/Compose, GitHub Actions.
- **Superfícies:** cerca de 160 rotas (API clínica, painel Master, auth, webhooks, telemetria), worker (fila de mensagens, bot do Telegram), frontend SPA (sem service worker; só `manifest`), scripts de backup e entrega.
- **Ambiente da auditoria:** máquina local de desenvolvimento (contêiner de nuvem), PostgreSQL local, dados 100% sintéticos, sem rede externa de terceiros.
- **Não validado:** Docker (o daemon não estava disponível para construir a imagem), produção, provedores reais (Mercado Pago, e-mail, WhatsApp, SMS), carga, histórico de acesso real.
- **Lint:** o projeto não tem linter configurado (não aplicável); a checagem de tipos estrita (`noUnusedLocals/Parameters`) foi usada no lugar.

## 3. Achados

Severidade: Crítica, Alta, Média, Baixa, Info. Confiança: Confirmado (reproduzido ou lido no caminho de execução).

| ID | Título | Sev. | Confiança | Estado |
|---|---|---|---|---|
| A-01 | `PATCH /api/patients/:id` sem campos respondia sucesso para qualquer id | Média | Confirmado | **Corrigido** |
| A-02 | Hash de senha com custo abaixo do recomendado (scrypt N=2^14, p=1) | Média | Confirmado | **Corrigido** |
| A-03 | Sem limite por IP (varredura de várias contas) nem por conta no código MFA (varredura de vários IPs) | Média | Confirmado | **Corrigido** |
| A-04 | Log de erro 500 gravava o objeto bruto do driver (`detail`/`where` trazem valores de linhas) | Média | Confirmado (por teste unitário do tratador) | **Corrigido** |
| A-05 | Exames e laudos (documentos) legíveis por recepção e administração, contra a segregação do prontuário | Média | Confirmado | **Corrigido** |
| A-06 | Backup cifrado em AES-CBC sem autenticação; verificação só por SHA-256 (refazível) e dispensável apagando o arquivo `.sha256` | Média | Confirmado | **Corrigido** (HMAC obrigatório) |
| A-07 | Administrador podia criar e alterar outros administradores (escalada lateral) | Baixa | Confirmado | **Corrigido** (só o proprietário) |
| A-08 | `/api/dashboard` contava pacientes para qualquer papel | Baixa | Confirmado | **Corrigido** |
| A-09 | `Login.tsx` lia `localStorage` sem proteção: navegador com armazenamento bloqueado quebrava a tela de entrada | Baixa | Confirmado | **Corrigido** |
| A-10 | `decryptSecret` aceitava segredo em claro também em produção (falha aberta) | Baixa | Confirmado | **Corrigido** (falha fechada em produção) |
| A-11 | Imagem Docker de demonstração poderia ser iniciada com `NODE_ENV=production` usando senhas fixas | Baixa | Confirmado | **Corrigido** (recusa iniciar) |
| A-12 | Contadores de limite de tentativa dos testes poderiam barrar o E2E que roda depois no mesmo banco (CI) | Info | Confirmado | **Corrigido** (limpeza ao final dos testes) |
| A-13 | `.gitignore`/`.dockerignore` sem padrões para dumps, backups, chaves e dados locais | Info | Confirmado | **Corrigido** |
| A-14 | Imagem Docker executa como root | Média | Confirmado | **Não aplicado** (ver abaixo) |
| A-15 | Leituras de prontuário registram na auditoria ids que não existem (ruído) | Baixa | Confirmado | Pendente |
| A-16 | Resposta de "Esqueci minha senha" é igual, mas o tempo de resposta pode diferir (usuário existente faz mais gravações) | Baixa | Provável | Pendente |
| A-17 | Ações do GitHub fixadas por tag (`@v4`), não por hash do commit | Baixa | Confirmado | Pendente (recomendação) |
| A-18 | Sem expiração por inatividade da sessão (só validade absoluta em horas) | Info | Confirmado | Decisão do proprietário |
| A-19 | Escopo por unidade só na agenda; pacientes, estoque, financeiro e CRM veem a clínica inteira | Média | Confirmado | Pendente (decisão do proprietário, ver BACKLOG) |
| A-20 | Atrás de proxy sem `TRUST_PROXY=1`, todos compartilham o mesmo IP e os limites por IP valem para todos | Info | Confirmado | Documentado |

### Evidência e correção por achado
- **A-01** `src/server/routes/patients.ts` (PATCH): com corpo vazio devolvia `{ok:true}` antes de consultar o banco. Agora confirma que o paciente existe (RLS limita à clínica) e devolve 404. Teste: `tests/security-regressions.test.ts`, `tests/cross-tenant-sweep.test.ts`. Ref.: ASVS V4, API1:2023.
- **A-02** `src/server/auth/password.ts`: parâmetros fixos no código, ignorando os do hash. Agora o custo atual é N=2^15, r=8, p=3 (~32 MiB, alinhado à tabela da OWASP Password Storage); os parâmetros vão no hash; hashes antigos continuam válidos e são recifrados no próximo login correto (clínica e Master); ao ler, N acima de 2^17 ou valores inválidos são recusados sem calcular (evita esgotar memória por valor adulterado). Teste: `tests/auth-hardening.test.ts`. Ref.: ASVS V2.4.
- **A-03** `src/server/routes/auth.ts`, `master.ts`: além do limite por IP+clínica+e-mail, agora há limite por IP (30 falhas/15 min, ajustável por `LOGIN_IP_MAX`) e, depois de acertar a senha, limite de 10 códigos MFA errados/15 min **por conta**, independente do IP. O contador de MFA só conta quem acertou a senha: errar a senha de alguém não trava a conta dele. Teste: `tests/auth-hardening.test.ts`. Ref.: ASVS V2.2, API2:2023, API4:2023.
- **A-04** `src/server/http.ts`: o tratador de erro registrava `{ err }` (o objeto do `pg` inclui `detail` e `where` com valores). Agora registra só o resumo higienizado e o arquivo:linha. Teste: `tests/security-regressions.test.ts`. Ref.: ASVS V7.
- **A-05** `src/server/routes/documents.ts`: categorias `exam` e `report` seguem `notes.read` (dono e profissional) para anexar, listar, baixar e arquivar; recepção e administração continuam com termos e documentos pessoais. Teste: `tests/documents.test.ts`. Ref.: ASVS V4.1, API5:2023.
- **A-06** `scripts/backup-encrypted.sh`: `.hmac` (HMAC-SHA256, chave derivada da senha com separação de domínio) conferido **antes** de decifrar; sem `.hmac` o backup é recusado (`BACKUP_ALLOW_LEGACY=1` aceita um backup antigo, com aviso). CI atualizado com três casos novos: adulteração no meio do arquivo com hash refeito, ausência do `.hmac` e senha errada. **Executado localmente: todos os casos recusaram como esperado e a restauração conferiu (9 pacientes na origem e no destino).** Observação: a chave do HMAC passa pela linha de comando do `openssl` durante o cálculo (visível a quem lista processos no mesmo servidor); em produção prefira um mecanismo com criptografia autenticada (age/GPG AEAD) ou o cofre do provedor.
- **A-07, A-08, A-09, A-10, A-11** pequenas correções, cada uma com teste ou verificação em `tests/security-regressions.test.ts` e `scripts/docker-entrypoint.sh`.
- **A-14 (não aplicado, por quê):** o `Dockerfile` roda como root. Corrigir exige `USER node` com ajuste de posse dos arquivos, e **não consegui construir a imagem aqui** (sem daemon do Docker). Aplicar sem testar poderia derrubar a atualização automática da demonstração. Alteração proposta:
  ```dockerfile
  WORKDIR /app
  RUN chown node:node /app
  USER node
  COPY --chown=node:node package.json package-lock.json ./
  RUN npm ci
  COPY --chown=node:node . .
  RUN sed -i "s/\r$//" scripts/*.sh && npm run build
  ```
  Testar com `docker build` e `docker compose up` antes de publicar.
- **A-15** `GET /api/patients/:id/notes` e similares gravam `record.read` mesmo para paciente inexistente. Sem vazamento (a auditoria é da própria clínica), só ruído. Correção sugerida: auditar apenas quando o paciente existe.
- **A-16** pode-se igualar o tempo gravando sempre (usuário fictício) ou respondendo de forma assíncrona. Risco baixo; não corrigido.

## 4. Vazamentos e segredos
| Tipo | Local | Situação |
|---|---|---|
| Token de bot com formato do Telegram | `tests/alerts.test.ts` (uma ocorrência, mascarada aqui) e um único commit no histórico | **Valor fictício de teste**, uma só variante no histórico inteiro, escrito antes de o token real existir (não comparei os valores para não expô-los). Nenhuma evidência de que seja o token real. Nenhuma rotação necessária. Se houver dúvida, revogue o token real no BotFather. |
| Senhas de banco de desenvolvimento (`dev_*_pw`) | `scripts/*.sh`, `src/server/config.ts`, `docker-entrypoint.sh` | Só desenvolvimento/demonstração; em produção o servidor exige variáveis (`url()` lança erro) e a imagem de demonstração recusa `NODE_ENV=production`. |
| Chave de cifra de desenvolvimento fixa | `src/server/config.ts` | Só fora de produção; em produção `DATA_ENCRYPTION_KEY` é obrigatória. Não protege nada em demonstração (documentado). |
| Senha de demonstração (`Demo@12345`) | `scripts/seed-demo.ts`, docs | Dados fictícios de demonstração. |
| Arquivos `.env` | histórico Git | Só `.env.example` (sem valores reais). |
| Chaves privadas, tokens de nuvem, mapas de código | repositório e build | Nenhum encontrado; `sourcemap: false`. |
| Dados de pacientes em logs/telemetria/alertas | `src/ops/alerts.ts`, `http.ts` | Higienizados (`scrub`); log de erro corrigido (A-04). |
O token real do Telegram e a chave real de cifra **não** estão no repositório. Eles ficam no `.env` local do usuário, fora do Git.

## 5. Código morto
- **Removido (confirmado sem uso por busca em todo o repositório e testes depois):** `verifyTotp` (`src/server/auth/totp.ts`), `resetAlertsForTests` (`src/ops/alerts.ts`), importação de tipo sem uso em `tests/api.test.ts`.
- **Verificados sem achado:** dependências declaradas (todas usadas; `@types/*` e `typescript` são de tipos/ferramenta), tabelas criadas pelas migrations (todas referenciadas), arquivos TS sem importador (nenhum), scripts do `package.json` (todos existem), `noUnusedLocals/Parameters` (limpo).
- **Candidatos para revisão (não removidos):** as portas `nfse.ts` e `signature.ts` e o armazenamento `storage.ts` só têm sandbox e testes e nenhuma rota os usa ainda (são pontos de extensão previstos para NFS-e, assinatura eletrônica e arquivos), e vários `export` usados só no próprio arquivo (tipos).
- **Não foi possível determinar:** o conteúdo de `obsidian/` (notas e capturas de tela de demonstração); é documentação, não código, e duplica parte de `docs/`.

## 6. Alterações realizadas (arquivos)
`src/server/auth/password.ts`, `routes/auth.ts`, `routes/master.ts`, `routes/patients.ts`, `routes/documents.ts`, `routes/team.ts`, `http.ts`, `crypto.ts`, `context.ts` (registro de rotas para teste), `auth/totp.ts`, `ops/alerts.ts`; `web/src/pages/Login.tsx`, `Documents.tsx`, `Patients.tsx`; `scripts/backup-encrypted.sh`, `scripts/docker-entrypoint.sh`; `.github/workflows/ci.yml`; `.gitignore`, `.dockerignore`; `vitest.config.ts`, `tests/global-setup.ts`; testes novos `route-matrix`, `cross-tenant-sweep`, `auth-hardening`, `security-regressions`; ajustes em `documents.test.ts` e `api.test.ts`. Nenhuma tentativa falhou ou ficou incompleta; a imagem Docker não foi alterada (A-14).

## 7. Validações executadas
| Verificação | Resultado |
|---|---|
| `tsc` do servidor e do web (modo estrito + `noUnusedLocals/Parameters`) | Executado e aprovado |
| `npm test` (PostgreSQL real) | Executado e aprovado: **264 testes, 29 arquivos** |
| E2E no Chromium (celular e desktop, incl. novos fluxos) | Executado e aprovado |
| `npm run build` | Executado e aprovado |
| `npm audit` (inclui dev) | Executado e aprovado: 0 vulnerabilidades |
| Backup cifrado: cifra, verificação, senha errada, adulteração, sem HMAC, restauração | Executado localmente e aprovado |
| Varredura de segredos no código e no histórico Git | Executado: só o valor fictício de teste |
| Lint | Não aplicável (não configurado) |
| `docker build` / execução da imagem | **Não executado** (sem daemon) |
| Teste em produção/homologação, carga, invasão externo | **Não executado / não existe** |

## 8. Pendências e próximos passos
1. Aplicar e testar o `Dockerfile` sem root (A-14).
2. Decidir como ligar pacientes, estoque e CRM a unidades (A-19).
3. Antes de dados reais: hospedagem com HTTPS, `TRUST_PROXY=1`, `NODE_ENV=production`, `DATA_ENCRYPTION_KEY` e senhas de banco próprias em cofre, backup agendado fora do host com a senha em cofre separado, monitoramento.
4. Fixar as ações do GitHub por hash (A-17) e ligar o Dependabot.
5. Teste de invasão independente e revisão jurídica (`docs/juridico/`).
6. Validar com credenciais de teste os provedores reais (Mercado Pago, e-mail).
