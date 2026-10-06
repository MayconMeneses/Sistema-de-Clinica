#!/usr/bin/env bash
# Prepara banco e papéis LOCAIS de desenvolvimento/teste. Não usar em produção.
# Requer acesso superuser ao PostgreSQL local (ex.: PGSUPER="su postgres -c").
set -euo pipefail

DB=clinica_one
run_psql() { su postgres -c "psql -v ON_ERROR_STOP=1 $*"; }

role_sql() {
  local role=$1 pw=$2
  cat <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$role') THEN
    CREATE ROLE $role LOGIN PASSWORD '$pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END \$\$;
SQL
}

{
  role_sql clinica_owner dev_owner_pw
  role_sql clinica_app dev_app_pw
  role_sql clinica_platform dev_platform_pw
} | su postgres -c "psql -v ON_ERROR_STOP=1 -q"

if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$DB'\"" | grep -q 1; then
  su postgres -c "createdb -O clinica_owner $DB"
fi
su postgres -c "psql -v ON_ERROR_STOP=1 -q -d $DB -c 'REVOKE ALL ON DATABASE $DB FROM PUBLIC; GRANT CONNECT ON DATABASE $DB TO clinica_app, clinica_platform; ALTER SCHEMA public OWNER TO clinica_owner; REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO clinica_app, clinica_platform;'"
echo "Banco $DB e papéis de desenvolvimento prontos."
