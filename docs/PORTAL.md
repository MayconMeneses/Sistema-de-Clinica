# Portal do paciente

Capability `patient.portal` (planos Gestão, Completa e Enterprise). Endereço do paciente: `/#/portal`.

## Como o paciente entra
1. A recepção abre a ficha do paciente (aba **Dados**) e clica em **Gerar link de acesso**. O paciente precisa ter **data de nascimento** cadastrada.
2. A recepção envia o link (por exemplo, pelo WhatsApp). O link vale **48 horas** e **só funciona uma vez**; um novo link cancela o anterior.
3. O paciente abre o link e informa a data de nascimento. Depois de **5 erros** o link trava. A sessão dura 8 horas.
O envio automático do link por WhatsApp/e-mail ainda não existe (depende do provedor de mensagens): hoje a equipe copia e envia.

## O que o paciente pode fazer
- Ver as próprias consultas, **confirmar presença**, **cancelar** (imediato se faltar 24 h ou mais; em cima da hora vira um pedido que a recepção decide).
- **Pedir** uma nova consulta ou outro horário (a recepção atende pela tela **Recepção › Pedidos do portal**).
- Baixar os **documentos que a clínica liberar** (aba Documentos › "Liberar no portal"). Exames e laudos só podem ser liberados por quem tem acesso ao prontuário.

## Segurança
- Sessão própria (cookie `ps`, restrito a `/api/portal`, `HttpOnly`, `SameSite=Strict`); nenhuma rota da equipe aceita essa sessão e vice-versa.
- Dentro da clínica, **toda consulta ao banco do portal filtra pelo próprio paciente**; testado com sessões de outro paciente da mesma clínica e de outra clínica (`tests/portal.test.ts`).
- Falhas de entrada têm sempre a mesma mensagem; há limite de tentativas por IP e por clínica.
- Tudo que o paciente faz fica na auditoria da clínica (`portal.*`).
- Não há cadastro livre nem recuperação de acesso pelo paciente: um novo link só sai da clínica.

## Limites conhecidos
Não há agendamento automático com horários livres (o paciente pede e a recepção marca). Orçamento, financeiro e prontuário não aparecem no portal.
