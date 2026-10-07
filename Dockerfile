# Imagem de DEMONSTRAÇÃO local. Não é uma imagem de produção (usa dados fictícios e senhas de desenvolvimento).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client bash && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["bash", "scripts/docker-entrypoint.sh"]
