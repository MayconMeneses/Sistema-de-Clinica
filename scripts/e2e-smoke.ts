/**
 * Smoke E2E no navegador (Chromium) contra um servidor já rodando com `npm run seed` aplicado.
 *   E2E_URL=http://127.0.0.1:3100 E2E_SHOTS=/caminho npm run e2e
 * Falha em: erro de console/CSP, requisição 5xx, rolagem horizontal no celular.
 */
import { existsSync, mkdirSync } from 'node:fs';
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
  if (over > 1) problems.push(`[${label}] rolagem horizontal de ${over}px`);
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
  must(!(await page.getByRole('tab', { name: 'Odontograma' }).count()), 'recepção NÃO vê aba Odontograma');
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
  await m.close();
  await ctx.close();
}

await browser.close();
if (problems.length) { console.log('\nPROBLEMAS:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log('\nE2E OK — sem erros de console/CSP, sem 5xx, sem rolagem horizontal.');
