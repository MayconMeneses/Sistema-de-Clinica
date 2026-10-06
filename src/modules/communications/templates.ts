export type TemplateName = 'appointment_confirmation' | 'appointment_reminder' | 'appointment_cancelled' | 'appointment_rescheduled';
export interface TemplateVars { patient: string; clinic: string; professional: string; when: string }

const sign = '\n\nPara deixar de receber mensagens, avise a clínica.';

/** Textos em pt-BR. No WhatsApp, o provedor exige template pré-aprovado com este mesmo nome (parâmetros na ordem de `vars`). */
const T: Record<TemplateName, (v: TemplateVars) => { subject: string; body: string }> = {
  appointment_confirmation: (v) => ({ subject: `Consulta agendada — ${v.clinic}`, body: `Olá, ${v.patient}! Sua consulta com ${v.professional} na ${v.clinic} está agendada para ${v.when}.${sign}` }),
  appointment_reminder: (v) => ({ subject: `Lembrete de consulta — ${v.clinic}`, body: `Olá, ${v.patient}! Lembrete: sua consulta com ${v.professional} na ${v.clinic} é ${v.when}. Se não puder comparecer, avise a clínica.${sign}` }),
  appointment_cancelled: (v) => ({ subject: `Consulta cancelada — ${v.clinic}`, body: `Olá, ${v.patient}. Sua consulta de ${v.when} com ${v.professional} na ${v.clinic} foi cancelada. Entre em contato para remarcar.${sign}` }),
  appointment_rescheduled: (v) => ({ subject: `Consulta remarcada — ${v.clinic}`, body: `Olá, ${v.patient}! Sua consulta com ${v.professional} na ${v.clinic} foi remarcada para ${v.when}.${sign}` }),
};

export function renderTemplate(name: TemplateName, v: TemplateVars) {
  const r = T[name](v);
  return { ...r, vars: [v.patient, v.professional, v.clinic, v.when] };
}
export const isTemplate = (n: string): n is TemplateName => n in T;

export const whenLabel = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
