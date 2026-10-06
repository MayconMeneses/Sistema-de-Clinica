// URLs de DESENVOLVIMENTO LOCAL (papéis criados por scripts/dev-db-setup.sh). Sobrescritas por variáveis de ambiente.
export const URL_OWNER = process.env.DATABASE_URL_OWNER ?? 'postgres://clinica_owner:dev_owner_pw@127.0.0.1:5432/clinica_one';
export const URL_APP = process.env.DATABASE_URL_APP ?? 'postgres://clinica_app:dev_app_pw@127.0.0.1:5432/clinica_one';
export const URL_PLATFORM = process.env.DATABASE_URL_PLATFORM ?? 'postgres://clinica_platform:dev_platform_pw@127.0.0.1:5432/clinica_one';
