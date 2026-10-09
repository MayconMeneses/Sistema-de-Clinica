# Escopo por unidade (gerente de unidade)

Só o perfil **gerente de unidade** é restrito; os demais perfis não mudam. Ele é vinculado a uma ou mais unidades (Gestão › Usuários › Unidades). **Sem unidade vinculada, não enxerga nada.**

## Regras
| Área | O que o gerente vê e faz |
|---|---|
| **Agenda** | consultas das suas unidades (sala; sem sala, o profissional) |
| **Pacientes** | quem tem consulta na sua unidade **ou** foi cadastrado por ele. Tudo que depende do paciente (documentos, imagens, formulários, triagem, financeiro do paciente, mensagens, portal, privacidade, responsáveis, consentimentos) segue a mesma regra. Paciente de outra unidade "não existe": 404, sem vazar nome |
| **Duplicidade** | o aviso ao cadastrar considera só os pacientes que ele enxerga. Duplicatas entre unidades são resolvidas por quem tem a mesclagem (dono/administração) |
| **Estoque** | itens da sua unidade (lê e escreve) e o **estoque central** (só consulta). Cria item só na sua unidade. Não vê inventário geral, kits (edição), pedidos de compra nem fornecedores |
| **CRM** | leads da sua unidade. Cria lead só na sua unidade. Só liga/converte para pacientes que enxerga |
| **Financeiro** | só o do paciente que enxerga; descontos e cobranças online idem. Caixa, resumo, contas a pagar ficam fora (são da clínica inteira) |
| **Indicadores** | só a parte de atendimentos da sua unidade |

Configurações da clínica inteira (como o agendamento online do portal) não estão disponíveis para o gerente de unidade.

## Como é imposto
- Uma única tabela, `src/server/scope-policy.ts`, classifica cada rota (`open`, `handled`, `deny`, `patient`, `body:*`, `via:*`) e roda **antes** do handler, para o gerente. Rota que ele alcança e não está na tabela é recusada.
- `tests/unit-scope-data.test.ts` falha se uma rota nova alcançável pelo gerente não for classificada; `tests/pentest2.test.ts` ataca todas as rotas de paciente com um paciente de outra unidade.
- Estoque e leads ganharam `unit_id` (opcional; vazio = central / sem unidade, o comportamento anterior).

## Limites conhecidos
- Um paciente atendido em duas unidades é visto pelas duas. Paciente de uma unidade que passa a ser atendido na outra só é encontrado pelo gerente da segunda depois da primeira consulta marcada por quem tem acesso amplo.
- Leads sem unidade só aparecem para quem não tem escopo.
