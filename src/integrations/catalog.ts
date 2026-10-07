import { integrationEnv } from '../server/config.js';

/**
 * CATÁLOGO ÚNICO de tudo que depende de terceiros. Cada item diz: o que já está montado (porta, sandbox, adaptador real),
 * quais variáveis/credenciais faltam e o que ainda depende de decisão ou contrato. O Painel Master e docs/INTEGRACOES.md
 * mostram este mesmo catálogo, para nunca haver duas verdades. Nada aqui contém valor de credencial.
 *
 * liveAdapter: 'written' = escrito e testado contra servidor falso (NÃO validado com o provedor real);
 *              'local' = roda sem terceiro (disco local); 'none' = ainda não escrito.
 * scope: 'platform' = credencial única do servidor (variável de ambiente); 'clinic' = cada clínica traz a sua (cifrada no banco).
 */
export interface CatalogEntry {
  kind: string;
  label: string;
  provider: string;
  scope: 'platform' | 'clinic';
  env: string[];
  port: boolean;
  sandbox: boolean;
  liveAdapter: 'written' | 'local' | 'none';
  validatedWithProvider: boolean;
  pending: string;
  /** null = não se aplica ao servidor (a credencial é por clínica). */
  configured: () => boolean | null;
}

export const INTEGRATION_CATALOG: CatalogEntry[] = [
  {
    kind: 'whatsapp', label: 'WhatsApp', provider: 'whatsapp-cloud (Meta)', scope: 'platform', port: true, sandbox: true, liveAdapter: 'written', validatedWithProvider: false,
    env: ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'],
    pending: 'conta e número verificados, templates aprovados (appointment_*), webhook da Meta', configured: () => { const c = integrationEnv().whatsapp; return !!(c.token && c.phoneNumberId); },
  },
  {
    kind: 'email', label: 'E-mail', provider: 'email-http (genérico)', scope: 'platform', port: true, sandbox: true, liveAdapter: 'written', validatedWithProvider: false,
    env: ['EMAIL_API_URL', 'EMAIL_API_KEY', 'EMAIL_FROM'], pending: 'escolher o provedor, domínio com SPF/DKIM; ajustar o formato do corpo', configured: () => { const c = integrationEnv().email; return !!(c.apiUrl && c.apiKey && c.from); },
  },
  {
    kind: 'sms', label: 'SMS', provider: 'sms-http (genérico)', scope: 'platform', port: true, sandbox: true, liveAdapter: 'written', validatedWithProvider: false,
    env: ['SMS_API_URL', 'SMS_API_KEY', 'SMS_FROM'], pending: 'escolher o provedor; ajustar o formato', configured: () => { const c = integrationEnv().sms; return !!(c.apiUrl && c.apiKey); },
  },
  {
    kind: 'payments', label: 'Pagamentos online (Pix e link)', provider: 'Mercado Pago', scope: 'clinic', port: true, sandbox: true, liveAdapter: 'written', validatedWithProvider: false,
    env: ['PUBLIC_BASE_URL', 'MERCADOPAGO_API_BASE (opcional)'],
    pending: 'cada clínica informa o Access Token e o segredo do webhook em Gestão → Pagamentos; validar com as credenciais de TESTE do Mercado Pago; definir PUBLIC_BASE_URL (HTTPS)',
    configured: () => null, // a credencial é de cada clínica: não existe "configurado no servidor"
  },
  {
    kind: 'nfse', label: 'NFS-e', provider: 'não definido', scope: 'clinic', port: true, sandbox: true, liveAdapter: 'none', validatedWithProvider: false,
    env: [], pending: 'município e provedor da prefeitura, certificado digital, regime tributário e código de serviço (decisão fiscal)', configured: () => false,
  },
  {
    kind: 'signature', label: 'Assinatura eletrônica', provider: 'não definido', scope: 'platform', port: true, sandbox: true, liveAdapter: 'none', validatedWithProvider: false,
    env: [], pending: 'escolher o provedor, nível de assinatura e validade jurídica (validar com especialista); ligar ao aceite do orçamento', configured: () => false,
  },
  {
    kind: 'storage', label: 'Armazenamento de arquivos', provider: 'disco local', scope: 'platform', port: true, sandbox: false, liveAdapter: 'local', validatedWithProvider: false,
    env: ['STORAGE_LOCAL_DIR'], pending: 'adaptador S3-compatível (mesma porta) e rota de upload com validação de tipo, tamanho e antivírus', configured: () => true,
  },
  {
    kind: 'backup', label: 'Backup cifrado agendado', provider: 'script + destino à escolha', scope: 'platform', port: false, sandbox: false, liveAdapter: 'written', validatedWithProvider: false,
    env: ['BACKUP_PASSPHRASE', 'BACKUP_DIR', 'BACKUP_UPLOAD_CMD (opcional)'], pending: 'nuvem/região e agendamento no ambiente de produção; testar a restauração periodicamente', configured: () => !!process.env.BACKUP_PASSPHRASE,
  },
  {
    kind: 'calendar', label: 'Calendários (Google/Microsoft)', provider: 'não definido', scope: 'clinic', port: false, sandbox: false, liveAdapter: 'none', validatedWithProvider: false,
    env: [], pending: 'OAuth, escopos e política de privacidade do aplicativo', configured: () => false,
  },
  {
    kind: 'observability', label: 'Erros e métricas', provider: 'não definido', scope: 'platform', port: false, sandbox: false, liveAdapter: 'none', validatedWithProvider: false,
    env: [], pending: 'escolher a ferramenta; os logs estruturados e o /api/ready já existem', configured: () => false,
  },
];
