import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';

const dir = join(import.meta.dirname, '..', 'migrations');

export async function migrate(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows
        .map((r) => [r.name, r.checksum]),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const sha = (t: string) => createHash('sha256').update(t).digest('hex');
      const lf = sql.replace(/\r\n/g, '\n');
      const checksum = sha(lf);
      const prev = done.get(file);
      if (prev) {
        // Só a quebra de linha (LF/CRLF, comum ao clonar no Windows) é tolerada; qualquer outra alteração continua barrada.
        if (prev !== checksum && prev !== sha(sql) && prev !== sha(lf.replace(/\n/g, '\r\n'))) throw new Error(`Migration ${file} foi alterada após aplicada`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falha em ${file}: ${(err as Error).message}`);
      }
      applied.push(file);
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL_OWNER ?? (process.env.NODE_ENV === 'production' ? undefined : 'postgres://clinica_owner:dev_owner_pw@127.0.0.1:5432/clinica_one');
  if (!url) throw new Error('DATABASE_URL_OWNER não definida');
  migrate(url).then((a) => console.log(a.length ? `Aplicadas: ${a.join(', ')}` : 'Nada a aplicar'));
}
