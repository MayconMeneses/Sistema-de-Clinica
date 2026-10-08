import { randomBytes, scrypt as scryptCb, timingSafeEqual, type BinaryLike } from 'node:crypto';

// scrypt com custo de memória/CPU conforme a recomendação atual da OWASP (N=2^15, r=8, p=3, ~32 MiB por verificação).
// Os parâmetros ficam gravados em cada hash: hashes antigos (N=2^14, p=1) continuam válidos e são recifrados no próximo login.
const N = 32768, R = 8, P = 3, KEYLEN = 32;
const MAX_N = 1 << 17;   // teto aceito ao LER um hash, para que um valor adulterado no banco não esgote a memória

function scrypt(password: string, salt: BinaryLike, n = N, r = R, p = P): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, KEYLEN, { N: n, r, p, maxmem: 256 * n * r + 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))));
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
  const n = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isInteger(n) || n < 1024 || n > MAX_N || (n & (n - 1)) !== 0 || !Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  const actual = await scrypt(password, salt, n, r, p);
  const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
  return stored != null && ok;
}

/** Verdadeiro se o hash guardado usa parâmetros mais fracos que os atuais (recifrar após um login correto). */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  return parts[0] !== 'scrypt' || Number(parts[1]) < N || Number(parts[2]) < R || Number(parts[3]) < P;
}

const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEYLEN).toString('base64')}`;

export function passwordPolicyError(password: string): string | null {
  if (password.length < 10) return 'A senha deve ter ao menos 10 caracteres.';
  if (password.length > 128) return 'A senha deve ter no máximo 128 caracteres.';
  return null;
}
