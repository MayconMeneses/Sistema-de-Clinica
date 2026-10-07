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
  databaseUrlWorker: url('DATABASE_URL_WORKER', 'postgres://clinica_worker:dev_worker_pw@127.0.0.1:5432/clinica_one'),
  databaseUrlPlatform: url('DATABASE_URL_PLATFORM', 'postgres://clinica_platform:dev_platform_pw@127.0.0.1:5432/clinica_one'),
  clinicSessionHours: 12,
  masterSessionHours: 2,
};

/** Lê a configuração de integrações no momento do uso (permite trocar por variável de ambiente sem recompilar). */
export function integrationEnv() {
  const e = process.env;
  return {
    defaultMode: (isProd ? 'disabled' : 'sandbox') as 'disabled' | 'sandbox',
    whatsapp: { token: e.WHATSAPP_TOKEN, phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID, appSecret: e.WHATSAPP_APP_SECRET, verifyToken: e.WHATSAPP_VERIFY_TOKEN, apiBase: e.WHATSAPP_API_BASE ?? 'https://graph.facebook.com/v20.0' },
    email: { apiUrl: e.EMAIL_API_URL, apiKey: e.EMAIL_API_KEY, from: e.EMAIL_FROM },
    sms: { apiUrl: e.SMS_API_URL, apiKey: e.SMS_API_KEY, from: e.SMS_FROM },
    webhookSecretGeneric: e.WEBHOOK_SECRET_GENERIC,
    /** URL pública (HTTPS) do sistema, usada para montar o endereço de notificação do gateway. Sem ela o gateway não avisa e a confirmação é feita pelo botão "Verificar". */
    publicBaseUrl: e.PUBLIC_BASE_URL?.replace(/\/+$/, ''),
    mercadopago: { apiBase: e.MERCADOPAGO_API_BASE ?? 'https://api.mercadopago.com' },
    storageDir: e.STORAGE_LOCAL_DIR ?? './.data/storage',
  };
}
