#!/usr/bin/env bash
# Drill de backup/restore: cria um dump, restaura em um banco temporário e VALIDA a recuperação
# (dados idênticos, RLS/policies/triggers preservados, isolamento entre tenants funcionando).
# O backup roda com papel PRIVILEGIADO (superuser): com FORCE RLS, nem o owner consegue copiar as linhas
# — e os papéis da aplicação jamais devem ter esse poder. Backup real deve ser criptografado e guardado fora do host.
set -euo pipefail

SRC=${SRC_DB:-clinica_one}
DST=${DST_DB:-clinica_restore_drill}
OUT=${OUT_DIR:-$(mktemp -d)}
chmod 777 "$OUT"   # o pg_dump roda como outro usuário no modo local
DUMP="$OUT/$SRC.dump"
if [ -n "${PGHOST:-}" ]; then
  sup() { psql -v ON_ERROR_STOP=1 -q "$@"; }
  dump() { pg_dump "$@"; }
  restore() { pg_restore "$@"; }
else
  sup() { su postgres -c "psql -v ON_ERROR_STOP=1 -q $(printf '%q ' "$@")"; }
  dump() { su postgres -c "pg_dump $(printf '%q ' "$@")"; }
  restore() { su postgres -c "pg_restore $(printf '%q ' "$@")"; }
fi

# Resumo determinístico de todas as tabelas: contagem + hash do conteúdo (lido como superuser, ignora RLS).
fingerprint() {
  local db=$1
  local tables
  tables=$(sup -d "$db" -tA -c "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")
  for t in $tables; do
    printf '%s ' "$t"
    sup -d "$db" -tA -c "SELECT count(*) || ' ' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '-') FROM \"$t\" x"
  done
}
structure() {
  sup -d "$1" -tA -c "SELECT 'rls:' || relname || ':' || relrowsecurity || ':' || relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relkind='r' ORDER BY 1"
  sup -d "$1" -tA -c "SELECT 'policy:' || tablename || ':' || policyname FROM pg_policies WHERE schemaname='public' ORDER BY 1"
  sup -d "$1" -tA -c "SELECT 'trigger:' || event_object_table || ':' || trigger_name FROM information_schema.triggers WHERE trigger_schema='public' GROUP BY 1 ORDER BY 1"
}

echo "== 1/5 Fingerprint da origem"
fingerprint "$SRC" > "$OUT/src.fp"; structure "$SRC" > "$OUT/src.struct"
echo "   $(wc -l < "$OUT/src.fp") tabelas, $(grep -c '^policy:' "$OUT/src.struct") policies, $(grep -c '^trigger:' "$OUT/src.struct") triggers"

echo "== 2/5 Backup (pg_dump -Fc)"
T0=$(date +%s.%N)
dump -Fc -f "$DUMP" "$SRC"
echo "   $(du -h "$DUMP" | cut -f1) em $DUMP"

echo "== 3/5 Restore em banco temporário ($DST)"
sup -d postgres -c "DROP DATABASE IF EXISTS $DST"
sup -d postgres -c "CREATE DATABASE $DST OWNER clinica_owner"
T1=$(date +%s.%N)
restore --no-owner --role=clinica_owner -d "$DST" "$DUMP"
T2=$(date +%s.%N)
sup -d "$DST" -c "GRANT CONNECT ON DATABASE $DST TO clinica_app, clinica_platform"

if [ -n "${DRILL_SELFTEST_TAMPER:-}" ]; then   # autoteste: simula perda de dado no restore; o drill DEVE reprovar
  sup -d "$DST" -c "DELETE FROM patients WHERE ctid IN (SELECT ctid FROM patients LIMIT 1)"
fi
echo "== 4/5 Validação"
fingerprint "$DST" > "$OUT/dst.fp"; structure "$DST" > "$OUT/dst.struct"
FAIL=0
diff -q "$OUT/src.fp" "$OUT/dst.fp" >/dev/null && echo "   ✓ dados idênticos (contagem + hash por tabela)" || { echo "   ✗ DADOS DIVERGEM"; diff "$OUT/src.fp" "$OUT/dst.fp" | head; FAIL=1; }
diff -q "$OUT/src.struct" "$OUT/dst.struct" >/dev/null && echo "   ✓ RLS, policies e triggers preservados" || { echo "   ✗ ESTRUTURA DIVERGE"; diff "$OUT/src.struct" "$OUT/dst.struct" | head; FAIL=1; }

# Isolamento no banco restaurado, com o papel da aplicação.
T_A=$(sup -d "$DST" -tA -c "SELECT tenant_id FROM users GROUP BY tenant_id ORDER BY count(*) DESC LIMIT 1")
T_B=$(sup -d "$DST" -tA -c "SELECT tenant_id FROM users WHERE tenant_id <> '$T_A' GROUP BY tenant_id LIMIT 1")
if [ -n "$T_A" ] && [ -n "$T_B" ]; then
  APP_URL="postgresql://clinica_app:dev_app_pw@${PGHOST:-127.0.0.1}:${PGPORT:-5432}/$DST"
  # Conexão nova como clinica_app: define o tenant na sessão e tenta enxergar usuários de outro tenant.
  ONLY_A=$(printf "SET app.tenant_id = '%s';\nSELECT count(*) FROM users WHERE tenant_id <> '%s';\n" "$T_A" "$T_A" | psql -q -tA "$APP_URL")
  NONE=$(psql "$APP_URL" -tA -c "SELECT count(*) FROM users")
  [ "$ONLY_A" = "0" ] && [ "$NONE" = "0" ] && echo "   ✓ isolamento preservado: tenant A não vê B; sem contexto vê 0 linhas" || { echo "   ✗ ISOLAMENTO FALHOU (outros=$ONLY_A semcontexto=$NONE)"; FAIL=1; }
else
  echo "   ! menos de 2 tenants com usuários; isolamento não verificado"; FAIL=1
fi

echo "== 5/5 Medição"
printf '   backup: %.1fs · restore: %.1fs (RTO medido neste volume de dados; NÃO é garantia de produção)\n' "$(echo "$T1 - $T0" | bc)" "$(echo "$T2 - $T1" | bc)"
sup -d postgres -c "DROP DATABASE IF EXISTS $DST"
rm -rf "$OUT"
[ "$FAIL" = "0" ] && echo "DRILL OK" || { echo "DRILL FALHOU"; exit 1; }
