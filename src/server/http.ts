import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error') { super(message); }
}
export const badRequest = (m: string) => new HttpError(400, m, 'bad_request');
export const unauthorized = (m = 'Sessão inválida ou expirada.') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'Você não tem permissão para esta ação.') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Não encontrado.') => new HttpError(404, m, 'not_found');
export const conflict = (m: string) => new HttpError(409, m, 'conflict');

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newSecret = () => randomBytes(32).toString('base64url');

export function errorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message, requestId: req.id });
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join('.') || 'corpo'}: ${i.message}`).join('; ');
    return reply.status(400).send({ error: 'validation', message, requestId: req.id });
  }
  const e = err as { statusCode?: number; code?: string };
  if (e.statusCode && e.statusCode < 500) {
    return reply.status(e.statusCode).send({ error: 'bad_request', message: 'Requisição inválida.', requestId: req.id });
  }
  // Nunca devolver stack, SQL ou detalhes internos.
  req.log.error({ err, requestId: req.id }, 'erro interno');
  return reply.status(500).send({ error: 'internal', message: 'Erro interno. Informe o código ao suporte.', requestId: req.id });
}

/** Erros do PostgreSQL com significado de negócio. */
export function mapDbError(err: unknown): never {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code === '23P01') throw conflict('Horário em conflito com outro agendamento.');
  if (e.code === '23505') throw conflict('Registro duplicado.');
  if (e.code === '23503') throw badRequest('Referência inválida.');
  if (e.code === '42501' && /imutável|append-only|excluído/.test(e.message ?? '')) throw conflict('Registro imutável: use um adendo/novo movimento.');
  if (e.code === '23514') throw badRequest('Dados inválidos.');
  throw err;
}

export type Tx = pg.PoolClient;
