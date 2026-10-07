#!/usr/bin/env bash
# Backup CIFRADO do banco inteiro (todas as clínicas). Uso:
#   BACKUP_PASSPHRASE=… scripts/backup-encrypted.sh backup            # grava <BACKUP_DIR>/<banco>-<data>.dump.enc (+ .sha256) e apaga os antigos
#   BACKUP_PASSPHRASE=… scripts/backup-encrypted.sh verify <arquivo>  # confere o hash, decifra e lista o conteúdo (não restaura)
#   BACKUP_PASSPHRASE=… scripts/backup-encrypted.sh restore <arquivo> <banco_destino_vazio>
#
# Conexão: variáveis padrão do PostgreSQL (PGHOST, PGPORT, PGUSER, PGPASSWORD). Com FORCE RLS, só um papel PRIVILEGIADO
# (superusuário, ou um papel de backup com BYPASSRLS + pg_read_all_data criado pelo DBA) consegue copiar as linhas:
# os papéis da aplicação NUNCA devem ter esse poder. Em produção: guarde a senha de cifra (BACKUP_PASSPHRASE) num cofre
# FORA do servidor de banco e envie o arquivo cifrado para fora do host (BACKUP_UPLOAD_CMD). Agendamento (cron, Cloud Scheduler,
# Kubernetes CronJob) e a nuvem/região são decisões do ambiente de produção; faça o teste de restauração periodicamente.
# Estado: escrito e exercitado no CI (cifra, decifra, verifica, rejeita senha errada e arquivo adulterado). Não há agendamento ativo.
set -euo pipefail
umask 077   # arquivos temporários e backups só legíveis por quem roda o script

cmd=${1:-backup}
: "${BACKUP_PASSPHRASE:?defina BACKUP_PASSPHRASE (guarde-a fora do servidor, num cofre)}"
dir=${BACKUP_DIR:-./backups}
keep=${BACKUP_RETENTION_DAYS:-14}
db=${BACKUP_DB:-clinica_one}
[ "${#BACKUP_PASSPHRASE}" -ge 12 ] || { echo "BACKUP_PASSPHRASE precisa ter ao menos 12 caracteres" >&2; exit 2; }

# AES-256-CBC com chave derivada por PBKDF2 (200 mil iterações) e sal aleatório. A integridade vem do hash SHA-256 do arquivo cifrado.
enc() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE "$@"; }
check_hash() { [ ! -f "$1.sha256" ] || (cd "$(dirname "$1")" && sha256sum -c "$(basename "$1").sha256" >/dev/null) || { echo "Hash não confere: arquivo corrompido ou adulterado" >&2; exit 3; }; }

case "$cmd" in
  backup)
    mkdir -p "$dir"
    out="$dir/${db}-$(date -u +%Y%m%dT%H%M%SZ).dump.enc"
    pg_dump -Fc "$db" | enc -out "$out.partial"
    mv "$out.partial" "$out"
    (cd "$dir" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256")
    # Envio para fora do host (opcional): comando recebe o caminho do arquivo. Ex.: BACKUP_UPLOAD_CMD="aws s3 cp --only-show-errors"
    if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then $BACKUP_UPLOAD_CMD "$out" "${BACKUP_UPLOAD_DEST:-}"; fi
    find "$dir" -name "${db}-*.dump.enc*" -mtime "+$keep" -delete
    echo "$out"
    ;;
  verify)
    f=${2:?informe o arquivo}
    check_hash "$f"
    # Decifra para um arquivo temporário (permissão restrita, apagado ao sair) em vez de usar pipe: o pg_restore --list lê só o índice
    # e fecha a entrada, e o openssl ainda escrevendo vira "error writing output file" (corrida que depende da velocidade da máquina).
    tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
    enc -d -in "$f" -out "$tmp"
    pg_restore --list "$tmp" > /dev/null
    echo "OK: $f decifra e tem estrutura de backup válida"
    ;;
  restore)
    f=${2:?informe o arquivo}; target=${3:?informe o banco de destino (já criado e vazio)}
    check_hash "$f"
    tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
    enc -d -in "$f" -out "$tmp"
    pg_restore --no-owner --role="${BACKUP_RESTORE_ROLE:-clinica_owner}" -d "$target" "$tmp"
    echo "Restaurado em $target"
    ;;
  *) echo "Uso: $0 backup | verify <arquivo> | restore <arquivo> <banco>" >&2; exit 2 ;;
esac
