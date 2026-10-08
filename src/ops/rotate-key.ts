import type pg from 'pg';
import { withTenant } from '../db/tenant.js';
import { currentKeyId, decryptSecret, encryptSecret, isCurrent } from '../server/crypto.js';

/**
 * Recifra com a chave ATUAL todos os segredos guardados no banco (TOTP dos usuários e dos operadores, credenciais de pagamento).
 * Idempotente: valores já na chave atual são pulados. Cada valor é conferido (decifrar o novo e comparar) antes de gravar.
 * Com dryRun não grava nada. Usa os papéis normais da aplicação, então a RLS continua valendo.
 */
export interface RotateReport { keyId: string; scanned: number; rotated: number; alreadyCurrent: number; failed: { where: string; reason: string }[] }

function recipher(stored: string | null, report: RotateReport, where: string): string | null {
  if (!stored) return null;
  report.scanned++;
  if (isCurrent(stored)) { report.alreadyCurrent++; return null; }
  try {
    const plain = decryptSecret(stored);
    const fresh = encryptSecret(plain);
    if (decryptSecret(fresh) !== plain) throw new Error('conferência falhou');
    return fresh;
  } catch (e) {
    report.failed.push({ where, reason: (e as Error).message.slice(0, 120) });
    return null;
  }
}

export async function rotateKey(pools: { app: pg.Pool; platform: pg.Pool }, opts: { dryRun?: boolean; /** só esta clínica (e sem operadores da plataforma); usado em testes */ onlyTenant?: string } = {}): Promise<RotateReport> {
  const report: RotateReport = { keyId: currentKeyId(), scanned: 0, rotated: 0, alreadyCurrent: 0, failed: [] };
  const write = !opts.dryRun;

  const ops = opts.onlyTenant ? { rows: [] as { id: string; totp_secret: string }[] } : await pools.platform.query<{ id: string; totp_secret: string }>('SELECT id, totp_secret FROM platform_users');
  for (const r of ops.rows) {
    const fresh = recipher(r.totp_secret, report, 'operador da plataforma');
    if (fresh) { if (write) await pools.platform.query('UPDATE platform_users SET totp_secret = $1 WHERE id = $2', [fresh, r.id]); report.rotated++; }
  }

  const tenants = opts.onlyTenant ? { rows: [{ tenant_id: opts.onlyTenant }] } : await pools.platform.query<{ tenant_id: string }>('SELECT tenant_id FROM tenant_directory');
  for (const t of tenants.rows) {
    await withTenant(pools.app, t.tenant_id, async (tx) => {
      const users = await tx.query<{ id: string; totp_secret: string | null }>('SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL');
      for (const u of users.rows) {
        const fresh = recipher(u.totp_secret, report, `usuário de clínica ${t.tenant_id.slice(0, 8)}`);
        if (fresh) { if (write) await tx.query('UPDATE users SET totp_secret = $1 WHERE id = $2', [fresh, u.id]); report.rotated++; }
      }
      const ps = await tx.query<{ access_token_enc: string | null; webhook_secret_enc: string | null }>('SELECT access_token_enc, webhook_secret_enc FROM payment_settings');
      for (const p of ps.rows) {
        const a = recipher(p.access_token_enc, report, `pagamentos ${t.tenant_id.slice(0, 8)}`);
        const w = recipher(p.webhook_secret_enc, report, `pagamentos ${t.tenant_id.slice(0, 8)}`);
        if (a || w) {
          if (write) await tx.query('UPDATE payment_settings SET access_token_enc = COALESCE($1, access_token_enc), webhook_secret_enc = COALESCE($2, webhook_secret_enc)', [a, w]);
          report.rotated += (a ? 1 : 0) + (w ? 1 : 0);
        }
      }
    });
  }
  return report;
}
