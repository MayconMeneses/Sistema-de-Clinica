import type pg from 'pg';
import { conflict } from '../../server/http.js';

/**
 * Cadastro principal + cadastros mesclados nele. Prontuário assinado e movimentos financeiros são imutáveis
 * e permanecem vinculados ao cadastro de origem; as leituras do cadastro principal incluem todos (alias).
 */
export async function family(tx: pg.PoolClient, id: string): Promise<string[]> {
  const r = await tx.query<{ id: string }>('SELECT id FROM patients WHERE id = $1 OR merged_into = $1', [id]);
  return r.rows.length ? r.rows.map((x) => x.id) : [id];
}

/** Impede novos registros num cadastro que foi mesclado: o trabalho continua no principal. */
export async function assertActive(tx: pg.PoolClient, id: string): Promise<void> {
  const r = await tx.query<{ merged_into: string | null }>('SELECT merged_into FROM patients WHERE id = $1', [id]);
  if (r.rows[0]?.merged_into) throw conflict('Este cadastro foi mesclado a outro. Use o cadastro principal.');
}

export interface DuplicateCandidate { id: string; name: string; birthDate: string | null; phone: string | null; reason: string }

export async function findDuplicates(tx: pg.PoolClient, p: { name: string; birthDate: string | null; phone: string | null; document: string | null }, excludeId?: string): Promise<DuplicateCandidate[]> {
  // As chaves são calculadas pelo banco (mesmas funções que o trigger usa), então não há divergência de regra.
  const r = await tx.query<DuplicateCandidate>(
    `WITH q AS (SELECT doc_key($1::text) AS doc, phone_key($2::text) AS phone, name_key($3::text) AS name, $4::date AS birth)
     SELECT p.id, p.name, to_char(p.birth_date,'YYYY-MM-DD') AS "birthDate", p.phone,
            CASE WHEN q.doc <> '' AND p.doc_digits = q.doc THEN 'mesmo documento'
                 WHEN q.birth IS NOT NULL AND p.name_key = q.name AND p.birth_date = q.birth THEN 'mesmo nome e nascimento'
                 WHEN q.phone <> '' AND p.phone_digits = q.phone AND split_part(p.name_key, ' ', 1) = split_part(q.name, ' ', 1) THEN 'mesmo telefone e primeiro nome' END AS reason
       FROM patients p, q
      WHERE p.merged_into IS NULL AND ($5::uuid IS NULL OR p.id <> $5)
        AND ((q.doc <> '' AND p.doc_digits = q.doc) OR (q.birth IS NOT NULL AND p.name_key = q.name AND p.birth_date = q.birth)
             OR (q.phone <> '' AND p.phone_digits = q.phone AND split_part(p.name_key, ' ', 1) = split_part(q.name, ' ', 1)))
      LIMIT 5`, [p.document, p.phone, p.name, p.birthDate, excludeId ?? null]);
  return r.rows;
}
