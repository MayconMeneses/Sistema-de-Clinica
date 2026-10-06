import { buildApp } from './app.js';
import { config } from './config.js';

const app = await buildApp({ logger: true });
await app.listen({ port: config.port, host: config.host });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void app.close().then(() => process.exit(0)); });
}
