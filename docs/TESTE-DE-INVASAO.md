# Teste de invasão local (roteiro WSTG)

> **Isto NÃO é um teste de invasão independente.** Quem escreveu o sistema também escreveu estes testes, e eles só cobrem o que o roteiro prevê. Um teste de invasão de terceiros continua necessário antes de dados reais. O valor desta bateria é ser **repetível**: roda em cada mudança (`tests/pentest.test.ts`, `tests/fuzz-routes.test.ts`, `tests/route-matrix.test.ts`, `tests/cross-tenant-sweep.test.ts` e o teste de navegador).

**Regras seguidas:** só o servidor local, só clínicas e dados sintéticos, sem força bruta intensa, sem negação de serviço, sem rede externa, sem tocar em nada de terceiros.

## O que foi testado
| Área (OWASP WSTG) | O que se tentou | Resultado |
|---|---|---|
| INFO/CONF | cabeçalhos de segurança em página, API e 404; vazamento de tecnologia (`server`, `x-powered-by`); cache da API | Aprovado |
| CONF | 20 caminhos para arquivos expostos (`.env`, `.git`, `package.json`, código, migrations, `docker-compose`, mapas, travessia de diretório com `..`, `%2e%2e`, `%2f`, `\`) | Aprovado: nenhum conteúdo servido |
| CONF | métodos `TRACE`/`OPTIONS`/`DELETE` indevidos; CORS com origem estrangeira e pré-voo | Aprovado: sem CORS |
| ATHN | enumeração de clínica/usuário no login (mensagens e códigos idênticos); flags do cookie (`HttpOnly`, `SameSite=Strict`, `Path`) | Aprovado |
| SESS | 12 formas de cookie adulterado, de outra clínica, vazio, truncado, com `NUL`, enorme ou com id inexistente; reutilização do cookie depois do logout; segredo novo a cada login; sessão de clínica no painel Master | Aprovado |
| CSRF | `POST` sem cabeçalho, com origem estrangeira, com origem `null`, como formulário e como `text/plain` | Aprovado: nada foi criado |
| INPV | injeção de SQL em buscas/filtros com 10 cargas (inclusive `pg_sleep`); `%` e `_` tratados como texto; dados e papéis intactos depois | Aprovado |
| INPV | XSS armazenado (`<img onerror>`, `<script>`, `<svg onload>`): resposta é JSON com `nosniff`; no navegador o texto aparece literal e nada executa | Aprovado |
| ATHZ | atribuição em massa (`tenant_id`, `id`, `created_by`, `merged_into`, `role`); recepção virando dono; criar dono | Aprovado: campos ignorados ou recusados |
| ATHZ | acesso entre clínicas por id em todas as rotas (mais de 500 chamadas) | Aprovado |
| INPV | upload: executável como PDF, SVG com script, HTML, shell, ZIP, nome com `../` e `filename*=` | Aprovado |
| INPV | webhooks: sem assinatura, assinatura forjada, repetição fora da janela, provedor desconhecido, id inválido | Aprovado |
| INPV | fuzz de **todas** as rotas: 14 campos × 12 valores hostis (byte nulo, 70 mil caracteres, números enormes, objetos, datas impossíveis, SQL) e 8 parâmetros de URL × 8 valores | Aprovado depois das correções abaixo |
| ERRH | ids inválidos em rotas de leitura: sem 500 e sem pilha, caminho ou SQL na resposta | Aprovado |

## Falhas encontradas e corrigidas
1. **Byte nulo (`\u0000`) em qualquer texto causava erro 500** (o PostgreSQL recusa e o erro não era tratado). Agora o servidor recusa com 400 antes de chegar ao banco (`src/server/app.ts`, `http.ts`).
2. **Data impossível (`2024-13-45`) no cadastro de paciente causava erro 500.** Agora a data é validada de verdade (e limitada entre 1900 e 2100) e qualquer erro de dado do PostgreSQL vira 400 (`patients.ts`, `http.ts`).
3. **Nome de arquivo baixado mantinha `..`** (sem risco de gravação, porque o nome é só um texto de cabeçalho, mas é desnecessário). Agora é normalizado (`documents.ts`).
(As correções da auditoria anterior continuam valendo: veja `docs/AUDITORIA-SEGURANCA.md`.)

## Não coberto (precisa de terceiros ou de ambiente real)
- Teste de invasão por equipe independente, com tentativa de evasão criativa e engenharia social.
- Infraestrutura real: TLS, proxy reverso, nuvem, rede, isolamento do contêiner, DNS.
- Negação de serviço e carga (proibidos aqui).
- Provedores externos reais (Mercado Pago, e-mail, WhatsApp).
- Ataques físicos, phishing de usuários e roubo de dispositivo.

---

# Rodada 2 (local, ainda não independente)

> **Continua não sendo um teste independente.** Mesma autoria, mesmo ambiente. Mudou o método: em vez de seguir o roteiro WSTG, esta rodada é **diferencial** (a mesma chamada com todos os papéis, comparada com a tabela de permissões) e ataca o banco diretamente com o papel da plataforma. Roda em cada mudança: `tests/pentest2.test.ts`.

| Alvo | O que se tentou | Resultado |
|---|---|---|
| Painel da plataforma | **todas** as rotas master × 5 papéis (admin, clínicas, cobrança, suporte, auditor): 403 exatamente onde a tabela nega, nunca 5xx; sem sessão sempre 401 | Aprovado (mais de 70 combinações) |
| Sessões | cookie da clínica no painel e cookie do painel na clínica | Aprovado: 401 nos dois sentidos |
| Banco × suporte | com a concessão ativa, o papel da plataforma lê equipe/unidades/atividades, mas `password_hash`, `totp_secret`, `metadata` e `entity_id` são negados; 15 tabelas clínicas/financeiras/de sessão negadas; não cria, reabre nem apaga concessão ou histórico; clínica sem concessão invisível | Aprovado |
| Escopo por unidade | gerente de uma unidade contra **todas** as rotas de paciente usando um paciente de outra unidade (guardiões, consentimentos, privacidade, documentos, portal, formulários, triagem, financeiro, mensagens) e por corpo (agenda, lista de espera, cobrança): sempre 404, sem vazar o nome | Aprovado |
| Formulários | `__proto__`, `constructor`, operadores estilo NoSQL, listas no lugar de texto, opção fora da lista, 5.000 caracteres, `NUL`, `1e999`; modelo com id reservado, opções repetidas, 61 campos, campo extra | Aprovado: 4xx sem 500, nenhum objeto poluído |
| Cobrança e suporte | horas 0/-1/1,5/"2"/25/null/1e9; prazo enviado pelo cliente (ignorado: o servidor decide); valores negativos/fracionários/em texto; dia de vencimento 0/29/-3; período com SQL | Aprovado |
| Dependências | `npm audit --omit=dev` | 0 vulnerabilidades |
| Segredos | busca por chaves e senhas fixas no código | Nada encontrado fora dos valores de desenvolvimento |

## O que a construção desta rodada revelou (já corrigido)
1. **Lista de espera e pedidos do portal vazavam nome de paciente de outra unidade** quando o registro não tinha profissional/consulta. Agora seguem a visibilidade do paciente.
2. **Aviso de duplicidade ao cadastrar paciente** revelaria nome e nascimento de pacientes de outras unidades para o gerente. Agora o aviso considera só os pacientes que ele enxerga.
3. A primeira versão da função que libera leitura ao suporte usava `SECURITY DEFINER` e, com RLS forçado, **nunca enxergava a concessão** (falha segura, mas inútil); virou `SECURITY INVOKER`.

## Continua fora do alcance
Tudo o que a primeira rodada já listava (equipe independente, infraestrutura real, carga, provedores reais), mais: a imagem Docker final só foi verificada com um PostgreSQL de base e sem o passo `apt` (a rede deste ambiente bloqueia os repositórios Debian).
