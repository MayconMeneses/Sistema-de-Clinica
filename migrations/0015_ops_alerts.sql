-- 0015_ops_alerts: estado operacional dos alertas (silenciar, posição do bot no Telegram). Não contém dados de clínica nem de paciente.
-- O worker passa a enxergar o diretório slug→clínica só para nomear a clínica nos alertas ("Clínica demo"), nunca dados dela.
CREATE TABLE ops_alert_state (
  key         text PRIMARY KEY CHECK (length(key) <= 60),
  value       jsonb NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON ops_alert_state TO clinica_platform, clinica_worker;
GRANT SELECT ON tenant_directory TO clinica_worker;
