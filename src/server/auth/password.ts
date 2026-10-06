import { randomBytes, scrypt as scryptCb, timingSafeEqual, type BinaryLike } from 'node:crypto';

const N = 16384, R = 8, P = 1, KEYLEN = 32;

function scrypt(password: string, salt: BinaryLike): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, KEYLEN, { N, r: R, p: P }, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  // Sem hash (usuário inexistente): gasta o mesmo tempo para não revelar existência.
  const parts = (stored ?? DUMMY_HASH).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  const actual = await scrypt(password, salt);
  const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
  return stored != null && ok;
}

const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEYLEN).toString('base64')}`;

export function passwordPolicyError(password: string): string | null {
  if (password.length < 10) return 'A senha deve ter ao menos 10 caracteres.';
  if (password.length > 128) return 'A senha deve ter no máximo 128 caracteres.';
  return null;
}
