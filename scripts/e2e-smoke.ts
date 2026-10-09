/**
 * Smoke E2E no navegador (Chromium) contra um servidor já rodando com `npm run seed` aplicado.
 *   E2E_URL=http://127.0.0.1:3100 E2E_SHOTS=/caminho npm run e2e
 * Falha em: erro de console/CSP, requisição 5xx, rolagem horizontal no celular.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright-core';
import pg from 'pg';
import { totpAt } from '../src/server/auth/totp.js';
import { decryptSecret } from '../src/server/crypto.js';

const BASE = process.env.E2E_URL ?? 'http://127.0.0.1:3000';
const SHOTS = process.env.E2E_SHOTS ?? 'e2e-shots';
const PW = process.env.DEMO_PASSWORD ?? 'Demo@12345';
mkdirSync(SHOTS, { recursive: true });

const problems: string[] = [];
function watch(page: Page, label: string) {
  page.on('console', (m) => {
    if (!['error', 'warning'].includes(m.type())) return;
    // 401/409 de fetch são respostas esperadas dos fluxos testados (sem sessão, senha errada, conflito de agenda).
    if (/Failed to load resource: the server responded with a status of (401|409)/.test(m.text())) return;
    problems.push(`[${label}] console ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${label}] pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`[${label}] HTTP ${r.status()} ${r.url()}`); });
}
async function noHorizontalScroll(page: Page, label: string) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 1) {
    const who = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
      .map((e) => `${e.tagName.toLowerCase()}.${(e as HTMLElement).className || '-'}`).slice(0, 5));
    problems.push(`[${label}] rolagem horizontal de ${over}px (elementos: ${who.join(', ')})`);
  }
}

/** Navega pelo menu principal; no celular, itens extras ficam atrás de "Mais". */
async function go(page: Page, name: string) {
  const nav = page.getByRole('navigation', { name: 'Principal' });
  const link = nav.getByRole('link', { name, exact: true });
  if (await link.isVisible()) { await link.click(); return; }
  await nav.getByRole('link', { name: 'Mais', exact: true }).click();
  await page.getByRole('main').getByRole('link', { name: new RegExp(name) }).click();
}
function step(msg: string) { console.log(`✓ ${msg}`); }
function must(cond: unknown, msg: string) { if (!cond) { problems.push(`ASSERT: ${msg}`); console.log(`✗ ${msg}`); } else step(msg); }

const OPT = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? (existsSync(OPT) ? OPT : undefined), args: ['--no-sandbox'] });

// ---------------- CELULAR: clínica ----------------
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-BR' });
  const page = await ctx.newPage();
  watch(page, 'mobile');
  await page.goto(BASE);
  await page.getByLabel('Identificador da clínica').fill('demo');
  await page.getByLabel('E-mail').fill('ritarecepcao@demo.demo');
  await page.getByLabel('Senha').fill('errada-errada');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByRole('alert').waitFor();
  must(/inválidos/.test(await page.getByRole('alert').innerText()), 'login com senha errada mostra erro claro');
  await page.screenshot({ path: `${SHOTS}/01-login-erro-mobile.png` });

  await page.getByLabel('Senha').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByRole('navigation', { name: 'Principal' }).waitFor();
  must(true, 'recepção entra na clínica');
  must(await page.getByRole('link', { name: 'Agenda' }).isVisible(), 'menu inferior mostra Agenda');
  must(await page.getByRole('link', { name: 'Recepção' }).isVisible(), 'menu mostra a fila de Recepção');
  must(await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Mais', exact: true }).isVisible(), 'menu inferior agrupa o restante em "Mais" no celular');
  await noHorizontalScroll(page, 'dashboard');
  await page.screenshot({ path: `${SHOTS}/02-inicio-mobile.png` });
  // Menu inferior: nenhum rótulo visível pode ficar cortado em celulares estreitos (360px é a largura Android mais comum).
  for (const w of [390, 360, 320]) {
    await page.setViewportSize({ width: w, height: 844 });
    const nav = await page.evaluate(() => [...document.querySelectorAll('.nav a')].map((a) => {
      const l = a.querySelector('.lbl') as HTMLElement;
      const visible = l.getBoundingClientRect().width > 2;
      return { text: l.textContent, visible, clipped: visible && (l.scrollWidth > l.clientWidth + 1 || a.scrollWidth > a.clientWidth + 1), active: a.getAttribute('aria-current') === 'page' };
    }));
    must(nav.every((n) => !n.clipped), `menu inferior sem rótulo cortado em ${w}px`);
    must(nav.filter((n) => n.active).every((n) => n.visible), `menu inferior mostra o rótulo do item ativo em ${w}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });

  await go(page, 'Agenda');
  await page.getByText('Maria Souza').first().waitFor();
  must(true, 'agenda lista consultas do dia');
  await noHorizontalScroll(page, 'agenda');
  await page.screenshot({ path: `${SHOTS}/03-agenda-mobile.png` });
  await page.getByRole('button', { name: 'Semana', exact: true }).click();
  await page.getByRole('heading', { name: /^Semana de/ }).waitFor();
  await page.getByText('Maria Souza').first().waitFor();
  await noHorizontalScroll(page, 'agenda-semana');
  must(true, 'agenda: visão semanal lista as consultas da semana');
  await page.screenshot({ path: `${SHOTS}/03b-agenda-semana-mobile.png`, fullPage: true });
  await page.getByRole('button', { name: 'Mês', exact: true }).click();
  await page.getByRole('group', { name: 'Calendário do mês' }).waitFor();
  await noHorizontalScroll(page, 'agenda-mes');
  await page.screenshot({ path: `${SHOTS}/03c-agenda-mes-mobile.png` });
  const busy = page.getByRole('group', { name: 'Calendário do mês' }).getByRole('button', { name: /: [1-9]\d* consulta/ }).first();
  await busy.waitFor();
  must(true, 'agenda: visão mensal mostra a contagem de consultas por dia');
  await busy.click();
  await page.getByText('Maria Souza').first().waitFor();
  must(await page.getByRole('button', { name: 'Dia', exact: true }).getAttribute('aria-pressed') === 'true', 'agenda: tocar num dia do mês abre a visão do dia');

  await page.getByRole('button', { name: 'Novo agendamento' }).click();
  await page.getByLabel('Paciente').fill('Joao');
  await page.getByLabel('Paciente').fill('João');
  await page.getByRole('button', { name: 'João Pereira' }).click();
  await page.getByRole('dialog').getByLabel('Profissional').selectOption({ label: 'Dr. Paulo Profissional' });
  await page.getByLabel('Horário').fill('09:30'); // conflita com a consulta de Maria? (09:00-09:50 do profissional) → deve dar conflito
  await page.getByRole('button', { name: 'Agendar consulta' }).click();
  await page.getByRole('alert').waitFor();
  must(/conflito/i.test(await page.getByRole('alert').innerText()), 'agendar em horário ocupado mostra conflito');
  await page.screenshot({ path: `${SHOTS}/04-agenda-conflito-mobile.png` });
  await page.getByRole('button', { name: 'Fechar' }).click();

  await go(page, 'Pacientes');
  await page.getByText('Beatriz Lima').waitFor();
  await noHorizontalScroll(page, 'pacientes');
  await page.screenshot({ path: `${SHOTS}/05-pacientes-mobile.png` });
  await page.getByRole('link', { name: /Beatriz Lima/ }).click();
  await page.getByRole('tab', { name: 'Dados' }).waitFor();
  must(!(await page.getByRole('tab', { name: 'Prontuário' }).count()), 'recepção NÃO vê aba Prontuário');
  must(!(await page.getByRole('tab', { name: 'Odontograma' }).count()), 'recepção NÃO vê aba Odontograma');
  must(await page.getByRole('tab', { name: 'Financeiro' }).isVisible(), 'recepção vê aba Financeiro');
  await page.getByRole('tab', { name: 'Financeiro' }).click();
  await page.getByRole('button', { name: 'Registrar lançamento' }).click();
  await page.getByLabel('Valor (R$)').fill('150,00');
  await page.getByRole('button', { name: 'Registrar', exact: true }).click();
  await page.getByText('Pagamento').first().waitFor();
  must(true, 'recepção registra pagamento Pix');
  await page.screenshot({ path: `${SHOTS}/06-financeiro-paciente-mobile.png` });

  // Comunicação: autorização do paciente → agendamento → mensagem enfileirada e enviada pelo worker (sandbox)
  await page.getByRole('tab', { name: 'Dados' }).click();
  const wa = page.getByRole('listitem').filter({ hasText: 'WhatsApp' });
  await wa.getByRole('button').first().waitFor();
  if (await wa.getByRole('button', { name: 'Registrar autorização' }).count()) { // idempotente: pode já estar autorizado de uma execução anterior
    await wa.getByRole('button', { name: 'Registrar autorização' }).click();
    await page.getByText('Autorização registrada.').waitFor();
  }
  await wa.getByText('Autorizado', { exact: true }).first().waitFor();
  must(true, 'recepção registra a autorização de WhatsApp do paciente');
  await page.screenshot({ path: `${SHOTS}/06b-consentimento-mobile.png`, fullPage: true });
  await go(page, 'Agenda');
  await page.getByRole('button', { name: 'Novo agendamento' }).click();
  await page.getByLabel('Paciente').fill('Beatriz');
  await page.getByRole('button', { name: 'Beatriz Lima' }).click();
  await page.getByRole('dialog').getByLabel('Profissional').selectOption({ label: 'Dr. Paulo Profissional' });
  // Data futura sorteada (o banco do teste pode já ter consultas de execuções anteriores); tenta outra data se colidir.
  let booked = false; let future = '';
  for (let attempt = 0; attempt < 6 && !booked; attempt++) {
    future = new Date(Date.now() + (7 + Math.floor(Math.random() * 600)) * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    await page.getByLabel('Data').fill(future);
    await page.getByLabel('Horário').fill('14:00');
    await page.getByRole('button', { name: 'Agendar consulta' }).click();
    booked = await page.getByText('Consulta agendada.').waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  }
  if (!booked) throw new Error(`agendamento futuro não confirmou. Alertas na tela: ${JSON.stringify(await page.getByRole('alert').allInnerTexts())}`);
  must(true, 'agendamento futuro criado');
  await go(page, 'Pacientes');
  await page.getByRole('link', { name: /Beatriz Lima/ }).click();
  await page.getByRole('tab', { name: 'Mensagens' }).click();
  // A mais recente aparece primeiro; ela precisa sair da fila e ficar "Enviada" (a tela se atualiza sozinha).
  const newest = page.getByRole('listitem').filter({ hasText: 'Confirmação de consulta' }).first();
  await newest.waitFor();
  await newest.locator('.badge', { hasText: 'Enviada' }).waitFor({ timeout: 25000 });
  must(true, 'confirmação enviada pelo worker (sandbox)');
  must(await page.getByText('Lembrete de consulta').first().isVisible(), 'lembrete de 24h fica agendado');
  await noHorizontalScroll(page, 'mensagens');
  await page.screenshot({ path: `${SHOTS}/06c-mensagens-mobile.png` });
  await ctx.close();
}

// ---------------- CELULAR: caixa, desconto com aprovação e recibo (proprietário) ----------------
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-BR' });
  const page = await ctx.newPage();
  watch(page, 'mobile-caixa');
  await page.goto(BASE);
  await page.getByLabel('Identificador da clínica').fill('demo');
  await page.getByLabel('E-mail').fill('dono@demo.demo');
  await page.getByLabel('Senha').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByRole('navigation', { name: 'Principal' }).waitFor();

  await go(page, 'Financeiro');
  await page.getByRole('heading', { name: 'Caixa' }).waitFor();
  await page.locator('.badge', { hasText: /^(Aberto|Fechado)$/ }).waitFor(); // espera o estado do caixa carregar antes de decidir
  if (await page.getByRole('button', { name: 'Abrir caixa' }).count()) { // idempotente: o caixa pode ter ficado aberto de uma execução anterior
    await page.getByRole('button', { name: 'Abrir caixa' }).click();
    await page.getByLabel('Troco inicial em dinheiro (R$)').fill('50,00');
    await page.getByRole('dialog').getByRole('button', { name: 'Abrir caixa' }).click();
    await page.getByText('Caixa aberto.').waitFor();
  }
  await page.getByText('Dinheiro esperado').waitFor();
  must(true, 'proprietário abre o caixa e vê o dinheiro esperado');
  await page.getByRole('button', { name: 'Suprimento', exact: true }).click();
  await page.getByLabel('Valor colocado no caixa (R$)').fill('20,00');
  await page.getByLabel('Motivo').fill('Reforço de troco e2e');
  await page.getByRole('dialog').getByRole('button', { name: 'Registrar suprimento' }).click();
  await page.getByText('Suprimento registrado.').waitFor();
  await page.getByRole('button', { name: 'Sangria', exact: true }).click();
  await page.getByLabel('Valor retirado do caixa (R$)').fill('5,00');
  await page.getByLabel('Motivo').fill('Depósito e2e');
  await page.getByRole('dialog').getByRole('button', { name: 'Registrar sangria' }).click();
  await page.getByText('Sangria registrada.').waitFor();
  await page.getByText('Reforço de troco e2e').waitFor();
  must(true, 'suprimento e sangria registrados e listados no caixa');
  await noHorizontalScroll(page, 'caixa');
  await page.screenshot({ path: `${SHOTS}/08-caixa-mobile.png`, fullPage: true });

  // cobrança → pedido de desconto → aprovação
  await go(page, 'Pacientes');
  await page.getByRole('link', { name: /Beatriz Lima/ }).click();
  await page.getByRole('tab', { name: 'Financeiro' }).click();
  await page.getByRole('button', { name: 'Registrar lançamento' }).click();
  await page.getByRole('dialog').getByLabel('Tipo').selectOption('charge');
  await page.getByLabel('Valor (R$)').fill('1000,00');
  await page.getByRole('button', { name: 'Registrar', exact: true }).click();
  await page.getByText('Lançamento registrado.').waitFor();
  await page.getByRole('button', { name: 'Pedir desconto' }).click();
  await page.getByLabel('Valor do desconto (R$)').fill('10,00');
  await page.getByLabel('Motivo').fill('Cortesia e2e');
  await page.getByRole('button', { name: 'Enviar pedido' }).click();
  await page.getByText('Pedido enviado para aprovação.').waitFor();
  must(true, 'pedido de desconto enviado para aprovação');
  await go(page, 'Financeiro');
  await page.getByRole('heading', { name: 'Descontos' }).waitFor();
  await page.getByRole('button', { name: 'Aprovar' }).first().click();
  await page.getByText('Desconto aprovado.').waitFor();
  must(true, 'desconto aprovado pelo proprietário');
  await page.screenshot({ path: `${SHOTS}/08b-descontos-mobile.png`, fullPage: true });

  // contas a pagar: cria, vê no resumo e paga
  await page.getByRole('heading', { name: 'Contas a pagar' }).waitFor();
  await page.getByRole('button', { name: 'Nova conta' }).click();
  await page.getByLabel('Descrição').fill('Aluguel e2e');
  await page.getByLabel(/^Valor/).fill('1.250,00');
  await page.getByLabel('Vencimento').fill(new Date(Date.now() + 3 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }));
  await page.getByRole('dialog').getByRole('button', { name: 'Salvar conta' }).click();
  await page.getByText('Conta salva.').waitFor();
  const conta = page.getByRole('listitem').filter({ hasText: 'Aluguel e2e' });
  await conta.getByText(/^Em 3 dias$/).waitFor();
  await conta.getByRole('button', { name: 'Pagar' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmar pagamento' }).click();
  await page.getByText('Pagamento registrado.').waitFor();
  must(true, 'contas a pagar: criar, ver vencimento próximo e pagar');
  await noHorizontalScroll(page, 'contas-a-pagar');
  await page.screenshot({ path: `${SHOTS}/08d-contas-a-pagar-mobile.png`, fullPage: true });

  // comissões: define o percentual de um profissional e vê o extrato
  await page.getByRole('heading', { name: 'Comissões' }).waitFor();
  await page.getByRole('button', { name: 'Percentuais' }).click();
  await page.getByLabel('Novo percentual (%)').first().fill('30');
  await page.getByRole('dialog').getByRole('button', { name: 'Salvar', exact: true }).first().click();
  await page.getByText('Percentual salvo.').waitFor();
  await page.getByRole('dialog').getByText(/atual: 30%/).first().waitFor();
  must(true, 'comissões: percentual do profissional definido e exibido');
  await page.getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.getByText(/hoje$/).first().waitFor();
  await noHorizontalScroll(page, 'comissoes');
  await page.screenshot({ path: `${SHOTS}/08e-comissoes-mobile.png`, fullPage: true });

  // fecha o caixa contando exatamente o esperado
  const expected = (await page.locator('.stat', { hasText: 'Dinheiro esperado' }).locator('b').innerText()).replace(/[^\d,]/g, '');
  await page.getByRole('button', { name: 'Fechar caixa' }).first().click();
  await page.getByLabel('Dinheiro contado na gaveta (R$)').fill(expected);
  await page.getByRole('dialog').getByRole('button', { name: 'Fechar caixa' }).click();
  await page.getByText('Caixa fechado.').first().waitFor();
  must(await page.getByText(/sem diferença/i).first().isVisible(), 'fechamento sem diferença');

  // recibo
  await go(page, 'Pacientes');
  await page.getByRole('link', { name: /Beatriz Lima/ }).click();
  await page.getByRole('tab', { name: 'Financeiro' }).click();
  await page.getByRole('link', { name: /Ver recibo/ }).first().click();
  await page.getByRole('heading', { name: /^Recibo/ }).waitFor();
  must(await page.getByText(/não substitui nota fiscal/).isVisible(), 'recibo informa que não é documento fiscal');
  await noHorizontalScroll(page, 'recibo');
  await page.screenshot({ path: `${SHOTS}/08c-recibo-mobile.png` });

  // Pagamento online (Mercado Pago em modo de teste interno): Pix → simular pagamento → conciliado com recibo
  await go(page, 'Pacientes');
  await page.getByRole('link', { name: /Beatriz Lima/ }).click();
  await page.getByRole('tab', { name: 'Financeiro' }).click();
  await page.getByRole('button', { name: 'Cobrar online' }).click();
  await page.getByRole('dialog').getByLabel('Valor (R$)').fill('50,00');
  await page.getByLabel('E-mail do pagador').fill('beatriz@exemplo.com');
  await page.getByRole('button', { name: 'Gerar cobrança' }).click();
  await page.getByRole('heading', { name: 'Pix gerado' }).waitFor();
  must(await page.getByText(/Aguardando o pagamento/).isVisible(), 'pagamento online: Pix gerado aguarda o pagamento');
  await page.getByRole('button', { name: 'Fechar' }).click();
  await page.getByRole('button', { name: 'Simular pagamento (teste)' }).first().click();
  await page.getByText('Pagamento confirmado.').first().waitFor();
  await page.getByText('Pago', { exact: true }).first().waitFor();
  must(true, 'pagamento online: pagamento confirmado e conciliado no financeiro');
  await page.getByRole('button', { name: 'Estornar', exact: true }).first().click();
  await page.getByLabel('Motivo do estorno').fill('Procedimento reduzido e2e');
  await page.getByLabel(/^Valor a devolver/).fill('10,00');
  await page.getByRole('dialog').getByRole('button', { name: 'Estornar parte' }).click();
  await page.getByText('Estorno parcial registrado.').waitFor();
  await page.getByText(/^Estornado R\$/).first().waitFor();
  must(true, 'pagamento online: estorno parcial devolve parte e mantém a cobrança como paga');
  await noHorizontalScroll(page, 'pagamento-online');
  await page.screenshot({ path: `${SHOTS}/12-pagamento-online-mobile.png`, fullPage: true });
  await go(page, 'Gestão');
  await page.getByRole('tab', { name: 'Pagamentos' }).click();
  await page.getByRole('heading', { name: 'Mercado Pago' }).waitFor();
  must(await page.getByText(/não validado com o Mercado Pago real/).isVisible(), 'configuração de pagamentos avisa que o provedor real ainda não foi validado');
  await noHorizontalScroll(page, 'pagamentos-config');
  await page.screenshot({ path: `${SHOTS}/12b-pagamentos-config-mobile.png`, fullPage: true });

  // Estoque: item com mínimo, entrada, alerta de estoque baixo, saída e histórico
  const itemName = `Luva e2e ${Date.now()}`;
  await go(page, 'Estoque');
  await page.getByRole('heading', { name: 'Estoque' }).waitFor();
  await page.getByRole('button', { name: 'Novo item' }).first().click();
  await page.getByLabel('Nome', { exact: true }).fill(itemName);
  await page.getByLabel('Estoque mínimo').fill('5');
  await page.getByRole('button', { name: 'Salvar item' }).click();
  await page.getByText('Item salvo.').waitFor();
  const row = page.getByRole('listitem').filter({ hasText: itemName });
  await row.getByRole('button', { name: 'Entrada' }).click();
  await page.getByLabel(/^Quantidade/).fill('3');
  await page.getByRole('dialog').getByRole('button', { name: 'Registrar entrada' }).click();
  await page.getByText('Entrada registrada.').waitFor();
  await row.getByText('Baixo', { exact: true }).waitFor();
  must(true, 'estoque: entrada abaixo do mínimo mostra o alerta "Baixo"');
  await row.getByRole('button', { name: 'Saída' }).click();
  await page.getByLabel(/^Quantidade/).fill('9');
  await page.getByRole('dialog').getByRole('button', { name: 'Registrar saída' }).click();
  await page.getByRole('alert').filter({ hasText: /Saldo insuficiente/ }).waitFor();
  must(true, 'estoque: saída maior que o saldo é recusada');
  await page.getByRole('button', { name: 'Fechar' }).click();
  await row.getByRole('button', { name: 'Histórico' }).click();
  await page.getByRole('dialog').getByText('Entrada').first().waitFor();
  await noHorizontalScroll(page, 'estoque');
  await page.screenshot({ path: `${SHOTS}/09-estoque-mobile.png` });
  await page.getByRole('button', { name: 'Fechar' }).click();
  // lote com validade próxima: aparece o aviso "Vence" e a lista de lotes
  const soon = new Date(Date.now() + 10 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  await row.getByRole('button', { name: 'Entrada' }).click();
  await page.getByLabel(/^Quantidade/).fill('2');
  await page.getByLabel('Lote (opcional)').fill('LOTE-E2E');
  await page.getByLabel('Validade (opcional)').fill(soon);
  await page.getByRole('dialog').getByRole('button', { name: 'Registrar entrada' }).click();
  await page.getByText('Entrada registrada.').waitFor();
  await row.getByText(/^Vence /).waitFor();
  await row.getByRole('button', { name: 'Lotes' }).click();
  await page.getByRole('dialog').getByText('Lote LOTE-E2E').waitFor();
  must(true, 'estoque: entrada com lote e validade mostra "Vence" e lista o lote');
  await noHorizontalScroll(page, 'estoque-lotes');
  await page.screenshot({ path: `${SHOTS}/09b-estoque-lotes-mobile.png` });
  await page.getByRole('button', { name: 'Fechar' }).click();

  // Inventário por contagem: conta um item, conclui e o saldo é ajustado
  await page.getByRole('button', { name: 'Inventário', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Iniciar inventário' }).click();
  await page.getByText('Inventário iniciado.').waitFor();
  const linha = page.getByRole('dialog').getByRole('listitem').filter({ hasText: itemName });
  await linha.getByLabel(/^Contado/).fill('10');
  await linha.getByRole('button', { name: 'Registrar' }).click();
  await linha.getByText(/Confere|\+|−|-/).first().waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Concluir e ajustar o estoque' }).click();
  await page.getByText(/Inventário concluído/).waitFor();
  must(true, 'estoque: inventário por contagem conta um item e conclui com ajuste');
  await page.getByRole('button', { name: 'Fechar', exact: true }).click();
  await row.getByText('10 un').first().waitFor();

  // Compras: fornecedor → pedido → envio → recebimento atualiza o estoque
  await page.getByRole('button', { name: 'Fornecedores', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Novo fornecedor' }).click();
  await page.getByLabel('Nome', { exact: true }).fill('Dental Sul e2e');
  await page.getByRole('dialog').getByRole('button', { name: 'Salvar fornecedor' }).click();
  await page.getByText('Fornecedor salvo.').waitFor();
  await page.getByRole('button', { name: 'Fechar', exact: true }).first().click();
  await page.getByRole('button', { name: 'Pedidos', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Novo pedido' }).click();
  await page.getByLabel('Fornecedor').selectOption({ label: 'Dental Sul e2e' });
  await page.getByLabel('Item 1').selectOption({ label: `${itemName} (un)` });
  await page.getByLabel('Quantidade').fill('5');
  await page.getByLabel('Custo unitário (R$)').fill('10,00');
  await page.getByRole('button', { name: 'Salvar rascunho' }).click();
  await page.getByText('Pedido salvo como rascunho.').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Abrir' }).first().click();
  await page.getByRole('button', { name: 'Marcar como enviado' }).click();
  await page.getByText('Pedido enviado.').waitFor();
  await page.getByLabel(/^Receber agora/).fill('5');
  await page.getByRole('button', { name: 'Registrar recebimento' }).click();
  await page.getByText('Recebimento registrado: o estoque foi atualizado.').waitFor();
  must(true, 'compras: pedido enviado e recebido entra no estoque');
  await noHorizontalScroll(page, 'compras');
  await page.screenshot({ path: `${SHOTS}/09c-pedido-compra-mobile.png` });
  for (let i = 0; i < 2; i++) await page.keyboard.press('Escape');
  await page.reload();
  await go(page, 'Estoque');
  await page.getByRole('listitem').filter({ hasText: itemName }).getByText('15 un').first().waitFor();
  must(true, 'compras: saldo do item subiu de 10 para 15 após o recebimento');

  // CRM: lead → contatado → anotação → conversão em paciente
  const leadName = `Lead E2E ${Date.now()}`;
  await go(page, 'CRM');
  await page.getByRole('heading', { name: 'CRM' }).waitFor();
  await page.getByRole('button', { name: 'Novo lead' }).first().click();
  await page.getByLabel('Nome', { exact: true }).fill(leadName);
  await page.getByLabel('Telefone').fill('(11) 97777-6543');
  await page.getByRole('dialog').getByRole('button', { name: 'Cadastrar lead' }).click();
  await page.getByText('Lead cadastrado.').waitFor();
  const lead = page.getByRole('listitem').filter({ hasText: leadName });
  await lead.getByRole('button', { name: 'Contatado' }).click();
  await page.getByText('Marcado como contatado.').waitFor();
  await lead.getByRole('button', { name: 'Anotar' }).click();
  await page.getByLabel('O que aconteceu').fill('Ligou pedindo orçamento de clareamento');
  await page.getByRole('dialog').getByRole('button', { name: 'Salvar anotação' }).click();
  await page.getByText('Anotação salva.').waitFor();
  await lead.getByRole('button', { name: 'Histórico' }).click();
  await page.getByRole('dialog').getByText('Anotação').first().waitFor();
  must(true, 'CRM: histórico do lead registra a anotação');
  await noHorizontalScroll(page, 'crm');
  await page.screenshot({ path: `${SHOTS}/10-crm-mobile.png` });
  await page.getByRole('button', { name: 'Fechar' }).click();
  await lead.getByRole('button', { name: 'Virou paciente' }).click();
  await page.getByRole('heading', { name: leadName }).waitFor();
  must(true, 'CRM: lead convertido abre a ficha do novo paciente');

  // CRM: agendar consulta direto do lead (converte e marca de uma vez)
  const lead2 = `Lead Agenda E2E ${Date.now()}`;
  await go(page, 'CRM');
  await page.getByRole('button', { name: 'Novo lead' }).first().click();
  await page.getByLabel('Nome', { exact: true }).fill(lead2);
  await page.getByLabel('Telefone').fill('(11) 96666-1234');
  await page.getByRole('dialog').getByRole('button', { name: 'Cadastrar lead' }).click();
  await page.getByText('Lead cadastrado.').waitFor();
  await page.getByRole('listitem').filter({ hasText: lead2 }).getByRole('button', { name: 'Agendar consulta' }).click();
  await page.getByRole('dialog').getByLabel('Data').fill(new Date(Date.now() + 20 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }));
  await page.getByRole('dialog').getByRole('button', { name: 'Agendar consulta' }).click();
  await page.getByText('Consulta agendada e lead convertido em paciente.').waitFor();
  must(true, 'CRM: agendar direto do lead converte em paciente e marca a consulta');

  // Indicadores
  await go(page, 'Indicadores');
  await page.getByRole('heading', { name: 'Indicadores' }).waitFor();
  await page.getByText('Taxa de falta', { exact: true }).first().waitFor();
  await page.getByRole('heading', { name: 'CRM' }).waitFor();
  must(true, 'indicadores mostram atendimentos, financeiro e CRM');
  await noHorizontalScroll(page, 'indicadores');
  await page.screenshot({ path: `${SHOTS}/11-indicadores-mobile.png`, fullPage: true });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar CSV' }).click()]);
  const csvPath = await dl.path();
  const csv = (await import('node:fs')).readFileSync(csvPath, 'utf8');
  must(dl.suggestedFilename().startsWith('indicadores-') && csv.includes('Seção;Indicador;Valor;Unidade') && csv.includes('Atendimentos;'), 'indicadores: exportação em CSV baixa o arquivo com os indicadores');
  await ctx.close();
}

// ---------------- CELULAR: profissional e prontuário ----------------
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-BR' });
  const page = await ctx.newPage();
  watch(page, 'mobile-pro');
  await page.goto(BASE);
  await page.getByLabel('Identificador da clínica').fill('demo');
  await page.getByLabel('E-mail').fill('drpauloprofissional@demo.demo');
  await page.getByLabel('Senha').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByRole('navigation', { name: 'Principal' }).waitFor();
  await go(page, 'Pacientes');
  await page.getByRole('link', { name: /Carlos Mendes/ }).click();
  await page.getByRole('tab', { name: 'Prontuário' }).click();
  const marker = `Evolução e2e ${Date.now()}`;
  await page.getByLabel('Novo registro clínico').fill(marker);
  await page.getByRole('button', { name: 'Salvar como rascunho' }).click();
  await page.getByText(marker).waitFor();
  must(true, 'profissional salva rascunho de evolução');
  await page.getByRole('button', { name: 'Assinar', exact: true }).first().click();
  await page.getByRole('button', { name: 'Assinar registro' }).click();
  await page.locator('.badge', { hasText: 'Rascunho' }).waitFor({ state: 'detached' });
  must(true, 'profissional assina o registro');
  must(!(await page.getByRole('button', { name: 'Editar rascunho' }).count()), 'registro assinado não oferece edição');
  must(await page.getByRole('button', { name: 'Registrar adendo' }).first().isVisible(), 'registro assinado oferece adendo');
  await noHorizontalScroll(page, 'prontuario');
  await page.screenshot({ path: `${SHOTS}/07-prontuario-mobile.png` });

  await page.getByRole('tab', { name: 'Odontograma' }).click();
  await page.getByRole('button', { name: /^Dente 16/ }).waitFor();
  must((await page.getByRole('button', { name: /^Dente \d\d/ }).count()) === 32, 'odontograma permanente mostra 32 dentes');
  await noHorizontalScroll(page, 'odontograma');
  await page.getByRole('button', { name: /^Dente 16/ }).click();
  await page.getByLabel('Onde').selectOption('O');
  await page.getByLabel('Condição').selectOption('caries');
  await page.getByRole('button', { name: 'Registrar achado' }).click();
  await page.getByText('Dente 16: achado registrado.').waitFor();
  await page.getByRole('heading', { name: 'Histórico do dente' }).waitFor();
  must(true, 'profissional registra cárie na face oclusal do dente 16');
  await page.screenshot({ path: `${SHOTS}/07b-dente-sheet-mobile.png` });
  await page.getByRole('button', { name: 'Fechar' }).click();
  await page.getByRole('button', { name: /^Dente 16: Cárie \(O\)/ }).waitFor();
  must(true, 'odontograma reflete o achado (texto, não só cor)');
  await page.getByRole('button', { name: 'Decídua' }).click();
  must((await page.getByRole('button', { name: /^Dente \d\d/ }).count()) === 20, 'dentição decídua mostra 20 dentes');
  await page.getByRole('button', { name: 'Permanente' }).click();
  await page.getByRole('button', { name: 'Adicionar item' }).click();
  await page.getByLabel('Procedimento').fill('Restauração em resina');
  await page.getByLabel('Valor (R$)').fill('250,00');
  await page.getByRole('button', { name: 'Adicionar ao plano' }).click();
  await page.getByText('Restauração em resina').first().waitFor();
  must(true, 'profissional adiciona item ao plano de tratamento');
  await page.screenshot({ path: `${SHOTS}/07c-odontograma-mobile.png`, fullPage: true });

  // Orçamento com versões e aceite → plano de tratamento
  const quoteProc = `Clareamento e2e ${Date.now()}`;
  await page.getByRole('button', { name: 'Novo orçamento' }).click();
  await page.getByRole('dialog').getByLabel('Procedimento', { exact: true }).fill(quoteProc);
  await page.getByRole('dialog').getByLabel('Valor (R$)').fill('300,00');
  await page.getByRole('button', { name: 'Salvar rascunho' }).click();
  await page.getByText('Rascunho criado.').waitFor();
  await page.getByRole('button', { name: 'Apresentar' }).first().click();
  await page.getByText('Orçamento apresentado.').waitFor();
  must(true, 'profissional cria e apresenta um orçamento');
  await page.getByRole('button', { name: 'Nova versão' }).first().click();
  await page.getByText('Nova versão criada como rascunho.').waitFor();
  await page.getByRole('button', { name: 'Apresentar' }).first().click();
  await page.getByText('Versões anteriores (1)').first().waitFor();
  must(true, 'nova versão do orçamento substitui a anterior');
  await page.screenshot({ path: `${SHOTS}/07d-orcamento-mobile.png`, fullPage: true });
  await page.getByRole('button', { name: 'Registrar aceite' }).first().click();
  await page.getByLabel('Nome de quem aceitou').fill('Carlos Mendes');
  await page.getByRole('dialog').getByRole('button', { name: 'Registrar aceite' }).click();
  await page.getByText(/Aceito por/).first().waitFor();
  await page.getByText(quoteProc).nth(1).waitFor(); // uma vez no orçamento e outra no plano, que recarrega após o aceite
  must(true, 'aceite leva o procedimento do orçamento para o plano de tratamento');
  await noHorizontalScroll(page, 'orcamento');
  await ctx.close();
}

// ---------------- DESKTOP: dono + Master ----------------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'pt-BR' });
  const page = await ctx.newPage();
  watch(page, 'desktop');
  await page.goto(BASE);
  await page.getByLabel('Identificador da clínica').fill('demo');
  await page.getByLabel('E-mail').fill('dono@demo.demo');
  await page.getByLabel('Senha').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByRole('navigation', { name: 'Principal' }).waitFor();
  await go(page, 'Gestão');
  await page.getByText('Ana Admin').waitFor();
  must(true, 'dono vê a equipe');
  await page.screenshot({ path: `${SHOTS}/08-equipe-desktop.png` });

  // ---- Agenda e recepção (dados novos a cada execução: profissional e paciente exclusivos) ----
  const H = { 'x-requested-with': 'clinica-one', 'content-type': 'application/json' };
  const stamp = Date.now().toString(36);
  const proName = `Dr. E2E ${stamp}`, patName = `Paciente E2E ${stamp}`, unitName = `Unidade E2E ${stamp}`, roomName = `Sala ${stamp}`;
  const apiOk = async (r: { ok(): boolean; status(): number }, what: string) => { if (!r.ok()) problems.push(`API ${what} falhou: HTTP ${r.status()}`); };
  const mkPro = await ctx.request.post(`${BASE}/api/users`, { headers: H, data: { name: proName, email: `e2e-${stamp}@demo.demo`, role: 'professional', password: PW } });
  await apiOk(mkPro, 'criar profissional');
  const mkPat = await ctx.request.post(`${BASE}/api/patients`, { headers: H, data: { name: patName, phone: `+55119${String(Date.now()).slice(-8)}`, confirmNotDuplicate: true } });
  await apiOk(mkPat, 'criar paciente');
  const patId = (await mkPat.json()).id as string;
  const proId = ((await (await ctx.request.get(`${BASE}/api/professionals`)).json()).professionals as { id: string; name: string }[]).find((p) => p.name === proName)!.id;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  await apiOk(await ctx.request.post(`${BASE}/api/appointments`, { headers: H, data: { patientId: patId, professionalId: proId, startsAt: new Date(`${today}T09:00:00-03:00`).toISOString(), endsAt: new Date(`${today}T09:30:00-03:00`).toISOString(), priceCents: 12000 } }), 'agendar hoje');

  // Recepção: chegou com prioridade → chamar → iniciar → concluir
  await go(page, 'Recepção');
  const arriving = page.getByRole('listitem').filter({ hasText: patName });
  await arriving.getByRole('button', { name: 'Chegou com prioridade' }).click();
  await page.getByRole('heading', { name: /Fila de espera \(\d+\)/ }).waitFor();
  const queued = page.getByRole('listitem').filter({ hasText: patName });
  await queued.locator('.badge', { hasText: 'Prioridade' }).waitFor();
  must(true, 'recepção: paciente entra na fila com prioridade');
  await queued.getByRole('button', { name: 'Chamar' }).click();
  await queued.locator('.badge', { hasText: 'Chamado' }).waitFor();
  must(true, 'recepção: paciente chamado');
  await queued.getByRole('button', { name: 'Iniciar atendimento' }).click();
  await page.getByRole('heading', { name: 'Em atendimento (1)' }).waitFor().catch(async () => { await page.getByRole('heading', { name: /Em atendimento \(\d+\)/ }).waitFor(); });
  const serving = page.getByRole('listitem').filter({ hasText: patName });
  await serving.getByRole('button', { name: 'Concluir atendimento' }).click();
  await page.getByText('Atendimento concluído.').waitFor();
  must(true, 'recepção: atendimento concluído (cobrança gerada)');
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalScroll(page, 'recepcao-mobile');
  await page.screenshot({ path: `${SHOTS}/08b-recepcao-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });

  // Agenda: série semanal pela interface (3 consultas) e lista de espera
  await go(page, 'Agenda');
  await page.getByRole('button', { name: 'Novo agendamento' }).click();
  await page.getByLabel('Paciente').fill(patName);
  await page.getByRole('button', { name: patName }).click();
  await page.getByRole('dialog').getByLabel('Profissional').selectOption({ label: proName });
  const future = new Date(Date.now() + 60 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  await page.getByLabel('Data').fill(future);
  await page.getByLabel('Horário').fill('10:00');
  await page.getByLabel('Repetir semanalmente').check();
  await page.getByLabel('Quantas consultas no total').fill('3');
  await page.getByRole('button', { name: 'Agendar série' }).click();
  await page.getByText('3 consultas agendadas.').waitFor();
  must(true, 'agenda: série semanal de 3 consultas criada');
  await page.getByRole('region', { name: /Lista de espera/ }).getByRole('button', { name: 'Adicionar' }).click();
  await page.getByRole('dialog').getByLabel('Paciente').fill(patName);
  await page.getByRole('dialog').getByRole('button', { name: patName }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Adicionar à lista' }).click();
  const wl = page.getByRole('region', { name: /Lista de espera/ }).getByRole('listitem').filter({ hasText: patName });
  await wl.waitFor();
  must(true, 'agenda: paciente entra na lista de espera');
  await wl.getByRole('button', { name: 'Remover da lista' }).click();
  await wl.waitFor({ state: 'detached' });
  must(true, 'agenda: paciente removido da lista de espera');

  // Pacientes: aviso de duplicidade, responsáveis, privacidade/exportação e mesclagem
  await go(page, 'Pacientes');
  await page.getByRole('button', { name: 'Novo paciente' }).click();
  await page.getByRole('dialog').getByLabel('Nome completo').fill('Maria Souza');
  await page.getByRole('dialog').getByLabel('Telefone').fill('(11) 99999-0001');
  await page.getByRole('dialog').getByRole('button', { name: 'Cadastrar paciente' }).click();
  await page.getByText('Cadastros parecidos:').waitFor();
  await page.getByText('mesmo telefone e primeiro nome').waitFor();
  must(true, 'pacientes: cadastro parecido é avisado antes de criar duplicado');
  await page.getByRole('dialog').getByRole('button', { name: 'Fechar' }).click();

  await page.getByLabel('Buscar por nome, telefone ou documento').fill(patName);
  await page.getByRole('link', { name: new RegExp(patName) }).click();
  await page.getByRole('heading', { name: 'Responsáveis' }).waitFor();
  await page.getByRole('region', { name: 'Responsáveis' }).getByRole('button', { name: 'Adicionar' }).click();
  await page.getByRole('dialog').getByLabel('Nome', { exact: true }).fill('Mãe E2E');
  await page.getByRole('dialog').getByLabel('Parentesco').fill('Mãe');
  await page.getByRole('dialog').getByLabel('É o responsável legal').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Adicionar responsável' }).click();
  await page.getByText('Responsável legal').waitFor();
  must(true, 'pacientes: responsável legal cadastrado');

  await page.getByRole('region', { name: 'Privacidade e dados' }).getByRole('button', { name: 'Registrar solicitação' }).click();
  await page.getByRole('dialog').getByLabel('Tipo').selectOption({ label: 'Cópia / portabilidade' });
  await page.getByRole('dialog').getByRole('button', { name: 'Registrar solicitação' }).click();
  await page.getByText('Solicitação registrada.').waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar dados do paciente' }).click()]);
  const exported = JSON.parse(await (await import('node:fs/promises')).readFile((await download.path())!, 'utf8'));
  must(exported.format === 'clinica-one/export/v1' && exported.records[0].name === patName && exported.guardians.length === 1, 'pacientes: exportação baixa o arquivo com os dados do paciente');
  await go(page, 'Gestão');
  await page.getByRole('tab', { name: 'Privacidade' }).click();
  const req = page.getByRole('listitem').filter({ hasText: patName });
  await req.getByRole('button', { name: 'Concluir' }).click();
  await page.getByRole('dialog').getByLabel('Resposta dada ao titular').fill('Cópia entregue ao titular');
  await page.getByRole('dialog').getByRole('button', { name: 'Concluir' }).click();
  await req.waitFor({ state: 'detached' });
  must(true, 'privacidade: solicitação concluída com resposta registrada');

  const docNum = `9${String(Date.now()).slice(-10)}`;
  for (const n of ['A', 'B']) await apiOk(await ctx.request.post(`${BASE}/api/patients`, { headers: H, data: { name: `Dup ${n} ${stamp}`, document: docNum, confirmNotDuplicate: true } }), `criar duplicado ${n}`);
  await go(page, 'Pacientes');
  await page.getByRole('button', { name: 'Possíveis duplicados' }).click();
  const pair = page.getByRole('listitem').filter({ hasText: `Dup A ${stamp}` });
  await pair.getByText('mesmo documento').waitFor();
  await pair.getByRole('button', { name: `Manter “Dup A ${stamp}”` }).click();
  await page.getByRole('dialog').getByLabel('Motivo da mesclagem').fill('Cadastro repetido (teste)');
  await page.getByRole('dialog').getByRole('button', { name: 'Mesclar cadastros' }).click();
  await pair.waitFor({ state: 'detached' });
  must(true, 'pacientes: duplicados revisados e mesclados pela interface');

  // Gestão: unidade → sala → horário → bloqueio (e remoção com confirmação)
  await go(page, 'Gestão');
  await page.getByRole('tab', { name: 'Unidades e salas' }).click();
  await page.getByRole('button', { name: 'Nova unidade' }).click();
  await page.getByLabel('Nome da unidade').fill(unitName);
  await page.getByRole('dialog').getByRole('button', { name: 'Criar unidade' }).click();
  await page.getByText(unitName).waitFor();
  await page.getByRole('button', { name: 'Nova sala ou equipamento' }).click();
  await page.getByRole('dialog').getByLabel('Unidade').selectOption({ label: unitName });
  await page.getByRole('dialog').getByLabel('Nome').fill(roomName);
  await page.getByRole('dialog').getByRole('button', { name: 'Cadastrar' }).click();
  await page.getByText(`Sala: ${roomName}`).waitFor();
  must(true, 'gestão: unidade e sala cadastradas');
  await page.getByRole('tab', { name: 'Horários' }).click();
  await page.getByRole('button', { name: 'Adicionar horário' }).click();
  await page.getByRole('dialog').getByLabel('Profissional').selectOption({ label: proName });
  await page.getByRole('dialog').getByLabel('Dia da semana').selectOption({ label: 'Segunda' });
  await page.getByRole('dialog').getByRole('button', { name: 'Adicionar horário' }).click();
  await page.getByRole('listitem').filter({ hasText: proName }).getByText('Segunda · 08:00–12:00').waitFor();
  must(true, 'gestão: horário de atendimento cadastrado');
  await page.getByRole('tab', { name: 'Bloqueios' }).click();
  await page.getByRole('button', { name: 'Novo bloqueio' }).click();
  await page.getByRole('dialog').getByLabel('Início (data)').fill('2032-01-01');
  await page.getByRole('dialog').getByLabel('Fim (data)').fill('2032-01-01');
  await page.getByRole('dialog').getByLabel('Motivo').fill(`Feriado E2E ${stamp}`);
  await page.getByRole('dialog').getByRole('button', { name: 'Criar bloqueio' }).click();
  const blk = page.getByRole('listitem').filter({ hasText: `Feriado E2E ${stamp}` });
  await blk.waitFor();
  must(true, 'gestão: bloqueio de agenda criado');
  page.once('dialog', (d) => void d.accept());
  await blk.getByRole('button', { name: 'Remover bloqueio' }).click();
  await blk.waitFor({ state: 'detached' });
  must(true, 'gestão: bloqueio removido com confirmação');
  await go(page, 'Agenda');
  await page.getByText('Maria Souza').first().waitFor();
  await page.screenshot({ path: `${SHOTS}/09-agenda-desktop.png` });

  // MFA da clínica: ativar, sair, entrar exigindo código, desativar (usa a administradora e deixa a conta como estava)
  {
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'pt-BR' });
    const mp = await mctx.newPage();
    watch(mp, 'mfa');
    const email = 'anaadmin@demo.demo';
    const login = async (code?: string) => {
      await mp.goto(BASE);
      await mp.getByLabel('Identificador da clínica').fill('demo');
      await mp.getByLabel('E-mail').fill(email);
      await mp.getByLabel('Senha').fill(PW);
      await mp.getByRole('button', { name: 'Entrar' }).click();
      if (code !== undefined) {
        await mp.getByLabel('Código do autenticador (6 dígitos)').fill(code);
        await mp.getByRole('button', { name: 'Entrar' }).click();
      }
    };
    await login();
    await mp.getByRole('navigation', { name: 'Principal' }).waitFor();
    await mp.getByRole('button', { name: /Conta de/ }).click();
    await mp.getByRole('button', { name: 'Ativar', exact: true }).click();
    await mp.getByLabel('Confirme sua senha').fill(PW);
    await mp.getByRole('button', { name: 'Continuar' }).click();
    const secret = (await mp.locator('code').innerText()).trim();
    must(/^[A-Z2-7]{32}$/.test(secret), 'MFA: chave de configuração exibida');
    must(await mp.getByRole('link', { name: 'Abrir no aplicativo' }).getAttribute('href').then((h) => !!h && h.startsWith('otpauth://')), 'MFA: link otpauth:// para abrir o app autenticador no celular');
    await mp.getByLabel('Código de 6 dígitos').fill(totpAt(secret, Date.now() - 30000));
    await mp.getByRole('button', { name: 'Ativar verificação' }).click();
    await mp.getByText('Verificação em duas etapas ativada.').waitFor();
    must(true, 'MFA da clínica ativado pela interface');
    await mp.getByRole('button', { name: 'Fechar' }).click();
    await mp.getByRole('button', { name: /Conta de/ }).click();
    await mp.getByRole('button', { name: 'Sair' }).click();
    await login();
    await mp.getByLabel('Código do autenticador (6 dígitos)').waitFor();
    must(/código do aplicativo/i.test(await mp.getByRole('alert').innerText()), 'MFA: login pede o código quando a conta tem 2 etapas');
    await mp.getByLabel('Código do autenticador (6 dígitos)').fill('000000');
    await mp.getByRole('button', { name: 'Entrar' }).click();
    await mp.getByText(/Código ou credenciais inválidos/).waitFor();
    must(true, 'MFA: código errado é recusado');
    await mp.getByLabel('Código do autenticador (6 dígitos)').fill(totpAt(secret, Date.now()));
    await mp.getByRole('button', { name: 'Entrar' }).click();
    await mp.getByRole('navigation', { name: 'Principal' }).waitFor();
    must(true, 'MFA: login com código válido');
    await mp.getByRole('button', { name: /Conta de/ }).click();
    await mp.getByRole('button', { name: 'Desativar', exact: true }).click();
    await mp.getByLabel('Senha', { exact: true }).fill(PW);
    await mp.getByLabel('Código de 6 dígitos').fill(totpAt(secret, Date.now() + 30000));
    await mp.getByRole('button', { name: 'Desativar verificação' }).click();
    await mp.getByText('Verificação em duas etapas desativada.').waitFor();
    must(true, 'MFA da clínica desativado (conta restaurada)');
    await mctx.close();
  }

  // Master
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_PLATFORM ?? 'postgres://clinica_platform:dev_platform_pw@127.0.0.1:5432/clinica_one' });
  const row = (await pool.query<{ totp_secret: string; totp_last_step: string | null }>("SELECT totp_secret, totp_last_step FROM platform_users WHERE email = 'master@demo.local'")).rows[0]!;
  await pool.end();
  const secret = decryptSecret(row.totp_secret);
  // Cada passo TOTP vale uma vez: escolhe o próximo ainda não usado (aguarda se a janela estiver esgotada).
  const last = row.totp_last_step ? Number(row.totp_last_step) : -1;
  let masterStep: number | undefined;
  while (masterStep === undefined) {
    const cur = Math.floor(Date.now() / 30000);
    masterStep = [cur, cur + 1].find((st) => st > last);
    if (masterStep === undefined) await new Promise((r) => setTimeout(r, 5000));
  }
  const masterCode = totpAt(secret, masterStep * 30000);
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-BR' });
  const mp = await m.newPage();
  watch(mp, 'master-mobile');
  await mp.goto(`${BASE}/#/master`);
  await mp.getByLabel('E-mail').fill('master@demo.local');
  await mp.getByLabel('Senha').fill(PW);
  await mp.getByLabel('Código MFA (6 dígitos)').fill('000000');
  await mp.getByRole('button', { name: 'Entrar' }).click();
  await mp.getByRole('alert').waitFor();
  must(/inválidos/.test(await mp.getByRole('alert').innerText()), 'Master recusa código MFA inválido');
  await mp.getByLabel('Código MFA (6 dígitos)').fill(masterCode);
  await mp.getByRole('button', { name: 'Entrar' }).click();
  await mp.getByRole('heading', { name: 'Clínicas' }).waitFor();
  must(true, 'Master entra com senha + MFA');
  await mp.getByText('Clínica Demo Sorriso').waitFor();
  await noHorizontalScroll(mp, 'master');
  await mp.screenshot({ path: `${SHOTS}/10-master-clinicas-mobile.png` });
  await mp.getByRole('button', { name: /Clínica Demo Sorriso/ }).click();
  await mp.getByText('Convênios/TISS estão bloqueados globalmente').waitFor();
  must(true, 'Master mostra TISS bloqueado globalmente');
  await mp.screenshot({ path: `${SHOTS}/11-master-clinica-mobile.png` });
  await mp.getByRole('button', { name: 'Fechar' }).click();
  await mp.getByRole('link', { name: 'Integrações' }).click();
  await mp.getByRole('heading', { name: 'Integrações' }).waitFor();
  await mp.getByText('Aguardando credenciais').first().waitFor();
  must(true, 'Master mostra provedores aguardando credenciais (sem expor segredos)');
  await mp.getByRole('button', { name: 'Simular um erro' }).click();
  await mp.getByRole('heading', { name: 'Últimos avisos deste servidor' }).waitFor();
  await mp.getByText('ERRO SIMULADO').first().waitFor();
  must(true, 'Master: alerta de erro simulado feito pelo próprio sistema aparece no histórico');
  await noHorizontalScroll(mp, 'master-integracoes');
  await mp.screenshot({ path: `${SHOTS}/12-master-integracoes-mobile.png`, fullPage: true });
  await m.close();
  await ctx.close();
}

// ---------------- NOVOS FLUXOS: kits de estoque, documentos do paciente e recuperação de senha ----------------
for (const vp of [{ name: 'desktop', width: 1280, height: 800, mobile: false }, { name: 'mobile', width: 390, height: 844, mobile: true }]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile, locale: 'pt-BR', acceptDownloads: true });
  const page = await ctx.newPage();
  watch(page, `novos-fluxos-${vp.name}`);
  await page.goto(BASE);
  await page.getByLabel('Identificador da clínica').fill('demo');
  await page.getByLabel('E-mail').fill('dono@demo.demo');
  await page.getByLabel('Senha').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByRole('navigation', { name: 'Principal' }).waitFor();

  // Kit de materiais de um procedimento
  await go(page, 'Estoque');
  await page.getByRole('button', { name: 'Kits', exact: true }).click();
  const kit = page.getByRole('dialog');
  await kit.getByLabel('Procedimento', { exact: true }).fill('Restauração E2E');
  await kit.getByLabel('Material').selectOption({ index: 1 });
  await kit.getByLabel('Quantidade por procedimento').fill('1,5');
  await kit.getByRole('button', { name: 'Salvar no kit' }).click();
  await kit.getByRole('heading', { name: 'restauração e2e' }).waitFor();
  must(true, `kits (${vp.name}): material cadastrado para o procedimento`);
  await noHorizontalScroll(page, `kits-${vp.name}`);
  await page.screenshot({ path: `${SHOTS}/13-kits-${vp.name}.png` });
  await page.getByRole('button', { name: 'Fechar' }).click();

  // Documentos do paciente: anexar, listar, baixar
  await go(page, 'Pacientes');
  await page.getByRole('link', { name: /Beatriz Lima/ }).click();
  await page.getByRole('tab', { name: 'Documentos' }).click();
  await page.locator('#doc-file').setInputFiles({ name: 'exame-e2e.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nexame e2e\n%%EOF') });
  await page.getByLabel('Título', { exact: true }).fill('Exame E2E');
  await page.getByRole('button', { name: 'Anexar', exact: true }).click();
  await page.getByText('Documento anexado.').waitFor();
  await page.getByText('Exame E2E').first().waitFor();
  must(true, `documentos (${vp.name}): PDF anexado aparece na lista`);
  await noHorizontalScroll(page, `documentos-${vp.name}`);
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Baixar' }).first().click();
  must((await dl).suggestedFilename() === 'exame-e2e.pdf', 'documentos: download devolve o arquivo com o nome original');
  await page.screenshot({ path: `${SHOTS}/14-documentos-${vp.name}.png` });
  // XSS armazenado: nome com HTML/script aparece como texto e nada executa
  if (vp.name === 'desktop') {
    const evil = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> Teste${Date.now() % 100000}`;
    let dialogs = 0; page.on('dialog', (d) => { dialogs++; void d.dismiss(); });
    await page.evaluate(async (n) => { await fetch('/api/patients', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'clinica-one' }, body: JSON.stringify({ name: n, confirmNotDuplicate: true }) }); }, evil);
    await go(page, 'Pacientes');
    await page.getByText(evil, { exact: false }).first().waitFor();
    must((await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)) === undefined && dialogs === 0, 'XSS: nome com HTML/script é exibido como texto e nada executa');
    must((await page.locator('main img[src="x"]').count()) === 0, 'XSS: nenhuma tag injetada no DOM');
  }
  await ctx.close();
}

{
  // Esqueci minha senha: o link aparece no log do worker (modo sandbox)
  const logs = (process.env.E2E_WORKER_LOG ?? '/tmp/worker.log,/tmp/srv.log').split(',').filter((f) => existsSync(f));
  if (logs.length) {
    const rctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, locale: 'pt-BR' });
    const rp = await rctx.newPage();
    watch(rp, 'recuperar-senha');
    await rp.goto(BASE);
    await rp.getByRole('link', { name: 'Esqueci minha senha' }).click();
    await rp.getByRole('heading', { name: 'Esqueci minha senha' }).waitFor();
    await rp.waitForLoadState('networkidle');
    await rp.getByLabel('Identificador da clínica').fill('demo');
    await rp.getByLabel('E-mail cadastrado').fill('fabiofinanceiro@demo.demo');
    await rp.getByRole('button', { name: 'Enviar link de redefinição' }).click();
    await rp.getByText(/Se o e-mail estiver cadastrado/).waitFor({ timeout: 8000 }).catch(async () => { console.log('DEBUG página:', (await rp.locator('main').innerText()).replace(/\n+/g, ' | ')); await rp.screenshot({ path: '/tmp/forgot-fail.png' }); throw new Error('mensagem de link não apareceu'); });
    must(true, 'recuperação de senha: resposta neutra ao pedir o link');
    let link = '';
    for (let i = 0; i < 40 && !link; i++) {
      const found = logs.flatMap((f) => readFileSync(f, 'utf8').match(/\[sandbox e-mail\][^\n]*?(http\S+)/g) ?? []);
      link = found?.at(-1)?.match(/(http\S+)/)?.[1] ?? '';
      if (!link) await new Promise((r) => setTimeout(r, 500));
    }
    must(!!link, 'recuperação de senha: o worker entregou o link (sandbox)');
    if (link) {
      await rp.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
      await rp.getByLabel('Nova senha', { exact: true }).fill(PW);
      await rp.getByLabel('Repita a nova senha').fill(PW);
      await rp.getByRole('button', { name: 'Salvar nova senha' }).click();
      await rp.getByText(/Senha alterada/).waitFor();
      must(true, 'recuperação de senha: nova senha salva');
      await rp.screenshot({ path: `${SHOTS}/15-senha-redefinida-mobile.png` });
      await rp.goto(BASE);
      await rp.getByLabel('Identificador da clínica').fill('demo');
      await rp.getByLabel('E-mail').fill('fabiofinanceiro@demo.demo');
      await rp.getByLabel('Senha').fill(PW);
      await rp.getByRole('button', { name: 'Entrar' }).click();
      await rp.getByRole('navigation', { name: 'Principal' }).waitFor();
      must(true, 'recuperação de senha: login com a nova senha funciona');
    }
    await rctx.close();
  } else step('recuperação de senha: pulado (sem log do worker)');
}

// ---------------- PORTAL DO PACIENTE (celular): convite pela equipe, entrada, confirmar, pedir horário, baixar documento ----------------
{
  const staffCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'pt-BR' });
  const staff = await staffCtx.newPage();
  watch(staff, 'portal-equipe');
  await staff.goto(BASE);
  await staff.getByLabel('Identificador da clínica').fill('demo');
  await staff.getByLabel('E-mail').fill('dono@demo.demo');
  await staff.getByLabel('Senha').fill(PW);
  await staff.getByRole('button', { name: 'Entrar' }).click();
  await staff.getByRole('navigation', { name: 'Principal' }).waitFor();
  const api = (method: string, url: string, body?: unknown) => staff.evaluate(async ({ method, url, body }) => {
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'clinica-one' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }, { method, url, body });
  const suffix = String(Date.now() % 100000);
  const pat = await api('POST', '/api/patients', { name: `Paciente Portal ${suffix}`, birthDate: '1992-04-23', confirmNotDuplicate: true });
  const pid = pat.json.id as string;
  const pros = (await api('GET', '/api/professionals')).json.professionals as { id: string }[];
  const start = new Date(Date.now() + 5 * 86_400_000); start.setUTCHours(15, 0, 0, 0);
  const ap = await api('POST', '/api/appointments', { patientId: pid, professionalId: pros[0]!.id, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 1_800_000).toISOString(), service: 'Consulta', encaixe: true });
  const doc = await api('POST', `/api/patients/${pid}/documents`, { title: 'Orientações pós-consulta', category: 'other', fileName: 'orientacoes.pdf', contentBase64: Buffer.from('%PDF-1.4\norientacoes\n%%EOF').toString('base64') });
  await api('POST', `/api/documents/${doc.json.id}/share`, { shared: true });
  must(ap.status === 200 && doc.status === 200, `portal: dados de teste criados (consulta ${ap.status} ${JSON.stringify(ap.json).slice(0, 120)}; documento ${doc.status})`);

  // a equipe gera o link pela tela da ficha do paciente
  await staff.goto(`${BASE}/#/pacientes/${pid}`);
  await staff.getByRole('button', { name: 'Gerar link de acesso' }).click();
  const link = await staff.getByRole('textbox', { name: 'Link de acesso', exact: true }).inputValue();
  must(/#\/portal\?clinic=demo&token=/.test(link), 'portal: a equipe gera o link de acesso pela ficha do paciente');
  await staffCtx.close();

  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-BR', acceptDownloads: true });
  const pp = await pctx.newPage();
  watch(pp, 'portal-paciente');
  await pp.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await pp.getByRole('heading', { name: 'Confirme que é você' }).waitFor();
  await pp.getByLabel('Data de nascimento').fill('1990-01-01');
  await pp.getByRole('button', { name: 'Entrar' }).click();
  await pp.getByRole('alert').waitFor();
  must(/não conferem|inválido/i.test(await pp.getByRole('alert').innerText()), 'portal: data errada não entra e a mensagem não revela detalhes');
  await pp.getByLabel('Data de nascimento').fill('1992-04-23');
  await pp.getByRole('button', { name: 'Entrar' }).click();
  await pp.getByRole('heading', { name: 'Próximas consultas' }).waitFor();
  must(!pp.url().includes('token='), 'portal: o link de uso único sai do endereço depois de entrar');
  await pp.getByRole('button', { name: 'Confirmar presença' }).click();
  await pp.getByText('Presença confirmada.').waitFor();
  await pp.getByText('Confirmada', { exact: true }).first().waitFor();
  must(true, 'portal: paciente confirma a presença');
  await noHorizontalScroll(pp, 'portal');
  await pp.screenshot({ path: `${SHOTS}/16-portal-mobile.png`, fullPage: true });
  const dl = pp.waitForEvent('download');
  await pp.getByRole('button', { name: 'Baixar' }).click();
  must((await dl).suggestedFilename() === 'orientacoes.pdf', 'portal: paciente baixa o documento liberado');
  await pp.getByRole('button', { name: 'Pedir consulta' }).click();
  await pp.getByLabel('Qual dia e horário você prefere?').fill('Terças de manhã');
  await pp.getByRole('button', { name: 'Enviar pedido' }).click();
  await pp.getByText('Pedido enviado.').waitFor();
  await pp.getByRole('heading', { name: 'Meus pedidos' }).waitFor();
  must(true, 'portal: paciente pede uma consulta e vê o pedido em análise');
  await pp.getByRole('button', { name: 'Sair' }).click();
  await pp.getByRole('heading', { name: 'Sessão encerrada' }).waitFor();
  must(true, 'portal: sair encerra a sessão');
  await pctx.close();
}

await browser.close();
if (problems.length) { console.log('\nPROBLEMAS:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log('\nE2E OK — sem erros de console/CSP, sem 5xx, sem rolagem horizontal.');
