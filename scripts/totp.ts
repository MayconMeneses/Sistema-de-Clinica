import pg from 'pg';
import { totpAt } from '../src/server/auth/totp.js';
import { decryptSecret } from '../src/server/crypto.js';

// Imprime um código TOTP ainda não usado (cada passo de 30s só vale uma vez).
const email = process.argv[2] ?? 'master@demo.local';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_PLATFORM ?? 'postgres://clinica_platform:dev_platform_pw@127.0.0.1:5432/clinica_one' });
const r = await pool.query<{ totp_secret: string; totp_last_step: string | null }>('SELECT totp_secret, totp_last_step FROM platform_users WHERE email = $1', [email]);
if (!r.rows[0]) throw new Error('Operador não encontrado');
const secret = decryptSecret(r.rows[0].totp_secret);
const last = r.rows[0].totp_last_step ? Number(r.rows[0].totp_last_step) : -1;
const now = Date.now();
const cur = Math.floor(now / 30000);
const step = [cur, cur + 1].find((s) => s > last);
if (step === undefined) { console.error('Código atual já foi usado. Aguarde até 30s e rode de novo.'); process.exit(1); }
console.log(totpAt(secret, step * 30000));
if (step > cur) console.error(`(válido a partir de ${Math.max(0, Math.ceil((step * 30000 - now) / 1000))}s; o servidor aceita 1 passo de antecedência)`);
await pool.end();
