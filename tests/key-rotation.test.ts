import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { rotateKey } from '../src/ops/rotate-key.js';
import { config } from '../src/server/config.js';
import { currentKeyId, decryptSecret, encryptSecret, isCurrent, storedKeyId } from '../src/server/crypto.js';

const { appPool, platformPool, workerPool } = await import('../src/server/db.js');
const { tenant, state } = await import('./api-helpers.js');
const { buildApp } = await import('../src/server/app.js');

const original = { key: config.dataEncryptionKey, prev: config.previousEncryptionKeys };
const useKey = (key: string, prev: string[] = []) => { (config as any).dataEncryptionKey = key; (config as any).previousEncryptionKeys = prev; };
const newKey = () => randomBytes(32).toString('base64');
afterAll(async () => { useKey(original.key, original.prev); await appPool.end(); await platformPool.end(); await workerPool.end(); });

describe('troca da chave de criptografia', () => {
  it('cifra com id da chave, lê o formato antigo e só decifra com a chave configurada', () => {
    useKey(newKey());
    const enc = encryptSecret('segredo-1');
    expect(enc.startsWith('v2:')).toBe(true);
    expect(storedKeyId(enc)).toBe(currentKeyId());
    expect(enc).not.toContain('segredo-1');
    expect(decryptSecret(enc)).toBe('segredo-1');
    const old = enc;
    const k1 = config.dataEncryptionKey;
    useKey(newKey());                                       // chave nova sem a antiga
    expect(() => decryptSecret(old)).toThrow(/não está configurada/);
    useKey(newKey(), [k1]);                                 // com a antiga como "anterior"
    expect(() => decryptSecret(old)).not.toThrow();
    expect(isCurrent(old)).toBe(false);
    expect(isCurrent(encryptSecret('x'))).toBe(true);
    // valor v1 (formato antigo) continua legível por qualquer chave configurada
    const { createCipheriv, randomBytes: rb } = require('node:crypto') as typeof import('node:crypto');
    const kb = Buffer.from(k1, 'base64'); const iv = rb(12);
    const c = createCipheriv('aes-256-gcm', kb, iv); const ct = Buffer.concat([c.update('legado', 'utf8'), c.final()]);
    const v1 = `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
    expect(decryptSecret(v1)).toBe('legado');
    expect(decryptSecret('texto-em-claro')).toBe('texto-em-claro');
  });

  it('recifra TOTP de usuários, operadores e credenciais de pagamento; simulação não grava; repetir não muda nada; o MFA continua valendo', async () => {
    useKey(original.key, original.prev);
    state.app = await buildApp();
    const t = await tenant('rotkey');
    // credencial de pagamento e MFA do dono (cifrados com a chave antiga)
    await t.owner.req('PUT', '/api/payments/settings', { accessToken: 'APP_USR-token-teste-1234', webhookSecret: 'segredo-webhook-xyz' });
    const secret = (await t.owner.post('/api/me/mfa/setup')).json().secret as string | undefined;
    const rows = async () => withTenant(appPool, t.id, async (tx) => ({
      users: (await tx.query('SELECT totp_secret FROM users WHERE totp_secret IS NOT NULL')).rows.map((r) => r.totp_secret as string),
      pay: (await tx.query('SELECT access_token_enc, webhook_secret_enc FROM payment_settings')).rows[0] as { access_token_enc: string; webhook_secret_enc: string } | undefined,
    }));
    const before = await rows();
    const oldId = storedKeyId(before.pay?.access_token_enc ?? before.users[0]!);
    expect(before.users.length + (before.pay ? 2 : 0)).toBeGreaterThan(0);

    const k1 = config.dataEncryptionKey;
    useKey(newKey(), [k1]);                                  // rotação: chave nova + antiga como anterior
    const dry = await rotateKey({ app: appPool, platform: platformPool }, { dryRun: true, onlyTenant: t.id });
    expect(dry.rotated).toBeGreaterThan(0);
    expect((await rows()).pay?.access_token_enc).toBe(before.pay?.access_token_enc); // nada gravado

    const real = await rotateKey({ app: appPool, platform: platformPool }, { onlyTenant: t.id });
    expect(real.failed).toEqual([]);
    expect(real.rotated).toBe(dry.rotated);
    const after = await rows();
    expect(storedKeyId(after.pay!.access_token_enc)).toBe(currentKeyId());
    expect(storedKeyId(after.pay!.access_token_enc)).not.toBe(oldId);
    expect(decryptSecret(after.pay!.access_token_enc)).toBe('APP_USR-token-teste-1234');
    expect(decryptSecret(after.pay!.webhook_secret_enc)).toBe('segredo-webhook-xyz');
    if (secret) expect(after.users.every((u) => isCurrent(u))).toBe(true);

    const again = await rotateKey({ app: appPool, platform: platformPool }, { onlyTenant: t.id });
    expect(again.rotated).toBe(0);
    expect(again.alreadyCurrent).toBeGreaterThanOrEqual(real.rotated);

    // aposentada a chave antiga, tudo continua legível só com a nova
    useKey(config.dataEncryptionKey);
    expect(decryptSecret(after.pay!.access_token_enc)).toBe('APP_USR-token-teste-1234');
    void randomUUID;
  });
});
