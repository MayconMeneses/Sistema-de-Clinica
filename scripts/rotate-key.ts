// Troca da chave de criptografia dos segredos guardados. Passo a passo em docs/OPERACAO-CHAVES.md.
//   DATA_ENCRYPTION_KEY=<nova> DATA_ENCRYPTION_KEY_PREVIOUS=<antiga> npx tsx scripts/rotate-key.ts --dry-run
//   DATA_ENCRYPTION_KEY=<nova> DATA_ENCRYPTION_KEY_PREVIOUS=<antiga> npx tsx scripts/rotate-key.ts
import { rotateKey } from '../src/ops/rotate-key.js';
import { appPool, platformPool } from '../src/server/db.js';

const dryRun = process.argv.includes('--dry-run');
const r = await rotateKey({ app: appPool, platform: platformPool }, { dryRun });
console.log(`${dryRun ? '[SIMULAÇÃO] ' : ''}Chave atual: ${r.keyId}`);
console.log(`Segredos encontrados: ${r.scanned} · já na chave atual: ${r.alreadyCurrent} · ${dryRun ? 'seriam recifrados' : 'recifrados'}: ${r.rotated} · falhas: ${r.failed.length}`);
for (const f of r.failed) console.error(`  FALHA em ${f.where}: ${f.reason}`);
console.log('Lembrete: valores em variáveis de ambiente (ex.: TELEGRAM_BOT_TOKEN_ENC) não são tocados; gere-os de novo com scripts/encrypt-secret.ts.');
await appPool.end(); await platformPool.end();
process.exit(r.failed.length ? 1 : 0);
