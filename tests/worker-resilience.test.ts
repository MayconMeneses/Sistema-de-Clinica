import { describe, expect, it } from 'vitest';
import { isDbUnavailable } from '../src/worker/main.js';

describe('worker: banco indisponível não é defeito do worker', () => {
  it('reconhece recuperação, desligamento, conexão recusada e falhas de rede', () => {
    for (const code of ['57P03', '57P01', '57P02', '08006', '08001', '53300', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']) expect(isDbUnavailable({ code }), code).toBe(true);
    expect(isDbUnavailable({ errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }] })).toBe(true);      // AggregateError (IPv4 + IPv6)
  });
  it('erros de verdade continuam contando', () => {
    for (const e of [{ code: '23505' }, { code: '42P01' }, new Error('x'), null, undefined, {}]) expect(isDbUnavailable(e)).toBe(false);
  });
});
