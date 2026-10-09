import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { ZodError } from 'zod';
import { locateError, notify, routePattern, safeErrorSummary } from '../ops/alerts.js';

declare module 'fastify' { interface FastifyRequest { alertTenant?: { id: string; name: string } } }

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error', public extra?: Record<string, unknown>) { super(message); }
}
export const badRequest = (m: string) => new HttpError(400, m, 'bad_request');
export const unauthorized = (m = 'Sessão inválida ou expirada.') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'Você não tem permissão para esta ação.') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Não encontrado.') => new HttpError(404, m, 'not_found');
export const conflict = (m: string) => new HttpError(409, m, 'conflict');

/** AAAA-MM-DD que existe no calendário (recusa 2024-13-45 e 2023-02-30). */
export const isRealDate = (v: string) => {
  const d = new Date(`${v}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/** Texto com byte nulo (\u0000) não existe em dado legítimo e o PostgreSQL o recusa; vale para qualquer parte do corpo. */
export function hasNulChar(v: unknown, depth = 0): boolean {
  if (typeof v === 'string') return v.includes('\u0000');
  if (depth > 25 || v === null || typeof v !== 'object') return false;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k.includes('\u0000') || hasNulChar(x, depth + 1)) return true;
  return false;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newSecret = () => randomBytes(32).toString('base64url');

export function errorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof HttpError && err.status >= 500 && err.code !== 'not_configured') {
    notify({ severity: 'critical', component: 'api', title: `Resposta ${err.status} do servidor`, detail: err.message, where: locateError(err), ref: req.id, route: routePattern(req), tenant: req.alertTenant });
  }
  if (err instanceof HttpError) return reply.status(err.status).send({ ...(err.extra ?? {}), error: err.code, message: err.message, requestId: req.id });
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join('.') || 'corpo'}: ${i.message}`).join('; ');
    return reply.status(400).send({ error: 'validation', message, requestId: req.id });
  }
  const e = err as { statusCode?: number; code?: string };
  // Erros de dado do PostgreSQL (classe 22: data fora do intervalo, texto inválido, número grande demais) são entrada ruim, não falha do servidor.
  if (typeof e.code === 'string' && /^22[0-9A-Z]{3}$/.test(e.code)) return reply.status(400).send({ error: 'validation', message: 'Algum dado informado é inválido.', requestId: req.id });
  if (e.statusCode && e.statusCode < 500) {
    return reply.status(e.statusCode).send({ error: 'bad_request', message: 'Requisição inválida.', requestId: req.id });
  }
  // Nunca devolver stack, SQL ou detalhes internos.
  // O erro bruto do PostgreSQL/driver traz `detail` e `where` com valores das linhas (dados pessoais): só o resumo higienizado vai ao log.
  req.log.error({ error: safeErrorSummary(err), where: locateError(err), requestId: req.id }, 'erro interno');
  notify({ severity: 'critical', component: 'api', title: 'Erro interno (500)', detail: safeErrorSummary(err), where: locateError(err), ref: req.id, route: routePattern(req), tenant: req.alertTenant });
  return reply.status(500).send({ error: 'internal', message: 'Erro interno. Informe o código ao suporte.', requestId: req.id });
}

/** Erros do PostgreSQL com significado de negócio. */
export function mapDbError(err: unknown): never {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code === '23P01') throw conflict(/bloqueado/.test(e.message ?? '') ? 'Horário bloqueado na agenda.' : /resource/.test(e.constraint ?? '') ? 'A sala ou equipamento já está ocupado neste horário.' : /availability/.test(e.constraint ?? '') ? 'Este horário se sobrepõe a outro já cadastrado.' : 'Horário em conflito com outro agendamento.');
  if (e.code === '23505') throw conflict('Registro duplicado.');
  if (e.code === '23503') throw badRequest('Referência inválida.');
  if (e.code === '42501' && /imutável|append-only|excluído/.test(e.message ?? '')) throw conflict('Registro imutável: use um adendo/novo movimento.');
  if (e.code === '23514') throw badRequest('Dados inválidos.');
  throw err;
}

export type Tx = pg.PoolClient;
