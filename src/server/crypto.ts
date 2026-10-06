import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';

/** AES-256-GCM para segredos em repouso (ex.: TOTP). Formato: v1:<iv>:<tag>:<cifrado> (base64). */
function key(): Buffer {
  const raw = config.dataEncryptionKey;
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('DATA_ENCRYPTION_KEY deve ter 32 bytes em base64');
  return buf;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith('v1:')) return stored; // legado em claro: será recifrado na próxima gravação
  const [, iv, tag, ct] = stored.split(':');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv!, 'base64'));
  d.setAuthTag(Buffer.from(tag!, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct!, 'base64')), d.final()]).toString('utf8');
}

export const hashKey = (s: string) => createHash('sha256').update(s).digest('hex');
