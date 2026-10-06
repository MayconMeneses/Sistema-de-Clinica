/**
 * Smoke E2E no navegador (Chromium) contra um servidor já rodando com `npm run seed` aplicado.
 *   E2E_URL=http://127.0.0.1:3100 E2E_SHOTS=/caminho npm run e2e
 * Falha em: erro de console/CSP, requisição 5xx, rolagem horizontal no celular.
 */
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright-core';
import pg from 'pg';
import { totpAt } from '../src/server/auth/totp.js';

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
  if (over > 1) problems.push(`[${label}] rolagem horizontal de ${over}px`);
}
function step(msg: string) { console.log(`✓ ${msg}`); }
function must(cond: unknown, msg: string) { if (!cond) { problems.push(`ASSERT: ${msg}`); console.log(`✗ ${msg}`); } else step(msg); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });

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
  must(!(await page.getByRole('link', { name: 'Equipe' }).count()), 'recepção NÃO vê Equipe');
  await noHorizontalScroll(page, 'dashboard');
  await page.screenshot({ path: `${SHOTS}/02-inicio-mobile.png` });

  await page.getByRole('link', { name: 'Agenda' }).click();
  await page.getByText('Maria Souza').first().waitFor();
  must(true, 'agenda lista consultas do dia');
  await noHorizontalScroll(page, 'agenda');
  await page.screenshot({ path: `${SHOTS}/03-agenda-mobile.png` });

  await page.getByRole('button', { name: 'Novo agendamento' }).click();
  await page.getByLabel('Paciente').fill('Joao');
  await page.getByLabel('Paciente').fill('João');
  await page.getByRole('button', { name: 'João Pereira' }).click();
  await page.getByLabel('Horário').fill('09:30'); // conflita com a consulta de Maria? (09:00-09:50 do profissional) → deve dar conflito
  await page.getByRole('button', { name: 'Agendar consulta' }).click();
  await page.getByRole('alert').waitFor();
  must(/conflito/i.test(await page.getByRole('alert').innerText()), 'agendar em horário ocupado mostra conflito');
  await page.screenshot({ path: `${SHOTS}/04-agenda-conflito-mobile.png` });
  await page.getByRole('button', { name: 'Fechar' }).click();

  await page.getByRole('link', { name: 'Pacientes' }).click();
  await page.getByText('Beatriz Lima').waitFor();
  await noHorizontalScroll(page, 'pacientes');
  await page.screenshot({ path: `${SHOTS}/05-pacientes-mobile.png` });
  await page.getByRole('link', { name: /Beatriz Lima/ }).click();
  await page.getByRole('tab', { name: 'Dados' }).waitFor();
  must(!(await page.getByRole('tab', { name: 'Prontuário' }).count()), 'recepção NÃO vê aba Prontuário');
  must(await page.getByRole('tab', { name: 'Financeiro' }).isVisible(), 'recepção vê aba Financeiro');
  await page.getByRole('tab', { name: 'Financeiro' }).click();
  await page.getByRole('button', { name: 'Registrar lançamento' }).click();
  await page.getByLabel('Valor (R$)').fill('150,00');
  await page.getByRole('button', { name: 'Registrar', exact: true }).click();
  await page.getByText('Pagamento').first().waitFor();
  must(true, 'recepção registra pagamento Pix');
  await page.screenshot({ path: `${SHOTS}/06-financeiro-paciente-mobile.png` });
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
  await page.getByRole('link', { name: 'Pacientes' }).click();
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
  await page.getByRole('link', { name: 'Equipe' }).click();
  await page.getByText('Ana Admin').waitFor();
  must(true, 'dono vê a equipe');
  await page.screenshot({ path: `${SHOTS}/08-equipe-desktop.png` });
  await page.getByRole('link', { name: 'Agenda' }).click();
  await page.getByText('Maria Souza').first().waitFor();
  await page.screenshot({ path: `${SHOTS}/09-agenda-desktop.png` });

  // Master
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_PLATFORM ?? 'postgres://clinica_platform:dev_platform_pw@127.0.0.1:5432/clinica_one' });
  const secret = (await pool.query<{ totp_secret: string }>("SELECT totp_secret FROM platform_users WHERE email = 'master@demo.local'")).rows[0]!.totp_secret;
  await pool.end();
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
  await mp.getByLabel('Código MFA (6 dígitos)').fill(totpAt(secret, Date.now()));
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
  await m.close();
  await ctx.close();
}

await browser.close();
if (problems.length) { console.log('\nPROBLEMAS:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log('\nE2E OK — sem erros de console/CSP, sem 5xx, sem rolagem horizontal.');
