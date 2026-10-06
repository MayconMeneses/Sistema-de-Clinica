const isProd = process.env.NODE_ENV === 'production';

function url(name: string, devDefault: string): string {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`${name} é obrigatória em produção`);
  return devDefault; // credencial de DESENVOLVIMENTO local (ver scripts/dev-db-setup.sh)
}

function secretKey(): string {
  const v = process.env.DATA_ENCRYPTION_KEY;
  if (v) return v;
  if (isProd) throw new Error('DATA_ENCRYPTION_KEY é obrigatória em produção (32 bytes em base64)');
  // Chave FIXA de desenvolvimento: não protege nada em produção. Gere a real com: openssl rand -base64 32
  return Buffer.from('dev-only-key-do-not-use-in-prod!!').subarray(0, 32).toString('base64');
}

export const config = {
  dataEncryptionKey: secretKey(),
  isProd,
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrlApp: url('DATABASE_URL_APP', 'postgres://clinica_app:dev_app_pw@127.0.0.1:5432/clinica_one'),
  databaseUrlPlatform: url('DATABASE_URL_PLATFORM', 'postgres://clinica_platform:dev_platform_pw@127.0.0.1:5432/clinica_one'),
  clinicSessionHours: 12,
  masterSessionHours: 2,
};
