// Cifra um segredo para colocar no .env (ex.: TELEGRAM_BOT_TOKEN_ENC). Lê da entrada padrão: o valor não aparece em histórico de comandos.
//   echo -n "123:AA..." | npx tsx scripts/encrypt-secret.ts
import { encryptSecret } from '../src/server/crypto.js';

let data = '';
for await (const chunk of process.stdin) data += chunk;
const secret = data.trim();
if (!secret) { console.error('Nada recebido na entrada padrão.'); process.exit(1); }
console.log(encryptSecret(secret));
