#!/usr/bin/env bash
# Prepara o banco de demonstração e inicia o sistema. Usado pelo docker-compose; também roda fora do Docker
# (defina PGHOST, PGUSER e PGPASSWORD de um usuário administrador do PostgreSQL).
set -euo pipefail

# Esta imagem é de DEMONSTRAÇÃO (senhas de banco fixas de desenvolvimento, dados fictícios). Recusa iniciar como produção.
if [ "${NODE_ENV:-}" = "production" ]; then
  echo "Esta imagem é só para demonstração e usa senhas fixas de desenvolvimento: não a use com NODE_ENV=production." >&2
  exit 1
fi

: "${PGHOST:?defina PGHOST}"; : "${PGPASSWORD:?defina PGPASSWORD}"
export PGUSER="${PGUSER:-postgres}" PGPORT="${PGPORT:-5432}"
export DB="${DB_NAME:-clinica_one}"

echo "Aguardando o banco em $PGHOST:$PGPORT..."
for i in $(seq 1 60); do pg_isready -q -h "$PGHOST" -p "$PGPORT" && break; sleep 1; done
pg_isready -q -h "$PGHOST" -p "$PGPORT" || { echo "Banco indisponível"; exit 1; }

bash scripts/dev-db-setup.sh

base="$PGHOST:$PGPORT/$DB"
export DATABASE_URL_OWNER="postgres://clinica_owner:dev_owner_pw@$base"
export DATABASE_URL_APP="postgres://clinica_app:dev_app_pw@$base"
export DATABASE_URL_PLATFORM="postgres://clinica_platform:dev_platform_pw@$base"
export DATABASE_URL_WORKER="postgres://clinica_worker:dev_worker_pw@$base"

npm run db:migrate
if [ "${SEED_DEMO:-1}" = "1" ]; then npm run seed; fi

echo
echo "================================================================"
echo " Sistema no ar: http://localhost:${HOST_PORT:-${PORT:-3000}}   (dados FICTÍCIOS)"
echo " Acessos de demonstração: veja docs/ACESSO.md ou o bloco acima."
echo "================================================================"
exec npm start
