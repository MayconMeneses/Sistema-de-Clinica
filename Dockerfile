# Imagem de DEMONSTRAÇÃO local. Não é uma imagem de produção (usa dados fictícios e senhas de desenvolvimento).
# Várias etapas: a final não leva testes, documentação, código-fonte do front nem ferramentas de build; roda sem root.

# ---- 1) dependências (cache separado: só muda quando o package-lock muda)
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- 2) build do front (e checagem de tipos)
FROM deps AS build
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN npx tsc --noEmit && npx tsc --noEmit -p web && npx vite build

# ---- 3) imagem final
FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client bash tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=development HOME=/home/node
# tsx executa o TypeScript do servidor (sem etapa de compilação do back); por isso as dependências vêm inteiras.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts ./scripts
COPY --from=build --chown=node:node /app/web/dist ./web/dist
# Windows pode converter quebras de linha (CRLF); o Linux do container precisa de LF
RUN sed -i "s/\r$//" scripts/*.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash", "scripts/docker-entrypoint.sh"]
