import { migrate } from '../scripts/migrate.js';
import { URL_OWNER } from './env.js';

export default async function setup() {
  await migrate(URL_OWNER);
}
