const isProd = process.env.NODE_ENV === 'production';

function url(name: string, devDefault: string): string {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`${name} é obrigatória em produção`);
  return devDefault; // credencial de DESENVOLVIMENTO local (ver scripts/dev-db-setup.sh)
}

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrlApp: url('DATABASE_URL_APP', 'postgres://clinica_app:dev_app_pw@127.0.0.1:5432/clinica_one'),
  databaseUrlPlatform: url('DATABASE_URL_PLATFORM', 'postgres://clinica_platform:dev_platform_pw@127.0.0.1:5432/clinica_one'),
  clinicSessionHours: 12,
  masterSessionHours: 2,
};
