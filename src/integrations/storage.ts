import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export interface StoredObject { key: string; sha256: string; size: number }
export interface StoragePort {
  put(tenantId: string, key: string, data: Buffer): Promise<StoredObject>;
  get(tenantId: string, key: string): Promise<Buffer>;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Armazenamento em disco local (desenvolvimento / servidor único). Chaves ficam sob <raiz>/<tenant>/…,
 * cada segmento é validado (sem "..", sem barra invertida, sem caminho absoluto) e o caminho final é conferido.
 * Troca futura por S3-compatível mantém esta mesma porta.
 */
export class LocalFsStorage implements StoragePort {
  private root: string;
  constructor(root: string) { this.root = resolve(root); }

  private path(tenantId: string, key: string): string {
    if (!UUID.test(tenantId)) throw new Error('tenant inválido');
    const parts = key.split('/');
    if (!parts.length || parts.length > 6 || !parts.every((p) => SEGMENT.test(p) && p !== '..')) throw new Error('chave de arquivo inválida');
    const base = join(this.root, tenantId);
    const full = resolve(base, ...parts);
    if (!full.startsWith(base + sep)) throw new Error('chave de arquivo inválida');
    return full;
  }

  async put(tenantId: string, key: string, data: Buffer): Promise<StoredObject> {
    const full = this.path(tenantId, key);
    await mkdir(resolve(full, '..'), { recursive: true });
    await writeFile(full, data, { flag: 'wx' }); // nunca sobrescreve
    return { key, sha256: createHash('sha256').update(data).digest('hex'), size: data.length };
  }
  async get(tenantId: string, key: string): Promise<Buffer> {
    return readFile(this.path(tenantId, key));
  }
}
