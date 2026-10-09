import { z } from 'zod';
import { badRequest, isRealDate } from '../../server/http.js';

export const FIELD_TYPES = ['text', 'longtext', 'yesno', 'choice', 'multichoice', 'number', 'date', 'scale'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const fieldSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Identificador do campo inválido (use letras minúsculas, números e _).'),
  label: z.string().trim().min(2).max(160),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(false),
  help: z.string().trim().max(200).optional(),
  options: z.array(z.string().trim().min(1).max(80)).min(2).max(20).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
}).strict().superRefine((f, ctx) => {
  const needsOptions = f.type === 'choice' || f.type === 'multichoice';
  if (needsOptions && !f.options) ctx.addIssue({ code: 'custom', message: `O campo "${f.label}" precisa de opções.` });
  if (!needsOptions && f.options) ctx.addIssue({ code: 'custom', message: `O campo "${f.label}" não usa opções.` });
  if (f.options && new Set(f.options).size !== f.options.length) ctx.addIssue({ code: 'custom', message: `Opções repetidas em "${f.label}".` });
  if (f.type !== 'number' && f.type !== 'scale' && (f.min !== undefined || f.max !== undefined)) ctx.addIssue({ code: 'custom', message: `Mínimo e máximo só valem para número e escala.` });
  if (f.min !== undefined && f.max !== undefined && f.min > f.max) ctx.addIssue({ code: 'custom', message: `Mínimo maior que o máximo em "${f.label}".` });
});
export type FormField = z.infer<typeof fieldSchema>;

export const fieldsSchema = z.array(fieldSchema).min(1).max(60).refine((a) => new Set(a.map((f) => f.id)).size === a.length, 'Há campos com o mesmo identificador.');

/**
 * Confere as respostas contra o modelo que o paciente viu: tipos, opções, limites e obrigatoriedade. Campos que não existem no
 * modelo são recusados (nada de dado solto entrando no prontuário). Devolve só o que foi respondido, já normalizado.
 */
export function validateAnswers(fields: FormField[], raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('Respostas inválidas.');
  const input = raw as Record<string, unknown>;
  const known = new Set(fields.map((f) => f.id));
  for (const k of Object.keys(input)) if (!known.has(k)) throw badRequest(`Campo desconhecido: ${k.slice(0, 40)}.`);
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = input[f.id];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) { if (f.required) throw badRequest(`Responda: ${f.label}`); continue; }
    switch (f.type) {
      case 'text': case 'longtext': {
        const max = f.type === 'text' ? 200 : 2000;
        if (typeof v !== 'string' || v.trim().length > max) throw badRequest(`Resposta inválida ou longa demais: ${f.label}`);
        if (v.trim()) out[f.id] = v.trim(); else if (f.required) throw badRequest(`Responda: ${f.label}`);
        break;
      }
      case 'yesno': if (typeof v !== 'boolean') throw badRequest(`Responda sim ou não: ${f.label}`); out[f.id] = v; break;
      case 'choice': if (typeof v !== 'string' || !f.options!.includes(v)) throw badRequest(`Escolha uma das opções: ${f.label}`); out[f.id] = v; break;
      case 'multichoice': {
        if (!Array.isArray(v) || v.length > f.options!.length || v.some((x) => typeof x !== 'string' || !f.options!.includes(x)) || new Set(v).size !== v.length) throw badRequest(`Opções inválidas: ${f.label}`);
        out[f.id] = v; break;
      }
      case 'number': case 'scale': {
        const lo = f.min ?? (f.type === 'scale' ? 0 : -1e9), hi = f.max ?? (f.type === 'scale' ? 10 : 1e9);
        if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || (f.type === 'scale' && !Number.isInteger(v))) throw badRequest(`Valor inválido (entre ${lo} e ${hi}): ${f.label}`);
        out[f.id] = v; break;
      }
      case 'date': if (typeof v !== 'string' || !isRealDate(v) || v < '1900-01-01' || v > '2100-01-01') throw badRequest(`Data inválida: ${f.label}`); out[f.id] = v; break;
    }
  }
  return out;
}

/** Modelos prontos. Servem de ponto de partida: o profissional responsável deve revisar o conteúdo clínico antes do uso. */
export const DEFAULT_TEMPLATES: { key: string; name: string; fields: FormField[] }[] = [
  {
    key: 'anamnese-odontologica', name: 'Anamnese odontológica',
    fields: [
      { id: 'queixa', label: 'Qual é o motivo da consulta?', type: 'longtext', required: true },
      { id: 'dor', label: 'Sente dor agora? (0 = nenhuma, 10 = a pior)', type: 'scale', required: false },
      { id: 'tratamento_medico', label: 'Está em tratamento médico?', type: 'yesno', required: true },
      { id: 'medicamentos', label: 'Usa algum medicamento? Quais?', type: 'text', required: false },
      { id: 'alergias', label: 'Tem alergia a medicamentos, anestésicos ou látex? Quais?', type: 'text', required: false },
      { id: 'condicoes', label: 'Tem ou já teve alguma destas condições?', type: 'multichoice', required: false,
        options: ['Diabetes', 'Pressão alta', 'Problema no coração', 'Hepatite', 'HIV', 'Asma', 'Problema nos rins', 'Epilepsia', 'Anemia', 'Problema de coagulação', 'Gestante ou amamentando'] },
      { id: 'fumante', label: 'Fuma?', type: 'choice', required: false, options: ['Não', 'Sim', 'Parei de fumar'] },
      { id: 'sangramento', label: 'Suas gengivas sangram?', type: 'yesno', required: false },
      { id: 'sensibilidade', label: 'Sente sensibilidade nos dentes?', type: 'yesno', required: false },
      { id: 'ultima_visita', label: 'Quando foi a última visita ao dentista?', type: 'choice', required: false, options: ['Menos de 6 meses', 'De 6 meses a 1 ano', 'Mais de 1 ano', 'Nunca fui'] },
      { id: 'observacoes', label: 'Mais alguma informação que devemos saber?', type: 'longtext', required: false },
    ],
  },
  {
    key: 'termo-ciencia', name: 'Declaração de dados e ciência (pré-consulta)',
    fields: [
      { id: 'dados_corretos', label: 'Confirmo que os dados informados são verdadeiros', type: 'yesno', required: true },
      { id: 'alergias_conhecidas', label: 'Informei todas as minhas alergias e medicamentos', type: 'yesno', required: true },
      { id: 'observacao', label: 'Observação (opcional)', type: 'text', required: false },
    ],
  },
];
