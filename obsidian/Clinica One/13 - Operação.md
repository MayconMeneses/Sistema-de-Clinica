---
tags: [operacao]
projeto: Clínica One
atualizado: 2026-10-07
---


# Operação

Volta: [[00 - Índice]] · [[02 - Como acessar]] · [[Documentos do repositório/Variáveis de ambiente]].

| Comando | Para quê |
|---|---|
| `docker compose up --build` | sobe banco + sistema com dados de demonstração |
| `npm run setup:dev` | (sem Docker) banco, migrations, seed e build |
| `npm start` | servidor (worker embutido em desenvolvimento) |
| `npm run worker` | worker separado (produção) |
| `npm run check` | typecheck + 134 testes |
| `npm run e2e` | teste de navegador (celular e desktop) |
| `npm run drill` | backup → restore → validação |
| `npm run totp` | código MFA do Master (demonstração) |

Observação do ambiente de construção: o PostgreSQL é reiniciado entre sessões; se aparecer "connection refused": `pg_ctlcluster 16 main start`.
