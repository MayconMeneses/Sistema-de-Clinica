// Gera as capturas de tela do README (docs/img) a partir de um banco recém-criado só com os dados FICTÍCIOS de demonstração.
//   npm run setup:dev && npm start &   (porta 3000, ou defina E2E_URL)   ->   npx tsx scripts/readme-shots.ts
import { existsSync, mkdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright-core';

const BASE = process.env.E2E_URL ?? 'http://127.0.0.1:3000';
const OUT = process.env.SHOTS_DIR ?? 'docs/img';
const PW = process.env.DEMO_PASSWORD ?? 'Demo@12345';
mkdirSync(OUT, { recursive: true });
const OPT = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? (existsSync(OPT) ? OPT : undefined), args: ['--no-sandbox'] });

async function login(page: Page, email: string) {
  await page.goto(BASE);
  await page.getByLabel('Identificador da clínica').fill('demo');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByRole('navigation', { name: 'Principal' }).waitFor();
}
const settle = async (page: Page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(400); };
async function go(page: Page, name: string) {
  const nav = page.getByRole('navigation', { name: 'Principal' });
  const link = nav.getByRole('link', { name, exact: true });
  if (await link.isVisible()) await link.click();
  else { await nav.getByRole('link', { name: 'Mais', exact: true }).click(); await page.getByRole('main').getByRole('link', { name: new RegExp(name) }).click(); }
  await settle(page);
}

// ---- desktop (dono)
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();
  await login(page, 'dono@demo.demo');
  await settle(page);
  await page.screenshot({ path: `${OUT}/inicio.png` });
  await go(page, 'Agenda'); await page.screenshot({ path: `${OUT}/agenda.png` });
  await go(page, 'Pacientes'); await page.screenshot({ path: `${OUT}/pacientes.png` });
  await page.getByRole('link', { name: /Carlos Mendes/ }).first().click(); await settle(page);
  await page.getByRole('tab', { name: 'Odontograma' }).click(); await settle(page);
  await page.screenshot({ path: `${OUT}/odontograma.png` });
  await go(page, 'Financeiro'); await page.screenshot({ path: `${OUT}/financeiro.png` });
  await go(page, 'Estoque'); await page.screenshot({ path: `${OUT}/estoque.png` });
  await go(page, 'Indicadores'); await page.screenshot({ path: `${OUT}/indicadores.png` });
  await ctx.close();
}
// ---- celular (recepção)
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();
  await login(page, 'ritarecepcao@demo.demo');
  await go(page, 'Agenda'); await page.screenshot({ path: `${OUT}/agenda-celular.png` });
  await go(page, 'Recepção'); await page.screenshot({ path: `${OUT}/recepcao-celular.png` });
  await ctx.close();
}
await browser.close();
console.log(`Capturas gravadas em ${OUT}`);
