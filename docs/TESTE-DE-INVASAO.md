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
