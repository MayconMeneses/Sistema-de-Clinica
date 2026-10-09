import type pg from 'pg';
import { HttpError } from './http.js';

export type LimitKind = 'users' | 'patients' | 'storage';
const LABEL = { users: 'usuários ativos', patients: 'pacientes', storage: 'MB de arquivos' } as const;

export interface Usage { users: number; patients: number; storageMb: number }
export interface Limits { users: number | null; patients: number | null; storageMb: number | null }

export async function usageOf(tx: pg.PoolClient): Promise<{ usage: Usage; limits: Limits }> {
  const l = await tx.query<{ max_users: number | null; max_patients: number | null; max_storage_mb: number | null }>(
    'SELECT p.max_users, p.max_patients, p.max_storage_mb FROM plans p JOIN tenants t ON t.plan_code = p.code');
  const u = await tx.query<{ users: number; patients: number; bytes: string }>(
    `SELECT (SELECT count(*)::int FROM users WHERE status = 'active') AS users,
            (SELECT count(*)::int FROM patients WHERE merged_into IS NULL) AS patients,
            (SELECT COALESCE(sum(size_bytes), 0)::text FROM patient_documents) AS bytes`);
  const r = l.rows[0], x = u.rows[0]!;
  return {
    usage: { users: x.users, patients: x.patients, storageMb: Math.round((Number(x.bytes) / 1_048_576) * 10) / 10 },
    limits: { users: r?.max_users ?? null, patients: r?.max_patients ?? null, storageMb: r?.max_storage_mb ?? null },
  };
}

/** Recusa a criação que ultrapassaria o limite do plano. `addMb` só vale para arquivos. Sem limite configurado, não faz nada. */
export async function assertWithinPlan(tx: pg.PoolClient, kind: LimitKind, addMb = 0) {
  const { usage, limits } = await usageOf(tx);
  const cur = kind === 'users' ? usage.users : kind === 'patients' ? usage.patients : usage.storageMb;
  const max = kind === 'users' ? limits.users : kind === 'patients' ? limits.patients : limits.storageMb;
  if (max === null) return;
  if (cur + (kind === 'storage' ? addMb : 1) > max) {
    throw new HttpError(409, `Limite do plano atingido (${max} ${LABEL[kind]}). Fale com a plataforma para ampliar o plano.`, 'plan_limit', { kind, limit: max });
  }
}
