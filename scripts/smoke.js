// Test dymny w przeglądarce: ładuje aplikację, klika po widokach, robi zrzuty ekranu.
// Użycie: node scripts/smoke.js <url> <katalog-na-zrzuty>
const { chromium } = require('playwright');
const path = require('path');

const url = process.argv[2] || 'http://localhost:8080/';
const out = process.argv[3] || '.';

const seed = {
  v: 3,
  loan: { name: 'Kredyt – Tiggo', amount: 88700, rate: 4.99, n: 60, inst: 1673.47, first: 1759.53, start: '2026-10-15', mode: 'shorten', income: 7000 },
  baseSchedule: null, bankSchedule: null,
  payments: [
    { id: 'a', type: 'nadplata', date: '2026-10-02', amount: 800, note: 'premia', ts: 1 },
    { id: 'b', type: 'rata', date: '2026-10-15', amount: 1759.53, note: '', ts: 2 },
    { id: 'c', type: 'rata', date: '2026-11-15', amount: 1673.47, note: '', ts: 3 },
    { id: 'd', type: 'nadplata', date: '2026-11-20', amount: 500, note: '', ts: 4 },
    { id: 'e', type: 'rata', date: '2026-12-15', amount: 1673.47, note: '', ts: 5 }
  ]
};

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const [name, vp, scheme] of [['mobile', { width: 390, height: 844 }, 'light'], ['desktop', { width: 1280, height: 900 }, 'dark']]) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_CERT/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
    await page.clock.install({ time: new Date('2027-01-10T12:00:00') });
    await page.goto(url);
    await page.evaluate(s => {
      const st = JSON.parse(s);
      st.baseSchedule = window.KredytEngine.contractSchedule(st.loan.start);
      localStorage.setItem('kredyt-app-v3', JSON.stringify(st));
    }, JSON.stringify(seed));
    await page.reload();
    await page.waitForTimeout(400);
    for (const v of ['dash', 'pay', 'sched', 'sim', 'set']) {
      await page.click(`nav.tabs button[data-v="${v}"]`);
      if (v === 'sim') { await page.fill('#wm', '500'); await page.dispatchEvent('#wm', 'input'); }
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) errors.push(`${name}/${v}: poziome przewijanie ${overflow}px`);
      await page.screenshot({ path: path.join(out, `${name}-${v}.png`), fullPage: true });
    }
    // Dodanie wpłaty przez formularz
    await page.click('nav.tabs button[data-v="pay"]');
    await page.click('#seg button[data-t="nadplata"]');
    await page.fill('#pa', '1000');
    await page.click('#pf-submit');
    const count = await page.evaluate(() => JSON.parse(localStorage.getItem('kredyt-app-v3')).payments.length);
    if (count !== 6) errors.push(`${name}: po dodaniu wpłaty jest ${count} zamiast 6`);
    // Hover na wykresie
    await page.click('nav.tabs button[data-v="dash"]');
    await page.locator('#c-bal svg').scrollIntoViewIfNeeded();
    const box = await page.locator('#c-bal svg').boundingBox();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
    await page.waitForTimeout(150);
    const tip = await page.locator('#c-bal .tip').isVisible();
    if (!tip) errors.push(`${name}: brak podpowiedzi na wykresie`);
    await page.locator('#c-bal').screenshot({ path: path.join(out, `${name}-tooltip.png`) });
    await ctx.close();
  }
  // Migracja ze starej wersji
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url);
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('kredyt-auto-v2', JSON.stringify({ loan: { name: 'Stary', amount: 88700, rate: 4.99, n: 60, inst: 1673.47, first: 1759.53, start: '2026-10-15', sched: true }, pays: [{ id: 'x', date: '2026-10-01', amount: 800, type: 'nadplata', ts: 5 }] }));
  });
  await page.reload();
  const mig = await page.evaluate(() => JSON.parse(localStorage.getItem('kredyt-app-v3')));
  if (!mig || mig.payments.length !== 1 || mig.loan.name !== 'Stary' || !mig.baseSchedule) errors.push('migracja z v2 nie zadziałała');
  await browser.close();
  console.log(errors.length ? 'BŁĘDY:\n' + errors.join('\n') : 'OK: brak błędów');
  process.exit(errors.length ? 1 : 0);
})();
