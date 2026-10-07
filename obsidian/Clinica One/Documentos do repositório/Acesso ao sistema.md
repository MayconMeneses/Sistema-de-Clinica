---
tags: [documento, repositorio]
projeto: Clínica One
atualizado: 2026-10-07
origem: docs/ACESSO.md
---

> Cópia de `docs/ACESSO.md`. Volta: [[00 - Índice]]

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
A primeira vez demora alguns minutos (baixa e monta tudo). Quando aparecer `Sistema no ar: http://localhost:3000`, abra **http://localhost:3000** no navegador.

Para parar: `Ctrl+C`. Para recomeçar do zero (apaga os dados de demonstração): `docker compose down -v`.

> **Estado desta opção:** a lógica do script de inicialização foi testada de ponta a ponta (cria banco, aplica as 8 migrations, cria dados de demonstração, sobe o sistema e o login responde). O **Docker em si não pôde ser executado** no ambiente onde o sistema foi construído (não há Docker lá). Se algo falhar ao rodar, me envie a mensagem de erro.

## Opção B: sem Docker (Node.js + PostgreSQL)
Requisitos: Node.js 22 e PostgreSQL 16 instalados. Veja `README.md` (seção "Rodar"): `npm install`, `npm run setup:dev`, `npm start`.

## Acessos de demonstração (todos fictícios)
| Quem | Endereço | Identificador da clínica | E-mail | Senha |
|---|---|---|---|---|
| Dono da clínica (vê tudo) | http://localhost:3000 | `demo` | `dono@demo.demo` | `Demo@12345` |
| Administradora | idem | `demo` | `anaadmin@demo.demo` | `Demo@12345` |
| Recepção | idem | `demo` | `ritarecepcao@demo.demo` | `Demo@12345` |
| Profissional (prontuário, odontograma) | idem | `demo` | `drpauloprofissional@demo.demo` | `Demo@12345` |
| Financeiro | idem | `demo` | `fabiofinanceiro@demo.demo` | `Demo@12345` |
| Consultório individual (plano Solo) | idem | `solo-demo` | `dono@solo-demo.demo` | `Demo@12345` |
| **Painel da plataforma (Master)** | http://localhost:3000/#/master | (não tem) | `master@demo.local` | `Demo@12345` + código MFA |

**Código MFA do Master** (só ele precisa): com Docker, rode em outro terminal `docker compose exec app npm run totp` e digite os 6 números. Cada código vale uma vez; se disser "já utilizado", espere 30 segundos e rode de novo. (Alternativa: cadastre em um app autenticador a chave que aparece nos registros de início: `docker compose logs app`.)

Essas senhas são **só de demonstração**. Nunca use este modo com dados reais de pacientes.

## Abrir no celular
Com o computador e o celular na mesma rede Wi-Fi, troque no `docker-compose.yml` a linha `"127.0.0.1:3000:3000"` por `"3000:3000"`, rode de novo e abra `http://<IP-do-computador>:3000` no celular. Atenção: qualquer pessoa da mesma rede conseguirá abrir a tela de login. O sistema é responsivo e pode ser "instalado" na tela inicial pelo menu do navegador.

## Para colocar na internet (pendente: depende de você)
Um endereço público exige decisões e contratações que ainda não foram feitas: provedor de nuvem e região, domínio, HTTPS, gerenciamento de segredos, backup agendado e criptografado, e a chave `DATA_ENCRYPTION_KEY` (veja `docs/AMBIENTE.md`). Também é necessária revisão de segurança e jurídica antes de qualquer dado real (veja `docs/ACEITE-FASE-1.md`). Posso preparar o deploy assim que o provedor for escolhido.
