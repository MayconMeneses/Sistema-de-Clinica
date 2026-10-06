#!/usr/bin/env bash
# Prepara banco e papéis LOCAIS de desenvolvimento/teste. Não usar em produção.
# Acesso superuser: variáveis PG* padrão (PGHOST, PGUSER, PGPASSWORD...) se PGHOST estiver definida (ex.: CI);
# caso contrário usa `su postgres` (PostgreSQL local).
set -euo pipefail

DB=${DB:-clinica_one}
if [ -n "${PGHOST:-}" ]; then
  sup() { psql -v ON_ERROR_STOP=1 -q "$@"; }
else
  sup() { su postgres -c "psql -v ON_ERROR_STOP=1 -q $(printf '%q ' "$@")"; }
fi

role_sql() {
  cat <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$1') THEN
    CREATE ROLE $1 LOGIN PASSWORD '$2' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END \$\$;
SQL
}

{ role_sql clinica_owner dev_owner_pw; role_sql clinica_app dev_app_pw; role_sql clinica_platform dev_platform_pw; role_sql clinica_worker dev_worker_pw; } | sup -d postgres -f -

if [ "$(sup -d postgres -tA -c "SELECT 1 FROM pg_database WHERE datname='$DB'")" != "1" ]; then
  sup -d postgres -c "CREATE DATABASE $DB OWNER clinica_owner"
fi
sup -d "$DB" -c "REVOKE ALL ON DATABASE $DB FROM PUBLIC; GRANT CONNECT ON DATABASE $DB TO clinica_app, clinica_platform, clinica_worker; ALTER SCHEMA public OWNER TO clinica_owner; REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO clinica_app, clinica_platform, clinica_worker;"
echo "Banco $DB e papéis de desenvolvimento prontos."
