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

- Preencher **formulários pedidos pela clínica** (anamnese etc.). As respostas são validadas no servidor contra o modelo, não podem ser alteradas depois de enviadas e **nunca voltam para o portal**; só owner e profissional leem (aba Formulários do paciente). Recepção e demais perfis veem apenas se foi respondido.

## Marcar a própria consulta (agendamento online)
Desligado por padrão. A clínica liga em **Gestão › Agendamento online**: escolhe os profissionais, a duração, a antecedência mínima, até quantos dias à frente e quantas marcações abertas cada paciente pode ter (padrão 2).
- O paciente só vê **horários livres** de profissionais liberados que tenham horário de atendimento cadastrado (Gestão › Horários). Ficam de fora: horários ocupados, bloqueios da agenda (do profissional ou da clínica inteira), consultas do próprio paciente e o que está dentro da antecedência mínima.
- Ao confirmar, o servidor **recalcula** os horários livres: um horário inventado ou já ocupado é recusado (409). Dois pacientes disputando o mesmo horário: um leva, o outro recebe aviso. O conflito final é decidido pelo banco.
- A consulta entra na agenda como qualquer outra (status "agendada", serviço configurado, marcada como vinda do portal) e dispara a mensagem de confirmação se o paciente consentiu. O cancelamento segue a regra das 24 h.

## Segurança
- Sessão própria (cookie `ps`, restrito a `/api/portal`, `HttpOnly`, `SameSite=Strict`); nenhuma rota da equipe aceita essa sessão e vice-versa.
- Dentro da clínica, **toda consulta ao banco do portal filtra pelo próprio paciente**; testado com sessões de outro paciente da mesma clínica e de outra clínica (`tests/portal.test.ts`).
- Falhas de entrada têm sempre a mesma mensagem; há limite de tentativas por IP e por clínica.
- Tudo que o paciente faz fica na auditoria da clínica (`portal.*`).
- Não há cadastro livre nem recuperação de acesso pelo paciente: um novo link só sai da clínica.

## Limites conhecidos
O agendamento online não escolhe sala nem equipamento, não cobra e não cobre convênio; o paciente só marca com profissionais liberados e em horários já cadastrados. Quem preferir, continua pedindo e a recepção marca. Orçamento, financeiro e prontuário não aparecem no portal.
