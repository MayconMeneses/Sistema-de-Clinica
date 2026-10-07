# Como acessar o sistema

## Onde ele está agora (importante)
O sistema roda **somente dentro do ambiente de desenvolvimento em nuvem** onde foi construído. Esse ambiente é temporário e **não tem endereço público**: não existe um link que você possa abrir. Para ver o sistema funcionando, ele precisa rodar no **seu computador** (passo a passo abaixo) ou em um servidor que você contratar (pendente: depende de decisões suas, veja o fim deste arquivo).

## Opção A (recomendada): Docker, um comando
Requisitos: [Docker Desktop](https://www.docker.com/products/docker-desktop/) instalado e aberto (Windows, Mac ou Linux) e o Git.

```bash
git clone https://github.com/MayconMeneses/Sistema-de-Clinica.git
cd Sistema-de-Clinica
git checkout claude/wizardly-carson-xuhql2
docker compose up --build
```
A primeira vez demora alguns minutos (baixa e monta tudo). Quando aparecer `Sistema no ar: http://localhost:3010`, abra **http://localhost:3010** no navegador.

Para parar: `Ctrl+C`. Para recomeçar do zero (apaga os dados de demonstração): `docker compose down -v`.

> **Estado desta opção:** a lógica do script de inicialização foi testada de ponta a ponta (cria banco, aplica as 8 migrations, cria dados de demonstração, sobe o sistema e o login responde). O **Docker em si não pôde ser executado** no ambiente onde o sistema foi construído (não há Docker lá). Se algo falhar ao rodar, me envie a mensagem de erro.

### Problemas comuns com o Docker
- **`error getting credentials - err: exit status 1`** ao baixar a imagem do PostgreSQL: o "ajudante de credenciais" do Docker (`credsStore` em `~/.docker/config.json`) está quebrado ou indisponível. A imagem é pública e não precisa de login. Confirme que o Docker está rodando (`docker info`); depois faça `cp ~/.docker/config.json ~/.docker/config.json.bak` e `sed -i '/"credsStore"/d' ~/.docker/config.json` (ou `mv ~/.docker/config.json ~/.docker/config.json.bak`) e rode `docker compose up --build` de novo.
- **`Cannot connect to the Docker daemon`**: o Docker não está aberto. Abra o Docker Desktop (no WSL, ative a integração com a sua distribuição em Settings > Resources > WSL integration).
- **`port is already allocated` (3000)**: outra coisa usa a porta 3000. No `docker-compose.yml`, troque `"127.0.0.1:3000:3000"` por `"127.0.0.1:3001:3000"` e abra `http://localhost:3001`.
- **`docker: 'compose' is not a docker command`**: Docker antigo. Atualize o Docker Desktop ou use `docker-compose up --build` (com hífen).
- **A tela de login diz "Clínica, e-mail ou senha inválidos"**: confirme o identificador `demo` e o e-mail completo (`dono@demo.demo`). Se rodou com `SEED_DEMO=0`, os dados de demonstração não existem.

## Opção B: sem Docker (Node.js + PostgreSQL)
Requisitos: Node.js 22 e PostgreSQL 16 instalados. Veja `README.md` (seção "Rodar"): `npm install`, `npm run setup:dev`, `npm start`.

## Acessos de demonstração (todos fictícios)
| Quem | Endereço | Identificador da clínica | E-mail | Senha |
|---|---|---|---|---|
| Dono da clínica (vê tudo) | http://localhost:3010 | `demo` | `dono@demo.demo` | `Demo@12345` |
| Administradora | idem | `demo` | `anaadmin@demo.demo` | `Demo@12345` |
| Recepção | idem | `demo` | `ritarecepcao@demo.demo` | `Demo@12345` |
| Profissional (prontuário, odontograma) | idem | `demo` | `drpauloprofissional@demo.demo` | `Demo@12345` |
| Financeiro | idem | `demo` | `fabiofinanceiro@demo.demo` | `Demo@12345` |
| Gerente de unidade | idem | `demo` | `gabigerente@demo.demo` | `Demo@12345` |
| Estoque | idem | `demo` | `eduestoque@demo.demo` | `Demo@12345` |
| Marketing | idem | `demo` | `martamarketing@demo.demo` | `Demo@12345` |
| Auditor interno (só leitura) | idem | `demo` | `alineauditoria@demo.demo` | `Demo@12345` |
| Consultório individual (plano Solo) | idem | `solo-demo` | `dono@solo-demo.demo` | `Demo@12345` |
| **Painel da plataforma (Master)** | http://localhost:3010/#/master | (não tem) | `master@demo.local` | `Demo@12345` (sem código no modo demonstração) |

**Master sem código (modo demonstração):** os `docker-compose` de demonstração ligam `DEMO_SKIP_MASTER_MFA=1`, então o Master entra só com e-mail e senha, e as ações críticas também dispensam o código. Isso existe só para uso local com dados fictícios (a porta só abre neste computador). Em produção o sistema **recusa iniciar** se essa variável estiver definida, e o código MFA é obrigatório. Para voltar a exigir o código no Docker local, apague a linha `DEMO_SKIP_MASTER_MFA` do compose; o código sai de `docker compose exec -e DATABASE_URL_PLATFORM=postgres://clinica_platform:dev_platform_pw@db:5432/clinica_one app npm run totp`.

Essas senhas são **só de demonstração**. Nunca use este modo com dados reais de pacientes.

## Abrir no celular
Com o computador e o celular na mesma rede Wi-Fi, troque no `docker-compose.yml` a linha `"127.0.0.1:3000:3000"` por `"3000:3000"`, rode de novo e abra `http://<IP-do-computador>:3000` no celular. Atenção: qualquer pessoa da mesma rede conseguirá abrir a tela de login. O sistema é responsivo e pode ser "instalado" na tela inicial pelo menu do navegador.

## Para colocar na internet (pendente: depende de você)
Um endereço público exige decisões e contratações que ainda não foram feitas: provedor de nuvem e região, domínio, HTTPS, gerenciamento de segredos, backup agendado e criptografado, e a chave `DATA_ENCRYPTION_KEY` (veja `docs/AMBIENTE.md`). Também é necessária revisão de segurança e jurídica antes de qualquer dado real (veja `docs/ACEITE-FASE-1.md`). Posso preparar o deploy assim que o provedor for escolhido.

## A porta já está em uso (o endereço abre outro projeto)

O sistema usa a porta **3010** do seu computador, para não esbarrar em projetos que usam a 3000. Se a 3010 também estiver ocupada, escolha outra:

```bash
APP_PORT=3020 docker compose up --build
```

Depois abra `http://localhost:3020` (troque o número nos endereços deste guia).

## Erro `invalid option name ... set: pipefail` ao subir

Acontece no Windows quando o Git converte os scripts `.sh` para quebra de linha CRLF. Já está corrigido (`.gitattributes` e limpeza na imagem). Atualize e suba de novo:

```powershell
git pull origin claude/wizardly-carson-xuhql2
docker compose up --build
```

## Atualização automática

Há duas camadas, e as duas funcionam sem você fazer nada depois de configurar:

1. **App aberto ou instalado (celular/navegador):** a cada minuto o app consulta `/api/version`. Quando o servidor recebe uma versão nova, o app recarrega sozinho. Para não perder o que você está digitando, ele espera sair do campo de texto.
2. **Servidor (Docker):** a cada push que passa nos testes, o GitHub publica a imagem `ghcr.io/mayconmeneses/sistema-de-clinica:latest`. Suba com a versão automática:

```powershell
docker compose down
docker compose -f docker-compose.auto.yml up -d
```

O vigia (Watchtower) confere a cada 5 minutos, baixa a imagem nova e reinicia o sistema. O banco fica preservado. **Antes, torne o pacote público uma vez** (passos no cabeçalho de `docker-compose.auto.yml`). Sem isso o download é negado.

Estado: configurado, **ainda não validado de ponta a ponta** (a publicação no GitHub e o Watchtower só rodam no seu GitHub e no seu Docker). Quando fizer a primeira atualização, me diga se funcionou. Para atualizar manualmente a qualquer hora: `docker compose -f docker-compose.auto.yml pull && docker compose -f docker-compose.auto.yml up -d`.

### Erro `client version 1.25 is too old` no atualizador

O Watchtower original (`containrrr`) não funciona com o Docker mais novo. O arquivo `docker-compose.auto.yml` agora usa o fork mantido `nickfedor/watchtower`. Se aparecer esse erro, atualize e suba de novo:

```powershell
git pull origin claude/wizardly-carson-xuhql2
docker compose -f docker-compose.auto.yml up -d
```
