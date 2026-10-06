-- 0002_seed_catalog: planos comerciais e capabilities iniciais (spec §5, §6).
-- Mapeamento plano→capability é PROPOSTA técnica inicial; preços/quotas ficam pendentes (decisão do proprietário).

INSERT INTO plans (code, name, sort_order) VALUES
  ('solo',      'Solo',              1),
  ('essencial', 'Clínica Essencial', 2),
  ('gestao',    'Clínica Gestão',    3),
  ('completa',  'Clínica Completa',  4),
  ('enterprise','Rede Enterprise',   5);

INSERT INTO capabilities (code, description, globally_available, depends_on) VALUES
  ('patient.registry',      'Cadastro de pacientes',            true,  '{}'),
  ('schedule.core',         'Agenda',                           true,  '{patient.registry}'),
  ('schedule.online',       'Agendamento online',               true,  '{schedule.core}'),
  ('clinical.record',       'Prontuário eletrônico',            true,  '{patient.registry}'),
  ('finance.basic',         'Financeiro básico',                true,  '{patient.registry}'),
  ('finance.advanced',      'Financeiro avançado',              true,  '{finance.basic}'),
  ('communication.inbox',   'Inbox de comunicação',             true,  '{patient.registry}'),
  ('crm.pipeline',          'CRM e pipeline',                   true,  '{patient.registry}'),
  ('inventory.core',        'Estoque',                          true,  '{}'),
  ('dental.odontogram',     'Odontograma',                      true,  '{clinical.record}'),
  ('care.telehealth',       'Teleatendimento',                  true,  '{schedule.core,clinical.record}'),
  ('tiss.billing',          'Convênios/TISS (bloqueado nesta fase)', false, '{finance.advanced}'),
  ('analytics.bi',          'BI e indicadores',                 true,  '{}'),
  ('integration.api',       'API e webhooks',                   true,  '{}');

INSERT INTO plan_capabilities (plan_code, capability_code) VALUES
  ('solo','patient.registry'),('solo','schedule.core'),('solo','clinical.record'),('solo','finance.basic'),
  ('essencial','patient.registry'),('essencial','schedule.core'),('essencial','clinical.record'),
  ('essencial','finance.basic'),('essencial','communication.inbox'),
  ('gestao','patient.registry'),('gestao','schedule.core'),('gestao','clinical.record'),
  ('gestao','finance.basic'),('gestao','communication.inbox'),('gestao','finance.advanced'),
  ('gestao','crm.pipeline'),('gestao','inventory.core'),('gestao','analytics.bi'),
  ('completa','patient.registry'),('completa','schedule.core'),('completa','schedule.online'),
  ('completa','clinical.record'),('completa','finance.basic'),('completa','communication.inbox'),
  ('completa','finance.advanced'),('completa','crm.pipeline'),('completa','inventory.core'),
  ('completa','analytics.bi'),('completa','dental.odontogram'),('completa','care.telehealth'),
  ('completa','integration.api'),
  ('enterprise','patient.registry'),('enterprise','schedule.core'),('enterprise','schedule.online'),
  ('enterprise','clinical.record'),('enterprise','finance.basic'),('enterprise','communication.inbox'),
  ('enterprise','finance.advanced'),('enterprise','crm.pipeline'),('enterprise','inventory.core'),
  ('enterprise','analytics.bi'),('enterprise','dental.odontogram'),('enterprise','care.telehealth'),
  ('enterprise','integration.api');
