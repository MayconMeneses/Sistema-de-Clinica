# Plano de resposta a incidentes de segurança (RASCUNHO)

> **Rascunho técnico para revisão do especialista.** Prazos e obrigações de comunicação (LGPD art. 48) devem ser confirmados por advogado. Não testado em simulação.

## 1. O que é um incidente
Acesso não autorizado, perda, alteração ou vazamento de dados pessoais; credencial comprometida; falha que expôs dados de uma clínica a outra; indisponibilidade prolongada.

## 2. Como o incidente é detectado hoje
- Alertas no Telegram da operação (componente, clínica, rota, arquivo:linha): `docs/ALERTAS.md`.
- Trilha de auditoria da clínica e da plataforma (quem leu/alterou o quê).
- Relato de cliente ou paciente.

## 3. Primeiras 24 horas
| Passo | Responsável | Como |
|---|---|---|
| 1. Registrar hora, quem relatou, o que se sabe | operador de plantão | planilha/ata do incidente |
| 2. Conter | operador | suspender a clínica afetada ou o usuário (Master/Gestão: derruba sessões na hora); trocar credenciais expostas; revogar tokens de provedores |
| 3. Preservar evidências | operador | não apagar logs; exportar `audit_events` do período; guardar o backup mais recente |
| 4. Avaliar o alcance | operador + especialista | quais clínicas, quais titulares, quais dados (saúde?) |
| 5. Acionar o encarregado/advogado | dono da plataforma | decidir comunicação |

## 4. Comunicação (a definir com o especialista)
- À **clínica controladora**: sem demora, com o que se sabe (a clínica decide sobre titulares e ANPD, conforme contrato de operador).
- À **ANPD e titulares**: se houver risco ou dano relevante; prazo a confirmar (a LGPD fala em "prazo razoável"; a regulamentação da ANPD deve ser consultada).
- Conteúdo mínimo (art. 48 §1º, a confirmar): descrição da natureza dos dados, titulares envolvidos, medidas de segurança, riscos, motivos de demora, medidas tomadas.

## 5. Depois
Causa raiz · correção com teste que reproduz o problema · revisão de acessos · lições aprendidas · atualizar o modelo de ameaças.

## 6. Contatos (preencher)
Encarregado/DPO: ______ · Advogado: ______ · Hospedagem: ______ · Provedores: ______
