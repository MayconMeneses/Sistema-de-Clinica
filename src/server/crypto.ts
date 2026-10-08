import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';

/**
 * AES-256-GCM para segredos em repouso (TOTP, tokens de provedores).
 * Formato atual: v2:<id da chave>:<iv>:<tag>:<cifrado> (base64). O id é um resumo curto da chave (não revela a chave) e permite
 * saber qual chave cifrou o valor, o que torna a rotação verificável. Formato antigo v1:<iv>:<tag>:<cifrado> continua legível.
 * Cifrar usa SEMPRE a chave atual (DATA_ENCRYPTION_KEY). Decifrar também aceita as de DATA_ENCRYPTION_KEY_PREVIOUS.
 */
function toKey(raw: string): Buffer {
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('A chave de criptografia deve ter 32 bytes em base64');
  return buf;
}
export const keyId = (k: Buffer) => createHash('sha256').update(k).update('clinica-one-key-id').digest('hex').slice(0, 8);

const current = () => toKey(config.dataEncryptionKey);
const previous = () => config.previousEncryptionKeys.map(toKey);
const allKeys = () => { const c = current(); return [c, ...previous().filter((k) => !k.equals(c))]; };

export const currentKeyId = () => keyId(current());

export function encryptSecret(plain: string): string {
  const k = current();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v2:${keyId(k)}:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

function open(k: Buffer, iv: string, tag: string, ct: string): string {
  const d = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

export function decryptSecret(stored: string): string {
  if (stored.startsWith('v2:')) {
    const [, id, iv, tag, ct] = stored.split(':');
    const k = allKeys().find((x) => keyId(x) === id);
    if (!k) throw new Error(`Valor cifrado com a chave ${id}, que não está configurada (veja DATA_ENCRYPTION_KEY_PREVIOUS).`);
    return open(k, iv!, tag!, ct!);
  }
  if (stored.startsWith('v1:')) {
    const [, iv, tag, ct] = stored.split(':');
    for (const k of allKeys()) { try { return open(k, iv!, tag!, ct!); } catch { /* tenta a próxima chave */ } }
    throw new Error('Não foi possível decifrar o valor com nenhuma chave configurada.');
  }
  // Valor sem prefixo = formato legado em claro (só desenvolvimento). Em produção, falha fechada: um segredo que não é cifrado nunca é aceito.
  if (config.isProd) throw new Error('Segredo guardado sem cifragem; recadastre-o.');
  return stored;
}

/** Id da chave que cifrou o valor (null = formato antigo sem id ou valor em claro). */
export const storedKeyId = (stored: string) => (stored.startsWith('v2:') ? stored.split(':')[1]! : null);
/** Verdadeiro se o valor já está cifrado no formato atual com a chave atual. */
export const isCurrent = (stored: string) => storedKeyId(stored) === currentKeyId();

export const hashKey = (s: string) => createHash('sha256').update(s).digest('hex');
