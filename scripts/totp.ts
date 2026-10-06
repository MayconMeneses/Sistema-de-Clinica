import pg from 'pg';
import { totpAt } from '../src/server/auth/totp.js';

const email = process.argv[2] ?? 'master@demo.local';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_PLATFORM ?? 'postgres://clinica_platform:dev_platform_pw@127.0.0.1:5432/clinica_one' });
const r = await pool.query<{ totp_secret: string }>('SELECT totp_secret FROM platform_users WHERE email = $1', [email]);
if (!r.rows[0]) throw new Error('Operador não encontrado');
console.log(totpAt(r.rows[0].totp_secret, Date.now()));
await pool.end();
