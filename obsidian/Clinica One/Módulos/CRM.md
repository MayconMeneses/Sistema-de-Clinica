---
tags: [modulo]
projeto: Clínica One
atualizado: 2026-10-07
---

# CRM

Volta: [[00 - Índice]] · [[04 - Arquitetura]]

Capability `crm.pipeline`. Perfis: marketing, recepção, gerente, administrador e proprietário.

- **Lead** é alguém que ainda não é paciente. Precisa de telefone ou e-mail. Etapas: novo → contatado → agendado → **virou paciente** ou **perdido** (a perda exige motivo e pode ser reaberta).
- **Histórico imutável** de cada lead: cadastro, mudanças de etapa, anotações, troca de responsável e consentimento. Leads não são excluídos.
- **Consentimento de marketing** é um fato registrado (quando autorizou ou revogou). Sem ele, não se envia propaganda. Este sistema ainda **não envia** mensagens de campanha.
- **Conversão em paciente:** exige permissão de cadastrar pacientes (marketing não tem). Se já existe cadastro parecido, o sistema avisa e deixa ligar o lead a ele ou confirmar que é outra pessoa. Lead ganho não volta atrás.
- Contatos para hoje ou atrasados aparecem num filtro.
- Pendente: campanhas e envio (depende de provedor), agendar direto a partir do lead.

![[anexos/10-crm-mobile.png|300]]
