// Testy wersji lokalnej w prawdziwej przeglądarce (Chromium przez Playwright).
// Uruchomienie:  NODE_PATH=$(npm root -g) node testy/test-przegladarka.js
//   (a) tryb przeglądarki z dysku (file://): zapis przez UI, odświeżenie, druga karta na żywo,
//       restart przeglądarki, logo, eksport CSV i kopii, brak żądań do internetu
//   (b) tryb serwera: dwa „urządzenia” na żywo, logo u obu, restart serwera, utrata połączenia
//   (c) brak błędów w konsoli (w fazach bez celowo wywołanych awarii)
//   (d) semantyka API bazy (where/orderBy/limit/onSnapshot/docChanges/update/...)
//   (e) tryby awaryjne: localStorage, sama pamięć (z ostrzeżeniem), brak BroadcastChannel (Safari 14)
//   (b2) serwer niedostępny przy otwarciu, (b3) serwer przywrócony z kopii, (b4) ukryta karta zwalnia SSE
//   (f) nowe funkcje aplikacji w obu trybach: wydruki WZ/PZ, rozliczenie CSV, kopia tam i z powrotem
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { execSync } = require('child_process');
const { KATALOG, tymczasowyKatalog, uruchomSerwer, wolnyPort, PNG_1X1 } = require('./pomocnicy-serwera');
const { zbuduj } = require('../narzedzia/zbuduj');

function wczytajPlaywright() {
  try { return require('playwright'); }
  catch (e) { return require(path.join(execSync('npm root -g').toString().trim(), 'playwright')); }
}
const { chromium } = wczytajPlaywright();

const INDEX = path.join(KATALOG, 'index.html');
const URL_PLIKU = pathToFileURL(INDEX).href;
const BANER_OFFLINE = 'Brak połączenia z serwerem — zmiany nie są zapisywane';
const sprzatanie = [];
let przegladarka;

// EP_ZRODLO=testy/baseline-v2.html — sprawdzenie zgodności z inną (np. zamrożoną) wersją aplikacji:
//   node narzedzia/zbuduj.js --zrodlo testy/baseline-v2.html && EP_ZRODLO=testy/baseline-v2.html node testy/test-przegladarka.js
const ZRODLO = process.env.EP_ZRODLO ? path.resolve(process.env.EP_ZRODLO) : path.join(KATALOG, 'zrodlo', 'aplikacja.html');
before(async () => {
  const zbudowany = zbuduj(fs.readFileSync(ZRODLO, 'utf8'));
  assert.ok(fs.existsSync(INDEX) && fs.readFileSync(INDEX, 'utf8') === zbudowany,
    `index.html jest nieaktualny względem ${path.relative(KATALOG, ZRODLO)} — uruchom: node narzedzia/zbuduj.js`);
  przegladarka = await chromium.launch();
});
after(async () => {
  if (przegladarka) await przegladarka.close();
  for (const d of sprzatanie) fs.rmSync(d, { recursive: true, force: true });
});

/* ---------------------------- pomocniki ---------------------------- */
function sledz(page, nazwa) {
  page.bledy = [];
  page.on('pageerror', (e) => page.bledy.push(`[${nazwa}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') page.bledy.push(`[${nazwa}] console.error: ${m.text()}`); });
  return page;
}
// czeka, aż aplikacja połączy się z bazą i pokaże kurierów
async function gotowa(page) {
  await page.waitForFunction(() => window.EP_LOCAL && window.EP_LOCAL.mode && document.querySelectorAll('.courier-card').length > 0, null, { timeout: 20000 });
}
async function saldo(page, oczekiwane, ms = 10000) {
  await page.waitForFunction((t) => document.getElementById('sidebarBalance').textContent === t, oczekiwane, { timeout: ms })
    .catch(async () => { throw new Error(`saldo: oczekiwano "${oczekiwane}", jest "${await page.textContent('#sidebarBalance')}"`); });
}
async function czekajNaToast(page, wzor, blad = false, ms = 10000) {
  await page.waitForFunction(([src, flags, err]) => {
    const re = new RegExp(src, flags);
    return [...document.querySelectorAll('#toastRoot .toast')].some((t) => re.test(t.textContent) && (!err || t.classList.contains('err')));
  }, [wzor.source, wzor.flags, blad], { timeout: ms }).catch(async () => {
    throw new Error(`Brak komunikatu ${wzor}. Widoczne: ${JSON.stringify(await page.$$eval('#toastRoot .toast', (ts) => ts.map((t) => t.className + ': ' + t.textContent)))}`);
  });
}
// klik w widoczny przycisk nawigacji (pasek boczny na komputerze, dolny pasek na telefonie)
const idzDo = (page, widok) => page.locator(`[data-view="${widok}"]:visible`).first().click();
async function dodajOperacje(page, { kurier, typ = 'wydanie', ilosc, uwagi = '' }) {
  await idzDo(page, 'new');
  await page.waitForSelector('#opForm');
  await page.click(`#opForm label.opt-${typ}`);
  await page.selectOption('#kurierSelect', kurier);
  await page.fill('#opForm input[name="ilosc"]', String(ilosc));
  if (uwagi) await page.fill('#opForm textarea[name="uwagi"]', uwagi);
  await page.click('#opForm button[type="submit"]');
}
async function wgrajLogo(page, kurierId, buf) {
  await idzDo(page, 'couriers');
  await page.click(`[data-action="edit-courier"][data-id="${kurierId}"]`);
  await page.setInputFiles('#editLogoInput', { name: 'logo.png', mimeType: 'image/png', buffer: buf });
  await czekajNaToast(page, /Logo zaktualizowane/);
  await page.click('#modalRoot [data-action="close-modal"]');
  await idzDo(page, 'dashboard');
}
// czeka, aż obrazek z danym adresem (fragmentem) wyrenderuje się poprawnie
async function logoWidoczne(page, fragmentSrc) {
  await page.waitForFunction((f) => [...document.querySelectorAll('img')].some((i) => i.getAttribute('src') && i.getAttribute('src').includes(f) && i.complete && i.naturalWidth > 0), fragmentSrc, { timeout: 10000 })
    .catch(async () => { throw new Error(`logo z "${fragmentSrc.slice(0, 60)}" nie wyrenderowało się; obrazki: ${JSON.stringify(await page.$$eval('img', (is) => is.map((i) => (i.getAttribute('src') || '').slice(0, 60))))}`); });
}
async function idLogo(page, kurierId) {
  return page.evaluate((id) => window.claude.use('db').then((db) => db.collection('couriers').doc(id).get()).then((s) => s.data().logoAssetId), kurierId);
}
// pobranie pliku wywołanego kliknięciem: {nazwa, tekst}
async function pobierz(page, selektor) {
  const [d] = await Promise.all([page.waitForEvent('download'), page.click(selektor)]);
  return { nazwa: d.suggestedFilename(), sciezka: await d.path(), tekst: fs.readFileSync(await d.path(), 'utf8') };
}
// „Ustawienia i kopia → Wczytaj kopię z pliku” → tryb → (Zastąp: potwierdzenie) → komunikat
const doUstawien = (page) => page.locator('#settingsNav:visible, #settingsMobile:visible').first().click();
async function wczytajKopie(page, plik, tryb) {
  await doUstawien(page);
  await page.waitForSelector('#backupFile', { state: 'attached' });
  await page.setInputFiles('#backupFile', plik);
  await page.waitForSelector('#importGo');
  await page.check(`#modalRoot input[name="importMode"][value="${tryb}"]`);
  await page.click('#importGo');
  // aplikacja pyta o potwierdzenie „Zastąp” tylko wtedy, gdy ma już jakieś operacje
  const maOperacje = await page.evaluate(() => typeof transactions !== 'undefined' && transactions.length > 0);
  if (tryb === 'replace' && maOperacje) { await page.waitForSelector('#confirmBtn'); await page.click('#confirmBtn'); }
  await czekajNaToast(page, /Wczytano kopię/, false, 60000);
}
// wydruk WZ/PZ z historii: podgląd, „Drukuj / PDF” (window.print), „Pobierz plik” (.html)
async function sprawdzWydruk(page) {
  await idzDo(page, 'history');
  await page.waitForSelector('[data-action="print-op"]');
  await page.evaluate(() => { window.__wydruki = 0; window.print = () => { window.__wydruki++; }; });
  await page.locator('[data-action="print-op"]:visible').first().click();
  await page.waitForSelector('.print-overlay .print-page .doc');
  await page.click('[data-print="print"]');
  assert.equal(await page.evaluate(() => window.__wydruki), 1, 'Drukuj / PDF wywołuje window.print()');
  const plik = await pobierz(page, '[data-print="download"]');
  assert.match(plik.nazwa, /^(WZ|PZ)-\d{5}\.html$/);
  assert.match(plik.tekst, /^<!DOCTYPE html>/);
  assert.ok(plik.tekst.includes(plik.nazwa.replace('.html', '')), 'numer dokumentu w pliku');
  assert.match(plik.tekst, /Dowód (wydania|zwrotu) palet/);
  await page.click('[data-print="close"]');
  return plik;
}
// rozliczenie kuriera: CSV i wydruk
async function sprawdzRozliczenie(page, kurierId, nr) {
  await idzDo(page, 'dashboard');
  await page.click(`.courier-card[data-id="${kurierId}"]`);
  await page.waitForSelector('[data-action="st-csv"]');
  const csv = await pobierz(page, '[data-action="st-csv"]');
  assert.match(csv.nazwa, new RegExp(`^rozliczenie-${kurierId}-\\d{4}-\\d{2}-\\d{2}-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
  assert.equal(csv.tekst.charCodeAt(0), 0xFEFF, 'CSV z BOM (Excel)');
  assert.ok(csv.tekst.includes(nr), `w rozliczeniu brak ${nr}`);
  await page.click('[data-action="st-print"]');
  await page.waitForSelector('.print-overlay .print-page');
  const html = await pobierz(page, '[data-print="download"]');
  assert.match(html.nazwa, new RegExp(`^rozliczenie-${kurierId}-.*\\.html$`));
  assert.ok(html.tekst.includes(nr));
  await page.click('[data-print="close"]');
}
const liczbaOperacji = (page) => page.evaluate(() => window.claude.use('db').then((db) => db.collection('transactions').get()).then((s) => s.size));
const tylkoSiec = (bledy) => bledy.filter((b) => !/Failed to load resource|net::ERR_|ERR_CONNECTION|EventSource|Brak połączenia z serwerem|Serwer nie odpowiada/.test(b));

/* ======================================================================
   (a) file:// — tryb przeglądarki
   ====================================================================== */
test('(a) file://: zapis przez UI, odświeżenie, druga karta na żywo, restart przeglądarki, logo, CSV, kopia', { timeout: 120000 }, async () => {
  const profil = tymczasowyKatalog('ep-profil-'); sprzatanie.push(profil);
  let ctx = await chromium.launchPersistentContext(profil, { viewport: { width: 1300, height: 900 }, acceptDownloads: true });
  const zadaniaSieciowe = [];
  ctx.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) zadaniaSieciowe.push(r.url()); });
  try {
    const A = sledz(await ctx.newPage(), 'A');
    await A.goto(URL_PLIKU);
    await gotowa(A);
    const ep = await A.evaluate(() => ({ mode: EP_LOCAL.mode, storage: EP_LOCAL.storage, label: EP_LOCAL.label }));
    assert.equal(ep.mode, 'browser');
    assert.equal(ep.storage, 'indexeddb');
    assert.match(ep.label, /przeglądarce/);
    assert.equal(await A.$('[data-ep-banner]'), null, 'w normalnym trybie przeglądarki nie ma paska ostrzeżenia');

    const B = sledz(await ctx.newPage(), 'B');
    await B.goto(URL_PLIKU);
    await gotowa(B);
    await saldo(B, '0 szt.');

    await dodajOperacje(A, { kurier: 'inpost', ilosc: 13, uwagi: 'test plikowy zażółć' });
    await czekajNaToast(A, /Zarejestrowano wydanie palet \(WZ-00001\)/);
    await saldo(A, '13 szt.');
    await saldo(B, '13 szt.'); // druga karta bez odświeżania

    await dodajOperacje(B, { kurier: 'dhl', typ: 'zwrot', ilosc: 3 });
    await czekajNaToast(B, /Zarejestrowano zwrot palet \(PZ-00001\)/);
    await saldo(A, '10 szt.');

    await A.reload(); await gotowa(A);
    await saldo(A, '10 szt.');
    await idzDo(A, 'history');
    await A.waitForFunction(() => document.getElementById('main').innerText.includes('test plikowy zażółć'));

    // logo: zapis w IndexedDB, widoczne w obu kartach jako data URL
    await wgrajLogo(A, 'dpd', PNG_1X1);
    const daneLogo = `data:image/png;base64,${PNG_1X1.toString('base64')}`;
    await logoWidoczne(A, daneLogo);
    await idzDo(B, 'dashboard'); // B po zapisie operacji jest w historii
    await logoWidoczne(B, daneLogo);
    const lid = await idLogo(A, 'dpd');
    assert.match(lid, /^[a-z0-9]{20}$/);
    assert.equal(await A.evaluate((id) => EP_LOCAL.assetUrl(id), lid), daneLogo);
    assert.equal(await A.evaluate(() => EP_LOCAL.assetUrl('nie-ma-takiego')), null);

    // eksport CSV (downloads.save)
    await idzDo(A, 'history');
    const [csv] = await Promise.all([A.waitForEvent('download'), A.click('[data-action="export-csv"]')]);
    assert.match(csv.suggestedFilename(), /^historia-palet-\d{4}-\d{2}-\d{2}\.csv$/);
    const tresc = fs.readFileSync(await csv.path(), 'utf8');
    assert.ok(tresc.charCodeAt(0) === 0xFEFF, 'CSV z BOM (Excel)');
    assert.match(tresc, /zażółć/);

    // kopia zapasowa aplikacji: logo dołączone jako data URL (fetch(assetSrc(id)))
    await A.click('#settingsNav');
    await A.waitForSelector('[data-action="backup-export"]');
    const [kop] = await Promise.all([A.waitForEvent('download'), A.click('[data-action="backup-export"]')]);
    const kopia = JSON.parse(fs.readFileSync(await kop.path(), 'utf8'));
    assert.equal(kopia.app, 'ewidencja-palet');
    assert.equal(kopia.transactions.length, 2);
    assert.equal(kopia.logos[lid], daneLogo);
    assert.match(await A.textContent('#main'), /Tryb przeglądarki/);

    // czcionki lokalne, także polskie znaki (latin-ext)
    const czcionki = await A.evaluate(async () => {
      await document.fonts.load('600 16px "Space Grotesk"', 'ąęłńśźż'); await document.fonts.load('500 16px "IBM Plex Mono"', 'ąę 123');
      await document.fonts.ready;
      return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family}|${f.weight}|${f.unicodeRange}`);
    });
    assert.ok(czcionki.some((f) => /^Space Grotesk\|600\|U\+0?100-0?2BA/i.test(f)), `brak latin-ext Space Grotesk: ${czcionki}`);
    assert.ok(czcionki.some((f) => f.startsWith('IBM Plex Mono|500')), `brak IBM Plex Mono: ${czcionki}`);

    assert.deepEqual([...A.bledy, ...B.bledy], [], 'błędy w konsoli (file://)');
    assert.deepEqual(zadaniaSieciowe, [], 'wersja z dysku nie może sięgać do internetu');
  } finally { await ctx.close(); }

  // restart przeglądarki z tym samym profilem — dane nadal są
  ctx = await chromium.launchPersistentContext(profil, { viewport: { width: 1300, height: 900 } });
  try {
    const C = sledz(await ctx.newPage(), 'C');
    await C.goto(URL_PLIKU);
    await gotowa(C);
    await saldo(C, '10 szt.');
    await logoWidoczne(C, `data:image/png;base64,${PNG_1X1.toString('base64')}`);
    assert.deepEqual(C.bledy, []);
  } finally { await ctx.close(); }
});

/* ======================================================================
   (b) tryb serwera
   ====================================================================== */
test('(b) serwer: dwa urządzenia na żywo, logo u obu, restart serwera, utrata połączenia', { timeout: 180000 }, async () => {
  const dane = tymczasowyKatalog(); sprzatanie.push(dane);
  const port = await wolnyPort();
  let srv = await uruchomSerwer({ dataDir: dane, port });
  const url = `http://localhost:${port}/`;
  const ctxA = await przegladarka.newContext({ viewport: { width: 1300, height: 900 } });
  const ctxB = await przegladarka.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); // „telefon”
  try {
    const A = sledz(await ctxA.newPage(), 'A');
    const B = sledz(await ctxB.newPage(), 'B');
    await A.goto(url); await gotowa(A);
    await B.goto(url); await gotowa(B);
    for (const p of [A, B]) {
      const ep = await p.evaluate(() => ({ mode: EP_LOCAL.mode, storage: EP_LOCAL.storage, online: EP_LOCAL.online, label: EP_LOCAL.label }));
      assert.equal(ep.mode, 'server'); assert.equal(ep.online, true);
      assert.match(ep.label, /Tryb serwera/);
    }

    await dodajOperacje(A, { kurier: 'inpost', ilosc: 21, uwagi: 'z komputera' });
    await czekajNaToast(A, /Zarejestrowano wydanie palet \(WZ-00001\)/);
    await saldo(B, '21 szt.'); // drugie urządzenie bez odświeżania

    await wgrajLogo(A, 'dpd', PNG_1X1);
    const lid = await idLogo(A, 'dpd');
    assert.equal(await A.evaluate((id) => EP_LOCAL.assetUrl(id), lid), `/_blob/${lid}`);
    await logoWidoczne(A, `/_blob/${lid}`);
    await logoWidoczne(B, `/_blob/${lid}`);

    // kopia zapasowa aplikacji w trybie serwera też zawiera logo
    await A.click('#settingsNav');
    const [kop] = await Promise.all([A.waitForEvent('download'), A.click('[data-action="backup-export"]')]);
    const kopia = JSON.parse(fs.readFileSync(await kop.path(), 'utf8'));
    assert.equal(kopia.logos[lid], `data:image/png;base64,${PNG_1X1.toString('base64')}`);
    await idzDo(A, 'dashboard');

    assert.deepEqual([...A.bledy, ...B.bledy], [], 'błędy w konsoli (serwer, praca normalna)');

    // --- restart serwera: strony same się łączą ponownie, dane zostają ---
    const r1 = await srv.zatrzymaj();
    assert.equal(r1.code, 0);
    srv = await uruchomSerwer({ dataDir: dane, port });
    for (const p of [A, B]) {
      await p.waitForFunction(() => window.EP_LOCAL.online === true && !document.querySelector('[data-ep-banner="offline"]'), null, { timeout: 20000 });
    }
    await dodajOperacje(B, { kurier: 'dhl', ilosc: 4 });
    await czekajNaToast(B, /Zarejestrowano wydanie palet \(WZ-00002\)/);
    await saldo(A, '25 szt.');
    await B.reload(); await gotowa(B);
    await saldo(B, '25 szt.');
    await logoWidoczne(B, `/_blob/${lid}`);
    assert.deepEqual(tylkoSiec([...A.bledy, ...B.bledy]), [], 'po restarcie serwera tylko błędy sieci są dopuszczalne');
    A.bledy.length = 0; B.bledy.length = 0;

    // --- serwer wyłączony: pasek + komunikat błędu aplikacji przy zapisie ---
    await srv.zatrzymaj();
    const baner = await A.waitForSelector('[data-ep-banner="offline"]', { timeout: 15000 });
    assert.equal(await baner.textContent(), BANER_OFFLINE);
    // pasek nie trafia na wydruk (WZ/PZ, rozliczenie)
    await A.emulateMedia({ media: 'print' });
    assert.equal(await baner.evaluate((el) => getComputedStyle(el.parentNode).display), 'none', 'pasek ukryty przy drukowaniu');
    await A.emulateMedia({ media: 'screen' });
    assert.notEqual(await baner.evaluate((el) => getComputedStyle(el.parentNode).display), 'none');
    const styl = await baner.evaluate((el) => { const s = getComputedStyle(el); return { pos: getComputedStyle(el.parentNode).position, bg: s.backgroundColor, kolor: s.color, ramka: s.borderLeftColor }; });
    assert.equal(styl.pos, 'fixed');
    const kolorBad = await A.evaluate(() => { const t = document.createElement('i'); t.style.color = 'var(--bad)'; document.body.appendChild(t); const c = getComputedStyle(t).color; t.remove(); return c; });
    assert.equal(styl.ramka, kolorBad, 'pasek w kolorach aplikacji (--bad)');
    await dodajOperacje(A, { kurier: 'dpd', ilosc: 7 });
    await czekajNaToast(A, /Nie udało się zapisać operacji/, true);
    await saldo(A, '25 szt.');
    assert.equal(await A.evaluate(() => EP_LOCAL.online), false);
    assert.deepEqual(tylkoSiec(A.bledy).filter((b) => !/console\.error: (Error|JSHandle)/.test(b)), [], 'w trybie offline dopuszczalne są tylko błędy sieci i zapis aplikacji do konsoli');
    A.bledy.length = 0; B.bledy.length = 0;

    // --- serwer wraca: pasek znika, zapis działa, drugie urządzenie widzi zmianę ---
    srv = await uruchomSerwer({ dataDir: dane, port });
    await A.waitForFunction(() => !document.querySelector('[data-ep-banner="offline"]') && window.EP_LOCAL.online === true, null, { timeout: 20000 });
    await dodajOperacje(A, { kurier: 'dpd', ilosc: 8 });
    await czekajNaToast(A, /Zarejestrowano wydanie palet \(WZ-00003\)/);
    await saldo(B, '33 szt.');
    assert.deepEqual(tylkoSiec([...A.bledy, ...B.bledy]), []);
    A.bledy.length = 0; B.bledy.length = 0;

    // --- kolejna praca bez awarii: żadnych błędów w konsoli ---
    await dodajOperacje(B, { kurier: 'inpost', typ: 'zwrot', ilosc: 2 });
    await czekajNaToast(B, /Zarejestrowano zwrot palet \(PZ-00001\)/);
    await saldo(A, '31 szt.');
    assert.deepEqual([...A.bledy, ...B.bledy], [], 'błędy w konsoli po powrocie serwera');

    // dane na dysku serwera
    const baza = JSON.parse(fs.readFileSync(path.join(dane, 'baza.json'), 'utf8'));
    assert.equal(Object.keys(baza.collections.transactions).length, 4);
    assert.deepEqual(baza.collections.meta.counters, { wz: 3, pz: 1 });
  } finally {
    await ctxA.close(); await ctxB.close();
    await srv.zatrzymaj();
  }
});

/* ======================================================================
   (b2) strona z adresu serwera, który w chwili otwarcia nie odpowiada (np. strona z pamięci podręcznej,
        uśpiony NAS): zostaje w trybie serwera z paskiem i czeka — NIE zapisuje po cichu w przeglądarce
   ====================================================================== */
test('(b2) serwer niedostępny przy otwarciu → pasek, brak zapisu w przeglądarce, po starcie serwera dane', { timeout: 90000 }, async () => {
  const dane = tymczasowyKatalog(); sprzatanie.push(dane);
  const port = await wolnyPort();
  let srv = await uruchomSerwer({ dataDir: dane, port });
  const { jsonPost } = require('./pomocnicy-serwera');
  await jsonPost(port, '/api/write', { op: 'set', coll: 'couriers', id: 'dpd', data: { name: 'DPD', order: 1, color: '#DC0032', custom: false, enabled: true } });
  await jsonPost(port, '/api/write', { op: 'set', coll: 'transactions', id: 't1', data: { kurierId: 'dpd', kurierNazwa: 'DPD', typ: 'wydanie', ilosc: 9, data: '2026-10-01', uwagi: '', createdAt: 1, nr: 'WZ-00001' } });
  await jsonPost(port, '/api/write', { op: 'set', coll: 'meta', id: 'counters', data: { wz: 1, pz: 0 } });
  await jsonPost(port, '/api/write', { op: 'set', coll: 'meta', id: 'settings', data: { seeded: true } });
  await srv.zatrzymaj();
  const ctx = await przegladarka.newContext();
  // strona i skrypty „z pamięci podręcznej” (podstawione), API — prawdziwy, wyłączony serwer
  const pliki = { '/': 'index.html', '/index.html': 'index.html', '/runtime-lokalny.js': 'runtime-lokalny.js' };
  await ctx.route(`http://127.0.0.1:${port}/**`, (route) => {
    const p = new URL(route.request().url()).pathname;
    const plik = pliki[p] || (p.startsWith('/fonts/') ? p.slice(1) : null);
    if (!plik) return route.continue();
    const typ = plik.endsWith('.html') ? 'text/html; charset=utf-8' : plik.endsWith('.js') ? 'text/javascript' : plik.endsWith('.css') ? 'text/css' : 'font/woff2';
    return route.fulfill({ status: 200, contentType: typ, body: fs.readFileSync(path.join(KATALOG, plik)) });
  });
  try {
    const A = sledz(await ctx.newPage(), 'BEZ-SERWERA');
    await A.goto(`http://127.0.0.1:${port}/`);
    const baner = await A.waitForSelector('[data-ep-banner="offline"]', { timeout: 15000 });
    assert.equal(await baner.textContent(), BANER_OFFLINE);
    assert.deepEqual(await A.evaluate(() => [EP_LOCAL.mode, EP_LOCAL.online]), ['server', false]);
    assert.equal(await A.evaluate(() => document.querySelectorAll('.courier-card').length), 0, 'bez serwera nie ma danych (ani domyślnych kurierów zapisanych lokalnie)');
    const bazy = await A.evaluate(() => (indexedDB.databases ? indexedDB.databases() : Promise.resolve([])).then((l) => l.map((d) => d.name)));
    assert.ok(!bazy.includes('ewidencja-palet'), 'nie wolno zakładać lokalnej bazy w przeglądarce');
    srv = await uruchomSerwer({ dataDir: dane, port });
    await A.waitForFunction(() => window.EP_LOCAL.online === true && !document.querySelector('[data-ep-banner]'), null, { timeout: 30000 });
    await gotowa(A);
    await saldo(A, '9 szt.');
    assert.equal(await A.evaluate(() => EP_LOCAL.storage), 'server');
    assert.deepEqual(tylkoSiec(A.bledy), []);
  } finally { await ctx.close(); await srv.zatrzymaj(); }
});

/* ======================================================================
   (b3) serwer uruchomiony ponownie z danymi odtworzonymi z kopii (niższy numer zmian):
        otwarta strona przyjmuje stan serwera w całości, nie trzyma starych wersji dokumentów
   ====================================================================== */
test('(b3) serwer przywrócony z kopii (niższy rev) → otwarta strona pokazuje stan z kopii i dalej działa na żywo', { timeout: 90000 }, async () => {
  const dane = tymczasowyKatalog(); sprzatanie.push(dane);
  const port = await wolnyPort();
  let srv = await uruchomSerwer({ dataDir: dane, port });
  const ctx = await przegladarka.newContext();
  try {
    const A = sledz(await ctx.newPage(), 'PRZYWRACANIE');
    await A.goto(`http://127.0.0.1:${port}/`); await gotowa(A);
    await dodajOperacje(A, { kurier: 'dpd', ilosc: 4 });
    await czekajNaToast(A, /WZ-00001/);
    await saldo(A, '4 szt.');
    const stan = fs.readFileSync(path.join(dane, 'baza.json'), 'utf8'); // „kopia”: 4 palety
    for (const n of [5, 6]) { await dodajOperacje(A, { kurier: 'dpd', ilosc: n }); await czekajNaToast(A, new RegExp(`WZ-0000${n - 3}`)); }
    await saldo(A, '15 szt.');
    await srv.zatrzymaj();
    fs.writeFileSync(path.join(dane, 'baza.json'), stan); // administrator przywraca kopię
    srv = await uruchomSerwer({ dataDir: dane, port });
    await saldo(A, '4 szt.', 30000);
    // zapisy po przywróceniu (nowe rev ≤ dawnym) docierają normalnie, także do drugiej karty
    const B = sledz(await ctx.newPage(), 'PRZYWRACANIE-B');
    await B.goto(`http://127.0.0.1:${port}/`); await gotowa(B);
    await dodajOperacje(B, { kurier: 'dpd', ilosc: 7 });
    await czekajNaToast(B, /WZ-00002/);
    await saldo(A, '11 szt.');
    await dodajOperacje(A, { kurier: 'dpd', typ: 'zwrot', ilosc: 1 });
    await czekajNaToast(A, /PZ-00001/);
    await saldo(B, '10 szt.');
    assert.deepEqual(tylkoSiec([...A.bledy, ...B.bledy]), []);
  } finally { await ctx.close(); await srv.zatrzymaj(); }
});

/* ======================================================================
   (b4) karta ukryta dłużej → połączenie na żywo zwolnione (limit 6 połączeń HTTP/1.1), po powrocie stan wczytany od nowa
   ====================================================================== */
test('(b4) ukryta karta zwalnia połączenie SSE bez paska „brak połączenia”, po powrocie dociąga zmiany', { timeout: 90000 }, async () => {
  const dane = tymczasowyKatalog(); sprzatanie.push(dane);
  const srv = await uruchomSerwer({ dataDir: dane });
  const ctx = await przegladarka.newContext();
  await ctx.addInitScript(() => {
    window.EP_LOCAL_OPCJE = { pauzaUkrytejKartyMs: 300 };
    window.__widocznosc = 'visible';
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return window.__widocznosc; } });
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return window.__widocznosc === 'hidden'; } });
  });
  const ustawWidocznosc = (page, v) => page.evaluate((x) => { window.__widocznosc = x; document.dispatchEvent(new Event('visibilitychange')); }, v);
  try {
    const A = sledz(await ctx.newPage(), 'UKRYTA'), B = sledz(await ctx.newPage(), 'WIDOCZNA');
    await A.goto(`http://127.0.0.1:${srv.port}/`); await gotowa(A);
    await B.goto(`http://127.0.0.1:${srv.port}/`); await gotowa(B);
    await A.waitForFunction(() => EP_LOCAL.polaczenie === 'otwarte');
    await ustawWidocznosc(A, 'hidden');
    await A.waitForFunction(() => EP_LOCAL.polaczenie === 'wstrzymane', null, { timeout: 5000 });
    await dodajOperacje(B, { kurier: 'gls', ilosc: 3 });
    await czekajNaToast(B, /WZ-00001/);
    await A.waitForTimeout(1500);
    assert.equal(await A.$('[data-ep-banner]'), null, 'wstrzymanie to nie awaria — bez paska');
    assert.equal(await A.evaluate(() => EP_LOCAL.online), true);
    await ustawWidocznosc(A, 'visible');
    await A.waitForFunction(() => EP_LOCAL.polaczenie === 'otwarte', null, { timeout: 10000 });
    await saldo(A, '3 szt.');
    // i dalej na żywo
    await dodajOperacje(B, { kurier: 'gls', ilosc: 2 });
    await saldo(A, '5 szt.');
    // krótkie ukrycie (krótsze niż próg) nie zrywa połączenia
    await ustawWidocznosc(A, 'hidden'); await ustawWidocznosc(A, 'visible');
    await A.waitForTimeout(500);
    assert.equal(await A.evaluate(() => EP_LOCAL.polaczenie), 'otwarte');
    assert.deepEqual([...A.bledy, ...B.bledy], []);
  } finally { await ctx.close(); await srv.zatrzymaj(); }
});

/* ======================================================================
   (b5) serwer z hasłem (EP_HASLO): strona, API, SSE i loga działają po zalogowaniu; bez hasła — 401
   ====================================================================== */
test('(b5) EP_HASLO: aplikacja działa po zalogowaniu (zapis, na żywo, logo), bez hasła nic nie widać', { timeout: 90000 }, async () => {
  const dane = tymczasowyKatalog(); sprzatanie.push(dane);
  const srv = await uruchomSerwer({ dataDir: dane, env: { EP_HASLO: 'Palety 2026!' } });
  const url = `http://127.0.0.1:${srv.port}/`;
  const ctxA = await przegladarka.newContext({ httpCredentials: { username: 'biuro', password: 'Palety 2026!' } });
  const ctxB = await przegladarka.newContext({ httpCredentials: { username: 'magazyn', password: 'Palety 2026!' } });
  const ctxObcy = await przegladarka.newContext();
  try {
    const A = sledz(await ctxA.newPage(), 'HASLO-A'), B = sledz(await ctxB.newPage(), 'HASLO-B');
    await A.goto(url); await gotowa(A);
    await B.goto(url); await gotowa(B);
    assert.equal(await A.evaluate(() => EP_LOCAL.mode), 'server');
    await dodajOperacje(A, { kurier: 'dpd', ilosc: 6 });
    await czekajNaToast(A, /WZ-00001/);
    await saldo(B, '6 szt.');
    await wgrajLogo(A, 'dpd', PNG_1X1);
    const lid = await idLogo(A, 'dpd');
    await logoWidoczne(B, `/_blob/${lid}`);
    assert.deepEqual([...A.bledy, ...B.bledy], []);
    const obcy = await ctxObcy.newPage();
    const r = await obcy.goto(url);
    assert.equal(r.status(), 401);
    assert.ok(!(await obcy.content()).includes('Ewidencja Palet — Panel'), 'bez hasła nie ma aplikacji');
  } finally { await ctxA.close(); await ctxB.close(); await ctxObcy.close(); await srv.zatrzymaj(); }
});

/* ======================================================================
   (f) nowe funkcje aplikacji w obu trybach lokalnych: wydruk WZ/PZ (druk + plik), rozliczenie kuriera
       (CSV + wydruk), kopia zapasowa: eksport → import w drugim trybie (z logo i ciągłością numeracji),
       import kopii z /api/kopia i kopii dziennej serwera
   ====================================================================== */
test('(f) wydruki, rozliczenie CSV, kopia: serwer → przeglądarka → serwer, /api/kopia, kopia dzienna', { timeout: 240000 }, async () => {
  const dane1 = tymczasowyKatalog(); sprzatanie.push(dane1);
  const dane2 = tymczasowyKatalog(); sprzatanie.push(dane2);
  const tmp = tymczasowyKatalog('ep-pliki-'); sprzatanie.push(tmp);
  const srv1 = await uruchomSerwer({ dataDir: dane1 });
  const srv2 = await uruchomSerwer({ dataDir: dane2 });
  const ctxS = await przegladarka.newContext({ acceptDownloads: true, viewport: { width: 1300, height: 900 } });
  const ctxP = await przegladarka.newContext({ acceptDownloads: true, viewport: { width: 1300, height: 900 } });
  const ctxS2 = await przegladarka.newContext({ acceptDownloads: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const daneLogo = `data:image/png;base64,${PNG_1X1.toString('base64')}`;
  try {
    /* --- tryb serwera: dane, logo, wydruki, rozliczenie, kopia --- */
    const S = sledz(await ctxS.newPage(), 'SERWER');
    await S.goto(`http://127.0.0.1:${srv1.port}/`); await gotowa(S);
    await dodajOperacje(S, { kurier: 'inpost', ilosc: 12, uwagi: 'kopia „test” ąę' });
    await czekajNaToast(S, /WZ-00001/);
    await dodajOperacje(S, { kurier: 'inpost', typ: 'zwrot', ilosc: 2 });
    await czekajNaToast(S, /PZ-00001/);
    await saldo(S, '10 szt.');
    await wgrajLogo(S, 'inpost', PNG_1X1);
    await sprawdzWydruk(S);
    await sprawdzRozliczenie(S, 'inpost', 'WZ-00001');
    await S.click('#settingsNav');
    const kopiaS = await pobierz(S, '[data-action="backup-export"]');
    const kopia = JSON.parse(kopiaS.tekst);
    assert.equal(kopia.source, 'server');
    assert.equal(kopia.transactions.length, 2);
    const lidS = await idLogo(S, 'inpost');
    assert.equal(kopia.logos[lidS], daneLogo);
    // pełna kopia z serwera (GET /api/kopia) i kopia dzienna — oba pliki do wczytania w aplikacji
    const apiKopia = await S.evaluate(() => fetch('/api/kopia').then((r) => r.text()));
    const plikApi = path.join(tmp, 'api-kopia.json'); fs.writeFileSync(plikApi, apiKopia);
    const dzienne = fs.readdirSync(path.join(dane1, 'kopie'));
    assert.equal(dzienne.length, 1, `kopia dzienna: ${dzienne}`);
    assert.deepEqual(S.bledy, [], 'błędy w konsoli (serwer)');

    /* --- tryb przeglądarki: wczytanie kopii z serwera (Zastąp wszystko) --- */
    const P = sledz(await ctxP.newPage(), 'PRZEGLADARKA');
    await P.goto(URL_PLIKU); await gotowa(P);
    assert.equal(await P.evaluate(() => EP_LOCAL.mode), 'browser');
    await wczytajKopie(P, kopiaS.sciezka, 'replace');
    await saldo(P, '10 szt.');
    assert.equal(await liczbaOperacji(P), 2);
    const lidP = await idLogo(P, 'inpost');
    assert.ok(lidP && lidP !== lidS, 'logo wgrane od nowa, z nowym identyfikatorem');
    await idzDo(P, 'dashboard');
    await logoWidoczne(P, daneLogo);
    // numeracja jest kontynuowana
    await dodajOperacje(P, { kurier: 'dhl', ilosc: 5 });
    await czekajNaToast(P, /WZ-00002/);
    await sprawdzWydruk(P);
    await sprawdzRozliczenie(P, 'dhl', 'WZ-00002');
    await P.click('#settingsNav');
    const kopiaP = await pobierz(P, '[data-action="backup-export"]');
    assert.equal(JSON.parse(kopiaP.tekst).source, 'browser');
    // Połącz z kopią z /api/kopia: nic nowego (te same operacje) — nic nie znika
    await wczytajKopie(P, plikApi, 'merge');
    assert.equal(await liczbaOperacji(P), 3);
    // kopia dzienna serwera też jest plikiem kopii aplikacji
    await wczytajKopie(P, path.join(dane1, 'kopie', dzienne[0]), 'merge');
    assert.equal(await liczbaOperacji(P), 3);
    assert.deepEqual(P.bledy, [], 'błędy w konsoli (przeglądarka)');

    /* --- z powrotem na (inny, pusty) serwer: kopia z przeglądarki --- */
    const S2 = sledz(await ctxS2.newPage(), 'SERWER2');
    await S2.goto(`http://127.0.0.1:${srv2.port}/`); await gotowa(S2);
    await wczytajKopie(S2, kopiaP.sciezka, 'replace');
    await saldo(S2, '15 szt.');
    assert.equal(await liczbaOperacji(S2), 3);
    const lid2 = await idLogo(S2, 'inpost');
    await idzDo(S2, 'dashboard');
    await logoWidoczne(S2, `/_blob/${lid2}`);
    await dodajOperacje(S2, { kurier: 'inpost', typ: 'zwrot', ilosc: 1 });
    await czekajNaToast(S2, /PZ-00002/);
    const baza2 = JSON.parse(fs.readFileSync(path.join(dane2, 'baza.json'), 'utf8'));
    assert.equal(Object.keys(baza2.collections.transactions).length, 4);
    assert.deepEqual(baza2.collections.meta.counters, { wz: 2, pz: 2 });
    assert.ok(fs.existsSync(path.join(dane2, 'zalaczniki', lid2)));
    assert.deepEqual(S2.bledy, [], 'błędy w konsoli (serwer 2, telefon)');
  } finally {
    await ctxS.close(); await ctxP.close(); await ctxS2.close();
    await srv1.zatrzymaj(); await srv2.zatrzymaj();
  }
});

/* ======================================================================
   (d) semantyka API bazy (tryb przeglądarki, file://)
   ====================================================================== */
test('(d) API bazy: zapytania, nasłuchy, zapisy, błędy, loga, pobieranie', { timeout: 60000 }, async () => {
  const ctx = await przegladarka.newContext({ acceptDownloads: true });
  try {
    const P = sledz(await ctx.newPage(), 'API');
    await P.goto(URL_PLIKU);
    await gotowa(P);
    const wynik = await P.evaluate(async () => {
      const out = {};
      const usePromise = window.claude.use('db');
      out.usePromise = usePromise instanceof Promise;
      out.useTaSamaObietnica = window.claude.use('db') === usePromise;
      const db = await usePromise;
      out.zamrozone = Object.isFrozen(db);
      out.nieznane = await window.claude.use('cos-innego');
      const C = db.collection('test_q');
      const docs = {
        a: { n: 3, s: 'b', tag: ['x', 'y'], d: '2026-01-02' },
        b: { n: 1, s: 'a', tag: ['y'], d: '2026-01-03' },
        c: { n: 2, s: 'c', d: '2026-01-01' },
        d: { s: 'd', n: '10' },
        e: { n: 10, s: 'e', nested: { k: 1 } },
      };
      for (const [id, d] of Object.entries(docs)) await C.doc(id).set(d);
      const ids = async (q) => (await q.get()).docs.map((x) => x.id);
      out.domyslnie = await ids(C);
      out.eq = await ids(C.where('n', '==', 2));
      out.ne = await ids(C.where('n', '!=', 2));
      out.lt = await ids(C.where('n', '<', 3));
      out.le = await ids(C.where('n', '<=', 3));
      out.gt = await ids(C.where('n', '>', 2));
      out.ge = await ids(C.where('n', '>=', 3));
      out.in = await ids(C.where('s', 'in', ['a', 'c', 'zz']));
      out.notin = await ids(C.where('s', 'not-in', ['a', 'c']));
      out.ac = await ids(C.where('tag', 'array-contains', 'y'));
      out.str = await ids(C.where('d', '<=', '2026-01-02'));
      out.zagn = await ids(C.where('nested.k', '==', 1));
      out.asc = await ids(C.orderBy('n'));
      out.desc = await ids(C.orderBy('n', 'desc'));
      out.brakPolaNaKoniec = await ids(C.orderBy('tag', 'desc'));
      out.dDesc = await ids(C.orderBy('d', 'desc'));
      out.limit = await ids(C.orderBy('s', 'desc').limit(2));
      out.whereOrderLimit = await ids(C.where('d', '<=', '2026-01-03').orderBy('d', 'desc').limit(2));
      out.limit0 = await ids(C.limit(0));
      const q1 = C.where('n', '>', 1); q1.orderBy('n').limit(1); // budowanie nowego zapytania nie zmienia starego
      out.czyste = await ids(q1);
      const bledy = [];
      for (const f of [() => C.orderBy('n').orderBy('s'), () => C.where('n', '~', 1), () => C.where('s', 'in', 'a'), () => C.limit(-1), () => db.collection('zła nazwa'), () => db.doc('tylko-kolekcja'), () => C.doc('a/b'), () => C.doc('..')]) {
        try { f(); bledy.push('brak błędu'); } catch (e) { bledy.push(e.code); }
      }
      out.bledyBudowania = bledy;
      out.sciezkaTypeError = (() => { try { db.collection('zła nazwa'); return 'brak'; } catch (e) { return e instanceof TypeError; } })();

      // DocumentSnapshot / deep copy
      const s = await C.doc('a').get();
      out.snap = { id: s.id, exists: s.exists, meta: s.metadata };
      const kopia = s.data(); kopia.n = 999; kopia.tag.push('z');
      out.glebokaKopia = (await C.doc('a').get()).data();
      out.nieistnieje = await C.doc('brak').get().then((x) => ({ exists: x.exists, data: x.data() === undefined ? 'undefined' : x.data() }));

      // update: scalanie, __delete__, not_found
      await C.doc('a').update({ n: 4, s: { __delete__: true }, nowe: null });
      out.poUpdate = (await C.doc('a').get()).data();
      // update scala zagnieżdżone obiekty rekurencyjnie (jak platforma), tablice zastępuje w całości
      await C.doc('g').set({ o: { a: 1, b: { c: 2, d: 3 } }, t: [1, 2], z: { __delete__: true } });
      out.setBezZnacznikow = (await C.doc('g').get()).data();
      await C.doc('g').update({ o: { b: { c: 20, d: { __delete__: true } }, nowe: 1 }, t: [9] });
      out.glebokieScalenie = (await C.doc('g').get()).data();
      await C.doc('g').delete();
      out.updateBrak = await C.doc('brak').update({ x: 1 }).then(() => 'ok', (e) => ({ code: e.code, isError: e instanceof Error }));
      out.setZly = await C.doc('x').set([1, 2]).then(() => 'ok', (e) => e.code);
      out.setZly2 = await C.doc('x').set('tekst').then(() => 'ok', (e) => e.code);

      // add / doc() bez id
      const ref = await C.add({ dodany: true });
      out.addId = ref.id; out.addPath = ref.path;
      out.docBezId = C.doc().id;
      out.dbDoc = (await db.doc('test_q/b').get()).data();
      await C.doc(ref.id).delete();
      out.poDelete = (await C.doc(ref.id).get()).exists;
      out.deleteBrak = await C.doc('nie-ma').delete().then(() => 'ok', (e) => e.code);

      // get() nigdy synchronicznie
      let poGet = false; const pg = C.get().then(() => { poGet = true; }); out.getSynchronicznie = poGet; await pg;

      // onSnapshot: pierwsze dostarczenie asynchronicznie, scalanie serii, nigdy w trakcie zapisu
      const L = db.collection('test_l');
      await L.doc('p').set({ v: 0, o: 1 });
      const dostawy = []; let wTrakcieZapisu = false, dostawaWTrakcie = false;
      const stop = L.orderBy('o').onSnapshot((snap) => {
        if (wTrakcieZapisu) dostawaWTrakcie = true;
        dostawy.push({ ids: snap.docs.map((d) => d.id), size: snap.size, empty: snap.empty, zmiany: snap.docChanges().map((c) => `${c.type}:${c.doc.id}:${c.oldIndex}:${c.newIndex}`) });
      });
      out.pierwszaSynchronicznie = dostawy.length;
      await new Promise((r) => setTimeout(r, 30));
      out.pierwsza = dostawy.slice();
      dostawy.length = 0;
      wTrakcieZapisu = true;
      const zapisy = [L.doc('q').set({ v: 1, o: 2 }), L.doc('r').set({ v: 2, o: 0 }), L.doc('p').update({ v: 5 })];
      wTrakcieZapisu = false;
      await Promise.all(zapisy);
      await new Promise((r) => setTimeout(r, 30));
      out.dostawaWTrakcie = dostawaWTrakcie;
      out.seria = dostawy.slice();
      dostawy.length = 0;
      await L.doc('q').delete();
      await new Promise((r) => setTimeout(r, 30));
      out.usuniecie = dostawy.slice();
      dostawy.length = 0;
      stop();
      await L.doc('s').set({ o: 9 });
      await new Promise((r) => setTimeout(r, 30));
      out.poOdsubskrybowaniu = dostawy.length;

      // nasłuch dokumentu
      const dd = [];
      const stopD = db.doc('test_l/nowy').onSnapshot((x) => dd.push([x.exists, x.data() === undefined ? 'undefined' : x.data()]));
      await new Promise((r) => setTimeout(r, 20));
      await db.doc('test_l/nowy').set({ a: 1 });
      await new Promise((r) => setTimeout(r, 20));
      await db.doc('test_l/inny').set({ a: 2 }); // inny dokument — bez dostawy
      await new Promise((r) => setTimeout(r, 20));
      stopD();
      out.docListener = dd;

      // paczka zapisów (atomowo)
      const b1 = db.batch(); b1.set(db.doc('test_b/1'), { a: 1 }); b1.update(db.doc('test_b/nie-ma'), { a: 2 });
      out.batchBlad = await b1.commit().then(() => 'ok', (e) => e.code);
      out.batchNicNieZapisal = (await db.doc('test_b/1').get()).exists;
      const b2 = db.batch(); b2.set(db.doc('test_b/1'), { a: 1 }); b2.update(db.doc('test_b/1'), { b: 2 });
      await b2.commit();
      out.batchOk = (await db.doc('test_b/1').get()).data();

      // loga
      const assets = await window.claude.use('assets');
      out.zlyTyp = await assets.upload(new Blob(['<html>'], { type: 'text/html' })).then(() => 'ok', (e) => e.code);
      out.zaDuze = await assets.upload(new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: 'image/png' })).then(() => 'ok', (e) => e.code);
      out.pusty = await assets.upload(new Blob([], { type: 'image/png' })).then(() => 'ok', (e) => e.code);
      out.nieBlob = await assets.upload('tekst').then(() => 'ok', (e) => e.code);
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
      const up = await assets.upload(new File([png], 'logo.png', { type: 'image/png' }));
      out.upload = { idOk: /^[a-z0-9]{20}$/.test(up.id), urlData: up.url.startsWith('data:image/png;base64,'), size: up.sizeBytes, type: up.contentType };
      out.assetUrl = window.EP_LOCAL.assetUrl(up.id) === up.url;
      const lista = await assets.list();
      const wpis = lista.assets.find((a) => a.id === up.id);
      out.lista = { jest: !!wpis, bajty: lista.usage.bytes >= png.length, pliki: lista.usage.files >= 1, limity: lista.usage.maxFiles > 0 && lista.usage.maxBytes > 0, createdAt: !isNaN(Date.parse(wpis.createdAt)) };
      out.usun = await assets.delete(up.id);
      out.usunPonownie = await assets.delete(up.id);
      out.poUsunieciu = [window.EP_LOCAL.assetUrl(up.id), (await assets.list()).assets.some((a) => a.id === up.id)];
      const bezTypu = await assets.upload(new File([png], 'logo.webp', { type: '' }));
      out.typZRozszerzenia = bezTypu.contentType;
      out.typZOpcji = (await assets.upload(new Blob([png]), { type: 'image/png' })).contentType;
      // delete przyjmuje też adres zwrócony przez upload()
      out.usunPoUrl = await assets.delete(bezTypu.url);

      // acquire(): dzierżawa jak na platformie
      const L2 = db.doc('test_lease/x');
      const a1 = await L2.acquire({ holder: 'karta-1', ttlMs: 1000 });
      const a2 = await L2.acquire({ holder: 'karta-2', ttlMs: 1000 });
      const a3 = await L2.acquire({ holder: 'karta-1', ttlMs: 1000 });
      await new Promise((r) => setTimeout(r, 1100));
      const a4 = await L2.acquire({ holder: 'karta-2', data: { kto: 'karta-2' } });
      out.acquire = {
        a1: [a1.acquired, a1.holder, typeof a1.version, !isNaN(Date.parse(a1.expiresAt))],
        a2: [a2.acquired, Object.keys(a2).sort().join(',')],
        a3: a3.acquired, a4: a4.acquired, dane: (await L2.get()).data(),
        bezHoldera: await L2.acquire({}).then(() => 'ok', (e) => e.code),
      };
      return out;
    });

    assert.equal(wynik.usePromise, true);
    assert.equal(wynik.useTaSamaObietnica, true, 'use("db") zawsze ta sama obietnica');
    assert.equal(wynik.zamrozone, true);
    assert.equal(wynik.nieznane, null);
    assert.deepEqual(wynik.domyslnie, ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(wynik.eq, ['c']);
    assert.deepEqual(wynik.ne, ['a', 'b', 'd', 'e']);
    assert.deepEqual(wynik.lt, ['b', 'c']);
    assert.deepEqual(wynik.le, ['a', 'b', 'c']);
    assert.deepEqual(wynik.gt, ['a', 'e']);
    assert.deepEqual(wynik.ge, ['a', 'e']);
    assert.deepEqual(wynik.in, ['b', 'c']);
    assert.deepEqual(wynik.notin, ['a', 'd', 'e']);
    assert.deepEqual(wynik.ac, ['a', 'b']);
    assert.deepEqual(wynik.str, ['a', 'c']);
    assert.deepEqual(wynik.zagn, ['e']);
    assert.deepEqual(wynik.asc, ['b', 'c', 'a', 'e', 'd'], 'liczby numerycznie, przed tekstem');
    assert.deepEqual(wynik.desc, ['d', 'e', 'a', 'c', 'b']);
    assert.deepEqual(wynik.brakPolaNaKoniec, ['b', 'a', 'c', 'd', 'e'], 'tablice porównywane, brak pola na końcu także przy desc');
    assert.deepEqual(wynik.czyste, ['a', 'c', 'e'], 'budowniczowie zapytań są czyste');
    assert.deepEqual(wynik.dDesc, ['b', 'a', 'c', 'd', 'e'], 'dokumenty bez pola na końcu');
    assert.deepEqual(wynik.limit, ['e', 'd']);
    assert.deepEqual(wynik.whereOrderLimit, ['b', 'a']);
    assert.deepEqual(wynik.limit0, []);
    assert.deepEqual(wynik.bledyBudowania, Array(8).fill('invalid_argument'));
    assert.equal(wynik.sciezkaTypeError, true, 'zła ścieżka → TypeError (jak platforma)');
    assert.deepEqual(wynik.snap, { id: 'a', exists: true, meta: { fromCache: false, hasPendingWrites: false } });
    assert.deepEqual(wynik.glebokaKopia, { n: 3, s: 'b', tag: ['x', 'y'], d: '2026-01-02' }, 'data() zwraca kopię');
    assert.deepEqual(wynik.nieistnieje, { exists: false, data: 'undefined' });
    assert.deepEqual(wynik.poUpdate, { n: 4, tag: ['x', 'y'], d: '2026-01-02', nowe: null });
    assert.deepEqual(wynik.setBezZnacznikow, { o: { a: 1, b: { c: 2, d: 3 } }, t: [1, 2] });
    assert.deepEqual(wynik.glebokieScalenie, { o: { a: 1, b: { c: 20 }, nowe: 1 }, t: [9] });
    assert.deepEqual(wynik.updateBrak, { code: 'not_found', isError: true });
    assert.equal(wynik.setZly, 'invalid_argument');
    assert.equal(wynik.setZly2, 'invalid_argument');
    assert.match(wynik.addId, /^[a-z0-9]{20}$/);
    assert.equal(wynik.addPath, `test_q/${wynik.addId}`);
    assert.match(wynik.docBezId, /^[a-z0-9]{20}$/);
    assert.deepEqual(wynik.dbDoc, docsB());
    assert.equal(wynik.poDelete, false);
    assert.equal(wynik.deleteBrak, 'ok');
    assert.equal(wynik.getSynchronicznie, false);

    assert.equal(wynik.pierwszaSynchronicznie, 0, 'pierwsza dostawa nie może być synchroniczna');
    assert.deepEqual(wynik.pierwsza, [{ ids: ['p'], size: 1, empty: false, zmiany: ['added:p:-1:0'] }]);
    assert.equal(wynik.dostawaWTrakcie, false, 'nasłuch wywołany synchronicznie w trakcie zapisu');
    assert.ok(wynik.seria.length >= 1 && wynik.seria.length <= 3, `seria zapisów: ${wynik.seria.length} dostaw`);
    const ostatnia = wynik.seria[wynik.seria.length - 1];
    assert.deepEqual(ostatnia.ids, ['r', 'p', 'q']);
    assert.deepEqual(wynik.usuniecie, [{ ids: ['r', 'p'], size: 2, empty: false, zmiany: ['removed:q:2:-1'] }]);
    assert.equal(wynik.poOdsubskrybowaniu, 0);
    assert.deepEqual(wynik.docListener, [[false, 'undefined'], [true, { a: 1 }]], 'nasłuch dokumentu: tylko zmiany tego dokumentu');
    assert.equal(wynik.batchBlad, 'not_found');
    assert.equal(wynik.batchNicNieZapisal, false);
    assert.deepEqual(wynik.batchOk, { a: 1, b: 2 });

    assert.equal(wynik.zlyTyp, 'unsupported_type');
    assert.equal(wynik.zaDuze, 'too_large');
    assert.equal(wynik.pusty, 'invalid_request');
    assert.equal(wynik.nieBlob, 'invalid_request');
    assert.deepEqual(wynik.upload, { idOk: true, urlData: true, size: PNG_1X1.length, type: 'image/png' });
    assert.equal(wynik.assetUrl, true);
    assert.deepEqual(wynik.lista, { jest: true, bajty: true, pliki: true, limity: true, createdAt: true });
    assert.deepEqual(wynik.usun, { deleted: true });
    assert.deepEqual(wynik.usunPonownie, { deleted: false });
    assert.deepEqual(wynik.poUsunieciu, [null, false]);
    assert.equal(wynik.typZRozszerzenia, 'image/webp');
    assert.equal(wynik.typZOpcji, 'image/png');
    assert.deepEqual(wynik.usunPoUrl, { deleted: true });
    assert.deepEqual(wynik.acquire, {
      a1: [true, 'karta-1', 'number', true], a2: [false, 'acquired,expiresAt'], a3: true, a4: true,
      dane: { kto: 'karta-2' }, bezHoldera: 'invalid_argument',
    });

    // downloads.save: tekst, bajty, Blob
    const pobrania = [];
    P.on('download', (d) => pobrania.push(d));
    await P.evaluate(async () => {
      const dl = await window.claude.use('downloads');
      window.__wynikZapisu = await dl.save({ filename: 'a.csv', data: '﻿x;y\r\n1;ą' });
      await dl.save({ filename: 'b.bin', data: new Uint8Array([1, 2, 3]) });
      await dl.save({ filename: 'c.bin', data: new Uint8Array([4, 5]).buffer });
      await dl.save({ filename: 'd/../e.json', data: new Blob(['{"a":1}'], { type: 'application/json' }) });
      window.__zlyZapis = await dl.save({ filename: '', data: 'x' }).then(() => 'ok', (e) => e.code);
      window.__pustyZapis = await dl.save({ filename: 'pusty.txt', data: '' }).then(() => 'ok', (e) => e.code);
    });
    await P.waitForTimeout(500);
    assert.deepEqual(await P.evaluate(() => window.__wynikZapisu), { status: 'saved' });
    assert.equal(await P.evaluate(() => window.__zlyZapis), 'bad_request');
    assert.equal(await P.evaluate(() => window.__pustyZapis), 'bad_request');
    const nazwy = pobrania.map((d) => d.suggestedFilename()).sort();
    assert.deepEqual(nazwy, ['a.csv', 'b.bin', 'c.bin', 'd_.._e.json']);
    const tresc = async (n) => fs.readFileSync(await pobrania.find((d) => d.suggestedFilename() === n).path());
    assert.equal((await tresc('a.csv')).toString('utf8'), '﻿x;y\r\n1;ą');
    assert.deepEqual([...(await tresc('b.bin'))], [1, 2, 3]);
    assert.deepEqual([...(await tresc('c.bin'))], [4, 5]);
    assert.equal((await tresc('d_.._e.json')).toString(), '{"a":1}');
    assert.deepEqual(P.bledy, []);
  } finally { await ctx.close(); }
});
function docsB() { return { n: 1, s: 'a', tag: ['y'], d: '2026-01-03' }; }

/* ======================================================================
   (d2) to samo API w trybie serwera: zapytania, update not_found, __delete__, batch, nasłuch z innego urządzenia
   ====================================================================== */
test('(d2) API bazy w trybie serwera + zgodność z danymi na dysku', { timeout: 60000 }, async () => {
  const dane = tymczasowyKatalog(); sprzatanie.push(dane);
  const srv = await uruchomSerwer({ dataDir: dane });
  const ctx1 = await przegladarka.newContext(), ctx2 = await przegladarka.newContext();
  try {
    const P = sledz(await ctx1.newPage(), 'S1'), Q = sledz(await ctx2.newPage(), 'S2');
    await P.goto(`http://127.0.0.1:${srv.port}/`); await gotowa(P);
    await Q.goto(`http://127.0.0.1:${srv.port}/`); await gotowa(Q);
    await Q.evaluate(() => { window.__zmiany = []; return window.claude.use('db').then((db) => { db.collection('test_s').orderBy('n', 'desc').onSnapshot((s) => window.__zmiany.push(s.docs.map((d) => `${d.id}=${d.data().n}`).join(','))); }); });
    const w = await P.evaluate(async () => {
      const db = await window.claude.use('db'); const o = {};
      await db.collection('test_s').doc('x').set({ n: 1, usun: 'tak' });
      await db.collection('test_s').doc('y').set({ n: 2 });
      await db.collection('test_s').doc('x').update({ n: 3, usun: { __delete__: true } });
      o.x = (await db.doc('test_s/x').get()).data();
      o.brak = await db.doc('test_s/brak').update({ n: 1 }).then(() => 'ok', (e) => e.code);
      o.zla = await db.collection('test_s').doc('z').set({ big: 'x'.repeat(1100000) }).then(() => 'ok', (e) => e.code);
      const b = db.batch(); b.set(db.doc('test_s/b1'), { n: 0 }); b.delete(db.doc('test_s/y'));
      await b.commit();
      o.lista = (await db.collection('test_s').orderBy('n').get()).docs.map((d) => d.id);
      // równoległe zapisy różnych dokumentów i kolejne zapisy jednego dokumentu (kolejność zachowana)
      await Promise.all(Array.from({ length: 12 }, (_, i) => db.collection('test_par').doc(`d${i}`).set({ i })));
      const seria = []; for (let i = 0; i < 6; i++) seria.push(db.doc('test_s/x').update({ n: 100 + i }));
      await Promise.all(seria);
      o.ostatni = (await db.doc('test_s/x').get()).data().n;
      o.par = (await db.collection('test_par').get()).size;
      await db.doc('test_s/g').set({ o: { a: 1, b: { c: 2 } } });
      await db.doc('test_s/g').update({ o: { b: { d: 3 } } });
      o.glebokie = (await db.doc('test_s/g').get()).data();
      await db.doc('test_s/g').delete();
      o.lease = await db.doc('test_lk/blokada').acquire({ holder: 'urzadzenie-P', ttlMs: 5000, data: { wlasciciel: 'P' } });
      const assets = await window.claude.use('assets');
      o.zlyTyp = await assets.upload(new Blob(['<html>'], { type: 'text/html' })).then(() => 'ok', (e) => e.code);
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
      const up = await assets.upload(new Blob([png], { type: 'image/png' }));
      const lista = await assets.list();
      o.listaZasobow = lista.assets.some((a) => a.id === up.id && a.url === '/_blob/' + up.id && !isNaN(Date.parse(a.createdAt))) && lista.usage.files >= 1;
      o.usun = [await assets.delete(up.id), await assets.delete(up.id)];
      return o;
    });
    // drugie urządzenie: dzierżawa zajęta, dane z acquire() widoczne
    const q = await Q.evaluate(async () => {
      const db = await window.claude.use('db');
      return { lease: await db.doc('test_lk/blokada').acquire({ holder: 'urzadzenie-Q', ttlMs: 5000 }), dane: (await db.doc('test_lk/blokada').get()).data() };
    });
    assert.equal(w.lease.acquired, true); assert.equal(w.lease.holder, 'urzadzenie-P');
    assert.equal(q.lease.acquired, false); assert.ok(!isNaN(Date.parse(q.lease.expiresAt)));
    assert.deepEqual(q.dane, { wlasciciel: 'P' });
    assert.deepEqual(w.glebokie, { o: { a: 1, b: { c: 2, d: 3 } } });
    assert.equal(w.zlyTyp, 'unsupported_type');
    assert.equal(w.listaZasobow, true);
    assert.deepEqual(w.usun, [{ deleted: true }, { deleted: false }]);
    assert.deepEqual(w.x, { n: 3 });
    assert.equal(w.brak, 'not_found');
    assert.equal(w.zla, 'invalid_argument');
    assert.deepEqual(w.lista, ['b1', 'x']);
    assert.equal(w.ostatni, 105);
    assert.equal(w.par, 12);
    await Q.waitForFunction(() => window.__zmiany.length && window.__zmiany[window.__zmiany.length - 1] === 'x=105,b1=0', null, { timeout: 10000 });
    const naDysku = JSON.parse(fs.readFileSync(path.join(dane, 'baza.json'), 'utf8'));
    assert.deepEqual(naDysku.collections.test_s, { x: { n: 105 }, b1: { n: 0 } });
    assert.deepEqual(naDysku.collections.test_lk, { blokada: { wlasciciel: 'P' } });
    // celowo wywołane 404 (update brakującego dokumentu) przeglądarka zawsze loguje jako błąd zasobu;
    // za duży dokument runtime odrzuca już po stronie przeglądarki, bez wysyłania
    const celowe = /Failed to load resource: the server responded with a status of 404/;
    assert.equal(P.bledy.filter((b) => celowe.test(b)).length, 1);
    assert.deepEqual([...P.bledy, ...Q.bledy].filter((b) => !celowe.test(b)), []);
  } finally { await ctx1.close(); await ctx2.close(); await srv.zatrzymaj(); }
});

/* ======================================================================
   (e) tryby awaryjne
   ====================================================================== */
test('(e1) bez IndexedDB → localStorage, dane zostają po odświeżeniu, synchronizacja kart', { timeout: 60000 }, async () => {
  const ctx = await przegladarka.newContext();
  await ctx.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { get() { return undefined; }, configurable: true }); });
  try {
    const A = sledz(await ctx.newPage(), 'LS-A'), B = sledz(await ctx.newPage(), 'LS-B');
    await A.goto(URL_PLIKU); await gotowa(A);
    await B.goto(URL_PLIKU); await gotowa(B);
    assert.equal(await A.evaluate(() => EP_LOCAL.storage), 'localstorage');
    assert.match(await A.evaluate(() => EP_LOCAL.label), /localStorage/);
    await dodajOperacje(A, { kurier: 'dpd', ilosc: 5 });
    await czekajNaToast(A, /WZ-00001/);
    await saldo(B, '5 szt.');
    await A.reload(); await gotowa(A);
    await saldo(A, '5 szt.');
    assert.equal(await A.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('ewidencja-palet:d:transactions/')).length), 1);
    assert.deepEqual([...A.bledy, ...B.bledy].filter((b) => !/IndexedDB/.test(b)), []);
  } finally { await ctx.close(); }
});

test('(e2) bez IndexedDB i localStorage → tylko pamięć + wyraźne ostrzeżenie', { timeout: 60000 }, async () => {
  const ctx = await przegladarka.newContext();
  await ctx.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { get() { return undefined; }, configurable: true });
    Storage.prototype.setItem = function () { throw new DOMException('zablokowane', 'SecurityError'); };
  });
  try {
    const A = sledz(await ctx.newPage(), 'MEM');
    await A.goto(URL_PLIKU); await gotowa(A);
    assert.equal(await A.evaluate(() => EP_LOCAL.storage), 'memory');
    const baner = await A.waitForSelector('[data-ep-banner="pamiec"]');
    assert.match(await baner.textContent(), /nie pozwala zapisywać danych — zmiany znikną po zamknięciu karty/);
    await dodajOperacje(A, { kurier: 'dpd', ilosc: 6 });
    await czekajNaToast(A, /WZ-00001/);
    await saldo(A, '6 szt.');
    assert.deepEqual(A.bledy, []);
  } finally { await ctx.close(); }
});

test('(e3) bez BroadcastChannel (Safari 14) → synchronizacja kart przez zdarzenie storage, także logo', { timeout: 60000 }, async () => {
  const ctx = await przegladarka.newContext();
  await ctx.addInitScript(() => { window.BroadcastChannel = undefined; });
  try {
    const A = sledz(await ctx.newPage(), 'BC-A'), B = sledz(await ctx.newPage(), 'BC-B');
    await A.goto(URL_PLIKU); await gotowa(A);
    await B.goto(URL_PLIKU); await gotowa(B);
    assert.equal(await A.evaluate(() => EP_LOCAL.storage), 'indexeddb');
    await dodajOperacje(A, { kurier: 'gls', ilosc: 9 });
    await czekajNaToast(A, /WZ-00001/);
    await saldo(B, '9 szt.');
    await wgrajLogo(A, 'gls', PNG_1X1);
    await logoWidoczne(B, `data:image/png;base64,${PNG_1X1.toString('base64')}`);
    assert.deepEqual([...A.bledy, ...B.bledy], []);
  } finally { await ctx.close(); }
});

test('(e4) strona z „zwykłego” serwera WWW bez API → tryb przeglądarki (bez paska)', { timeout: 60000 }, async () => {
  const ctx = await przegladarka.newContext();
  const pliki = { '/': 'index.html', '/index.html': 'index.html', '/runtime-lokalny.js': 'runtime-lokalny.js' };
  await ctx.route('http://statyczny.test/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    const plik = pliki[p] || (p.startsWith('/fonts/') ? p.slice(1) : null);
    if (!plik) return route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>404</h1>' });
    const typ = plik.endsWith('.html') ? 'text/html; charset=utf-8' : plik.endsWith('.js') ? 'text/javascript' : plik.endsWith('.css') ? 'text/css' : 'font/woff2';
    return route.fulfill({ status: 200, contentType: typ, body: fs.readFileSync(path.join(KATALOG, plik)) });
  });
  try {
    const A = sledz(await ctx.newPage(), 'WWW');
    await A.goto('http://statyczny.test/'); await gotowa(A);
    assert.deepEqual(await A.evaluate(() => [EP_LOCAL.mode, EP_LOCAL.storage]), ['browser', 'indexeddb']);
    assert.equal(await A.$('[data-ep-banner]'), null);
    assert.deepEqual(A.bledy.filter((b) => !/404/.test(b)), []);
  } finally { await ctx.close(); }
});

/* ======================================================================
   (g) poprawki po QA wersji lokalnej: numeracja WZ/PZ przy nieaktualnym lustrze (tryb serwera i przeglądarki),
       pasek „brak połączenia”, dostarczenia migawek, dzierżawa w trybie localStorage, komunikat o odtworzeniu
       bazy, adres /index.html/
   ====================================================================== */
const { stworzSerwer, konfiguracja } = require('../server.js');
const { jsonPost: postJson } = require('./pomocnicy-serwera');
/** Serwer w tym samym procesie (dostęp do strumieni SSE i do zapisu na dysk — np. wolny dysk). */
async function serwerWProcesie(env = {}) {
  const dane = tymczasowyKatalog(); sprzatanie.push(dane);
  const s = stworzSerwer(konfiguracja({ HOST: '127.0.0.1', PORT: '0', DATA_DIR: dane, ...env }, []), { warn: () => {}, error: () => {} });
  s.start();
  await new Promise((r) => s.serwer.listen(0, '127.0.0.1', r));
  const port = s.serwer.address().port;
  return {
    ...s, dane, port, url: `http://127.0.0.1:${port}/`,
    async zamknij() { s.zatrzymaj(); if (s.serwer.closeAllConnections) s.serwer.closeAllConnections(); await new Promise((r) => s.serwer.close(r)); },
  };
}
// kurierzy i liczniki od razu na serwerze (bez zakładania domyślnych przez aplikację)
async function zasiej(port) {
  await postJson(port, '/api/batch', { writes: [
    { op: 'set', coll: 'couriers', id: 'dpd', data: { name: 'DPD', order: 1, color: '#DC0032', custom: false, enabled: true } },
    { op: 'set', coll: 'couriers', id: 'gls', data: { name: 'GLS', order: 2, color: '#061AB1', custom: false, enabled: true } },
    { op: 'set', coll: 'meta', id: 'settings', data: { seeded: true } },
    { op: 'set', coll: 'meta', id: 'counters', data: { wz: 0, pz: 0 } },
  ] });
}
async function wypelnij(page, { kurier = 'dpd', typ = 'wydanie', ilosc }) {
  await idzDo(page, 'new');
  await page.waitForSelector('#opForm');
  await page.click(`#opForm label.opt-${typ}`);
  await page.selectOption('#kurierSelect', kurier);
  await page.fill('#opForm input[name="ilosc"]', String(ilosc));
}
// czeka na wynik zapisu (komunikat), zwraca jego treść i sprząta komunikaty
async function wynikZapisu(page, ms = 60000) {
  await page.waitForFunction(() => [...document.querySelectorAll('#toastRoot .toast')].some((t) => /Zarejestrowano|Nie udało|zajęta/.test(t.textContent)), null, { timeout: ms });
  const t = await page.$$eval('#toastRoot .toast', (ts) => ts.map((x) => x.textContent.trim()).join(' / '));
  await page.evaluate(() => document.querySelectorAll('#toastRoot .toast').forEach((x) => x.remove()));
  return t;
}
async function zapiszOp(page, o) { await wypelnij(page, o); await page.click('#opForm button[type="submit"]'); return wynikZapisu(page); }
function sprawdzNumery(snap, oczekiwanaLiczba) {
  const nr = Object.values(snap.collections.transactions || {}).map((t) => t.nr).sort();
  assert.equal(nr.length, oczekiwanaLiczba, `liczba operacji: ${nr.join(',')}`);
  assert.equal(new Set(nr).size, nr.length, `zduplikowane numery: ${nr.join(',')}`);
  const wz = nr.filter((n) => n.startsWith('WZ')).map((n) => Number(n.slice(3)));
  assert.equal(snap.collections.meta.counters.wz, Math.max(0, ...wz), `licznik WZ (${JSON.stringify(snap.collections.meta.counters)}) = najwyższy numer`);
  return nr;
}
const WIDOCZNOSC = () => {
  window.EP_LOCAL_OPCJE = Object.assign({ pauzaUkrytejKartyMs: 300 }, window.EP_LOCAL_OPCJE || {});
  window.__widocznosc = 'visible';
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return window.__widocznosc; } });
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return window.__widocznosc === 'hidden'; } });
};
const ustawWidocznosc = (page, v) => page.evaluate((x) => { window.__widocznosc = x; document.dispatchEvent(new Event('visibilitychange')); }, v);

test('(g1) telefon wraca z tła (SSE zwolnione) i od razu zapisuje, wczytywanie stanu wolne → numer WZ unikalny, licznik się nie cofa', { timeout: 120000 }, async () => {
  const dane = tymczasowyKatalog(); sprzatanie.push(dane);
  const srv = await uruchomSerwer({ dataDir: dane });
  await zasiej(srv.port);
  const ctxA = await przegladarka.newContext(), ctxB = await przegladarka.newContext();
  await ctxB.addInitScript(WIDOCZNOSC);
  try {
    const A = sledz(await ctxA.newPage(), 'A'), B = sledz(await ctxB.newPage(), 'TELEFON');
    await A.goto(srv.url + '/'); await gotowa(A);
    await B.goto(srv.url + '/'); await gotowa(B);
    assert.match(await zapiszOp(A, { ilosc: 4 }), /WZ-00001/);
    await saldo(B, '4 szt.');
    await ustawWidocznosc(B, 'hidden');
    await B.waitForFunction(() => EP_LOCAL.polaczenie === 'wstrzymane', null, { timeout: 5000 });
    assert.match(await zapiszOp(A, { ilosc: 5 }), /WZ-00002/);
    assert.match(await zapiszOp(A, { ilosc: 6 }), /WZ-00003/);
    await B.waitForTimeout(3000); // dzierżawa A dawno wygasła
    await wypelnij(B, { ilosc: 7 }); // formularz otwarty przed zablokowaniem telefonu
    await B.route('**/api/snapshot', async (r) => { await new Promise((x) => setTimeout(x, 1500)); r.continue(); }); // duża baza, słabe Wi-Fi
    await ustawWidocznosc(B, 'visible');
    await B.click('#opForm button[type="submit"]');
    assert.match(await wynikZapisu(B), /Zarejestrowano wydanie palet \(WZ-00004\)/);
    const snap = (await zadanieJson(srv.port, '/api/snapshot'));
    sprawdzNumery(snap, 4);
    await saldo(A, '22 szt.'); await saldo(B, '22 szt.');
    assert.deepEqual(tylkoSiec([...A.bledy, ...B.bledy]), []);
  } finally { await ctxA.close(); await ctxB.close(); await srv.zatrzymaj(); }
});
async function zadanieJson(port, p) { const { zadanie } = require('./pomocnicy-serwera'); return (await zadanie(port, { path: p })).json; }

test('(g2) „zawieszone” połączenie na żywo: zapis nadaje poprawny numer od razu, a po ~ciszy strona sama łączy się ponownie', { timeout: 120000 }, async () => {
  const srv = await serwerWProcesie({ EP_HEARTBEAT_MS: '400' });
  await zasiej(srv.port);
  const ctx = await przegladarka.newContext();
  await ctx.addInitScript(() => { window.EP_LOCAL_OPCJE = { ciszaSseMs: 3000 }; });
  const zawies = (przed) => { const r = [...srv.klienciSse].filter((x) => !przed.has(x)); assert.equal(r.length, 1, 'jeden nowy strumień B'); r[0].write = () => true; };
  try {
    const A = sledz(await ctx.newPage(), 'A');
    await A.goto(srv.url); await gotowa(A);
    let przed = new Set(srv.klienciSse);
    const B = sledz(await ctx.newPage(), 'B');
    await B.goto(srv.url); await gotowa(B);
    await B.waitForFunction(() => EP_LOCAL.polaczenie === 'otwarte');
    assert.match(await zapiszOp(A, { ilosc: 5 }), /WZ-00001/);
    await saldo(B, '5 szt.');
    // 1) B nic nie robi: po ~3 s ciszy (brak „ping”) łączy się ponownie i dociąga zmiany
    zawies(przed); przed = new Set(srv.klienciSse);
    assert.match(await zapiszOp(A, { ilosc: 6 }), /WZ-00002/);
    await saldo(B, '11 szt.', 15000);
    assert.equal(await B.evaluate(() => EP_LOCAL.polaczenie), 'otwarte');
    // 2) znów zawieszone; B zapisuje zaraz po dwóch zapisach A (nie równocześnie) — numer nie może się powtórzyć
    await B.waitForFunction(() => EP_LOCAL.polaczenie === 'otwarte');
    zawies(przed);
    assert.match(await zapiszOp(A, { ilosc: 7 }), /WZ-00003/);
    assert.match(await zapiszOp(A, { ilosc: 8 }), /WZ-00004/);
    assert.match(await zapiszOp(B, { ilosc: 9 }), /Zarejestrowano wydanie palet \(WZ-00005\)/);
    assert.equal(await B.evaluate(() => EP_LOCAL.online), true);
    assert.equal(await B.$('[data-ep-banner="offline"]'), null, 'zapisy działają — bez paska „brak połączenia”');
    sprawdzNumery(srv.baza.snapshot(), 5);
    await saldo(A, '35 szt.'); await saldo(B, '35 szt.');
    assert.deepEqual(tylkoSiec([...A.bledy, ...B.bledy]), []);
  } finally { await ctx.close(); await srv.zamknij(); }
});

test('(g3) wolny dysk serwera (zapis 3 s, dłużej niż dzierżawa): dwa urządzenia zapisują w tej samej chwili → numery unikalne', { timeout: 180000 }, async () => {
  const srv = await serwerWProcesie();
  await zasiej(srv.port);
  const oryg = srv.baza.zapiszPlik.bind(srv.baza);
  srv.baza.zapiszPlik = async (t) => { await new Promise((r) => setTimeout(r, 3000)); return oryg(t); };
  const ctxA = await przegladarka.newContext(), ctxB = await przegladarka.newContext();
  try {
    const A = sledz(await ctxA.newPage(), 'A'), B = sledz(await ctxB.newPage(), 'B');
    await A.goto(srv.url); await gotowa(A);
    await B.goto(srv.url); await gotowa(B);
    for (let runda = 0; runda < 2; runda++) {
      await wypelnij(A, { ilosc: 10 + runda }); await wypelnij(B, { ilosc: 20 + runda });
      await Promise.all([A.click('#opForm button[type="submit"]'), B.click('#opForm button[type="submit"]')]);
      const [ta, tb] = await Promise.all([wynikZapisu(A, 90000), wynikZapisu(B, 90000)]);
      assert.doesNotMatch(ta + tb, /Nie udało|zajęta/, `runda ${runda}: ${ta} | ${tb}`);
    }
    sprawdzNumery(srv.baza.snapshot(), 4);
    assert.deepEqual(tylkoSiec([...A.bledy, ...B.bledy]), []);
  } finally { await ctxA.close(); await ctxB.close(); await srv.zamknij(); }
});

test('(g4) pasek „Brak połączenia… zmiany nie są zapisywane” znika po pierwszym udanym zapisie', { timeout: 90000 }, async () => {
  const dane = tymczasowyKatalog(); sprzatanie.push(dane);
  const srv = await uruchomSerwer({ dataDir: dane });
  await zasiej(srv.port);
  const ctx = await przegladarka.newContext();
  try {
    const A = sledz(await ctx.newPage(), 'PASEK');
    await A.goto(srv.url + '/'); await gotowa(A);
    await A.waitForFunction(() => EP_LOCAL.polaczenie === 'otwarte');
    // czy pasek w ogóle się pokazał (znika szybko — przy następnym udanym żądaniu)
    await A.evaluate(() => { window.__pasek = []; new MutationObserver(() => { const b = document.querySelector('[data-ep-banner="offline"]'); if (b) window.__pasek.push(b.textContent); }).observe(document.body, { childList: true, subtree: true }); });
    let raz = true; // jedno żądanie ginie w sieci (chwilowy błąd Wi-Fi / 502 z proxy)
    await A.route('**/api/write', (r) => { if (raz && /"coll":"transactions"/.test(r.request().postData() || '')) { raz = false; return r.abort('connectionreset'); } return r.continue(); });
    assert.match(await zapiszOp(A, { ilosc: 5 }), /Nie udało się zapisać operacji/);
    await A.waitForFunction(() => window.__pasek.length > 0, null, { timeout: 5000 });
    assert.match((await A.evaluate(() => window.__pasek))[0], /Brak połączenia z serwerem/);
    // aplikacja oddaje numer (kolejne żądanie do serwera) — udane żądanie od razu chowa pasek
    await A.waitForFunction(() => !document.querySelector('[data-ep-banner="offline"]') && EP_LOCAL.online === true, null, { timeout: 5000 });
    assert.match(await zapiszOp(A, { ilosc: 6 }), /Zarejestrowano wydanie palet \(WZ-0000[12]\)/);
    await A.waitForFunction(() => !document.querySelector('[data-ep-banner="offline"]') && EP_LOCAL.online === true, null, { timeout: 3000 });
    await A.waitForTimeout(2000);
    assert.equal(await A.$('[data-ep-banner="offline"]'), null, 'pasek nie wraca, gdy połączenie na żywo działa');
    assert.equal(await A.evaluate(() => EP_LOCAL.polaczenie), 'otwarte');
    assert.deepEqual(tylkoSiec(A.bledy).filter((b) => !/console\.error: (Error|JSHandle)/.test(b)), []);
  } finally { await ctx.close(); await srv.zatrzymaj(); }
});

test('(g5) nasłuch z limitem: ta sama sekwencja migawek w trybie przeglądarki i serwera (bez pustej migawki po własnym zapisie)', { timeout: 90000 }, async () => {
  const przebieg = (page) => page.evaluate(async () => {
    const db = await window.claude.use('db'); const C = db.collection('qa-sem');
    const tick = () => new Promise((r) => setTimeout(r, 80));
    await Promise.all([C.doc('a').set({ s: 'b' }), C.doc('b').set({ s: 'a' }), C.doc('c').set({ s: 'c' }), C.doc('d').set({ s: 'd' })]);
    const log = [], logDoc = [];
    const u1 = C.orderBy('s').limit(3).onSnapshot((s) => log.push(s.docChanges().map((c) => c.type[0] + c.doc.id + c.oldIndex + '>' + c.newIndex).join(' ')));
    const u2 = C.doc('c').onSnapshot((s) => logDoc.push(JSON.stringify(s.data() || null)));
    await tick();
    await C.doc('aa').set({ s: '0' }); await tick();
    await C.doc('aa').delete(); await tick();
    await C.doc('b').update({ s: 'zz' }); await tick();
    await C.doc('c').update({ n: 1 }); await tick();
    await db.batch().set(C.doc('e'), { s: 'e' }).update(C.doc('c'), { n: 2 }).commit(); await tick();
    u1(); u2();
    return { log, logDoc };
  });
  const srv = await uruchomSerwer({ dataDir: (() => { const d = tymczasowyKatalog(); sprzatanie.push(d); return d; })() });
  const ctx = await przegladarka.newContext();
  try {
    const P = await ctx.newPage(); await P.goto(URL_PLIKU); await P.waitForFunction(() => window.EP_LOCAL && EP_LOCAL.storage === 'indexeddb');
    const S = await ctx.newPage(); await S.goto(srv.url + '/'); await S.waitForFunction(() => window.EP_LOCAL && EP_LOCAL.storage === 'server');
    const wP = await przebieg(P), wS = await przebieg(S);
    assert.deepEqual(wS, wP, 'serwer i IndexedDB dostarczają te same migawki');
    assert.equal(wS.log.length, 6, JSON.stringify(wS.log));
    assert.ok(!wS.log.slice(1).includes(''), 'żadnej pustej migawki po zapisie, który zmienił wynik');
  } finally { await ctx.close(); await srv.zatrzymaj(); }
});

// kopia w formacie aplikacji z n operacjami (jak „Pobierz kopię”)
function kopiaTestowa(n) {
  const couriers = [{ id: 'dpd', name: 'DPD', order: 1, color: '#FF3D5A', custom: false, enabled: true }, { id: 'gls', name: 'GLS', order: 2, color: '#2BE8FF', custom: false, enabled: true }];
  const transactions = []; let wz = 0, pz = 0;
  for (let i = 0; i < n; i++) {
    const typ = i % 3 === 2 ? 'zwrot' : 'wydanie';
    const data = new Date(Date.UTC(2024, 9, 1) + Math.floor(i * (700 / n)) * 86400000).toISOString().slice(0, 10);
    transactions.push({ id: `imp${String(i).padStart(6, '0')}`, kurierId: couriers[i % 2].id, kurierNazwa: couriers[i % 2].name, typ, ilosc: 1 + (i % 7), data, uwagi: '', createdAt: Date.parse(data) + i, nr: typ === 'wydanie' ? `WZ-${String(++wz).padStart(5, '0')}` : `PZ-${String(++pz).padStart(5, '0')}` });
  }
  return { app: 'ewidencja-palet', format: 1, exportedAt: new Date().toISOString(), source: 'claude', couriers, transactions, meta: { counters: { wz, pz } }, logos: {}, wz, pz };
}

test('(g6) IndexedDB: druga karta dogania wczytanie kopii z 3000 operacji w ~2 s, a jej zapis dostaje kolejny numer (bez duplikatu)', { timeout: 300000 }, async () => {
  const tmp = tymczasowyKatalog('ep-kopia-'); sprzatanie.push(tmp);
  const k = kopiaTestowa(3000);
  const plik = path.join(tmp, 'kopia-3000.json');
  fs.writeFileSync(plik, JSON.stringify({ ...k, wz: undefined, pz: undefined }));
  const ctx = await przegladarka.newContext();
  try {
    const A = sledz(await ctx.newPage(), 'IMPORT'), B = sledz(await ctx.newPage(), 'DRUGA');
    await A.goto(URL_PLIKU); await gotowa(A);
    await B.goto(URL_PLIKU); await gotowa(B);
    await wczytajKopie(A, plik, 'replace');
    const t0 = Date.now();
    const saldoA = await A.textContent('#sidebarBalance');
    await saldo(B, saldoA, 3000);
    const dogonil = Date.now() - t0;
    assert.equal(await B.evaluate(() => transactions.length), 3000);
    // od razu rejestruje wydanie w drugiej karcie
    assert.match(await zapiszOp(B, { ilosc: 3 }), new RegExp(`Zarejestrowano wydanie palet \\(WZ-0${k.wz + 1}\\)`));
    const r = await A.evaluate(async () => {
      const db = await window.claude.use('db');
      const nr = (await db.collection('transactions').get()).docs.map((d) => d.data().nr);
      return { n: nr.length, unikalne: new Set(nr).size, counters: (await db.doc('meta/counters').get()).data() };
    });
    assert.deepEqual(r, { n: 3001, unikalne: 3001, counters: { wz: k.wz + 1, pz: k.pz } });
    assert.ok(dogonil < 3000, `druga karta dogoniła po ${dogonil} ms`);
    assert.deepEqual([...A.bledy, ...B.bledy], []);
  } finally { await ctx.close(); }
});

test('(g7) localStorage: dzierżawa (acquire) wyklucza się między kartami, zwalnia przy zamknięciu karty', { timeout: 120000 }, async () => {
  for (const bezLocks of [false, true]) {
    const ctx = await przegladarka.newContext();
    await ctx.addInitScript((bez) => {
      Object.defineProperty(window, 'indexedDB', { get() { return undefined; }, configurable: true });
      if (bez) Object.defineProperty(Navigator.prototype, 'locks', { get() { return undefined; }, configurable: true }); // Safari < 15.4
    }, bezLocks);
    try {
      const strony = [await ctx.newPage(), await ctx.newPage()];
      for (const p of strony) { await p.goto(URL_PLIKU); await p.waitForFunction(() => window.EP_LOCAL && EP_LOCAL.storage === 'localstorage'); }
      let oba = 0, nikt = 0;
      for (let i = 0; i < 25; i++) {
        const cel = Date.now() + 150;
        const r = await Promise.all(strony.map((p, k) => p.evaluate(async ([c, n, kk]) => {
          const db = await window.claude.use('db'); const ref = db.doc('meta/wyscig-' + n);
          while (Date.now() < c) { /* wspólna chwila startu */ }
          return (await ref.acquire({ holder: 'h' + kk, ttlMs: 5000 })).acquired;
        }, [cel, i, k])));
        if (r[0] && r[1]) oba++;
        if (!r[0] && !r[1]) nikt++;
      }
      assert.equal(oba, 0, `${bezLocks ? 'bez Web Locks' : 'Web Locks'}: obie karty dostały dzierżawę ${oba}/25 razy`);
      assert.equal(nikt, 0);
      // ten sam posiadacz odnawia, inny dostaje odmowę z expiresAt
      const [a, b] = strony;
      const r1 = await a.evaluate(async () => (await (await window.claude.use('db')).doc('meta/x').acquire({ holder: 'A', ttlMs: 1500 })));
      const r2 = await b.evaluate(async () => (await (await window.claude.use('db')).doc('meta/x').acquire({ holder: 'B', ttlMs: 1500 })));
      const r3 = await a.evaluate(async () => (await (await window.claude.use('db')).doc('meta/x').acquire({ holder: 'A', ttlMs: 1500 })));
      assert.equal(r1.acquired, true); assert.equal(r2.acquired, false); assert.ok(Date.parse(r2.expiresAt) > Date.now() - 100);
      assert.equal(r3.acquired, true); assert.ok(r3.version > r1.version);
      if (!bezLocks) {
        const t0 = Date.now();
        await a.close(); // zamknięta karta zwalnia blokadę od razu (przeglądarka robi to w kilka ms), nie po wygaśnięciu
        let ok = false;
        while (!ok && Date.now() - t0 < 1000) ok = await b.evaluate(async () => (await (await window.claude.use('db')).doc('meta/x').acquire({ holder: 'B', ttlMs: 1500 })).acquired);
        assert.equal(ok, true, 'po zamknięciu karty A dzierżawa wolna przed upływem ttl');
      } else {
        await b.waitForTimeout(1600);
        assert.equal(await b.evaluate(async () => (await (await window.claude.use('db')).doc('meta/x').acquire({ holder: 'B', ttlMs: 1500 })).acquired), true, 'po wygaśnięciu');
      }
    } finally { await ctx.close(); }
  }
});

test('(g8) serwer odtworzył bazę z kopii przy starcie → jednorazowy komunikat w aplikacji (data kopii, nazwa uszkodzonego pliku)', { timeout: 90000 }, async () => {
  const dane = tymczasowyKatalog(); sprzatanie.push(dane);
  let srv = await uruchomSerwer({ dataDir: dane });
  await zasiej(srv.port);
  await postJson(srv.port, '/api/write', { op: 'set', coll: 'transactions', id: 't1', data: { kurierId: 'dpd', kurierNazwa: 'DPD', typ: 'wydanie', ilosc: 9, data: '2026-10-01', uwagi: '', createdAt: 1, nr: 'WZ-00001' } });
  await srv.zatrzymaj();
  fs.writeFileSync(path.join(dane, 'baza.json'), '{"collections": {"transactions": {"t1": ');
  srv = await uruchomSerwer({ dataDir: dane });
  const ctx = await przegladarka.newContext(), ctx2 = await przegladarka.newContext();
  try {
    const A = sledz(await ctx.newPage(), 'ODTWORZENIE');
    await A.goto(srv.url + '/'); await gotowa(A);
    const baner = await A.waitForSelector('[data-ep-banner="odtworzenie"]', { timeout: 10000 });
    const tekst = await baner.textContent();
    assert.match(tekst, /plik bazy na serwerze był uszkodzony/);
    assert.match(tekst, /z kopii z dnia \d{2}\.\d{2}\.\d{4} \(stan z początku tego dnia\)/);
    assert.match(tekst, /baza\.uszkodzona-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json/);
    await A.emulateMedia({ media: 'print' });
    assert.equal(await baner.evaluate((el) => getComputedStyle(el.parentNode).display), 'none', 'nie trafia na wydruk');
    await A.emulateMedia({ media: 'screen' });
    await A.click('[data-ep-banner-zamknij="odtworzenie"]');
    assert.equal(await A.$('[data-ep-banner="odtworzenie"]'), null);
    await A.reload(); await gotowa(A); await A.waitForTimeout(1000);
    assert.equal(await A.$('[data-ep-banner="odtworzenie"]'), null, 'na tym urządzeniu już się nie pokazuje');
    const B = sledz(await ctx2.newPage(), 'INNE-URZADZENIE');
    await B.goto(srv.url + '/'); await gotowa(B);
    await B.waitForSelector('[data-ep-banner="odtworzenie"]', { timeout: 10000 });
    assert.deepEqual([...A.bledy, ...B.bledy], []);
  } finally { await ctx.close(); await ctx2.close(); await srv.zatrzymaj(); }
});

test('(g9) adres /index.html/ (ukośnik na końcu) prowadzi do działającej aplikacji, a nie do strony bez bazy', { timeout: 60000 }, async () => {
  const dane = tymczasowyKatalog(); sprzatanie.push(dane);
  const srv = await uruchomSerwer({ dataDir: dane });
  await zasiej(srv.port);
  const ctx = await przegladarka.newContext();
  try {
    const A = sledz(await ctx.newPage(), 'UKOSNIK');
    await A.goto(srv.url + '/index.html/'); await gotowa(A);
    assert.equal(new URL(A.url()).pathname, '/');
    assert.deepEqual(await A.evaluate(() => [EP_LOCAL.mode, EP_LOCAL.storage]), ['server', 'server']);
    assert.deepEqual(A.bledy, []);
  } finally { await ctx.close(); await srv.zatrzymaj(); }
});

/* ======================================================================
   (h) poprawki wersji 2.1 (testy odbiorcze): hasło po zmianie, zakres dat rozliczenia, „Zapisz ponownie”,
       powrót usuniętego kuriera z historią, „Połącz” z zajętymi numerami
   ====================================================================== */
test('(h1) zmiana hasła na serwerze: karta pokazuje pasek z „Odśwież stronę”, nie ponawia prób w tle; nowe hasło działa bez blokady', { timeout: 120000 }, async () => {
  const dane = tymczasowyKatalog(); sprzatanie.push(dane);
  let srv = await uruchomSerwer({ dataDir: dane, env: { EP_HASLO: 'stare-haslo', EP_BLOKADA_HASLA_MS: '60000' } });
  const port = srv.port, url = `http://127.0.0.1:${port}/`;
  const ctx = await przegladarka.newContext({ httpCredentials: { username: 'biuro', password: 'stare-haslo' } });
  try {
    const A = await ctx.newPage();
    await A.goto(url); await gotowa(A);
    await srv.zatrzymaj();
    srv = await uruchomSerwer({ dataDir: dane, port, env: { EP_HASLO: 'nowe-haslo', EP_BLOKADA_HASLA_MS: '60000' } });
    const baner = await A.waitForSelector('[data-ep-banner="auth"]', { timeout: 30000 });
    const tekst = await baner.textContent();
    assert.match(tekst, /Serwer wymaga hasła/);
    assert.match(tekst, /Odśwież stronę/);
    assert.equal(await A.$('[data-ep-banner="offline"]'), null, 'jeden pasek — o haśle, nie o braku połączenia');
    await A.waitForTimeout(500);
    let zadania = 0;
    A.on('request', (r) => { if (r.url().startsWith(url)) zadania++; });
    await A.waitForTimeout(8000);
    assert.equal(zadania, 0, 'po odrzuconym haśle strona nie ponawia prób w tle');
    const ctx2 = await przegladarka.newContext({ httpCredentials: { username: 'magazyn', password: 'nowe-haslo' } });
    try {
      const B = await ctx2.newPage();
      const r = await B.goto(url);
      assert.equal(r.status(), 200, 'nowe hasło działa — stara karta nie zablokowała logowania');
      await gotowa(B);
    } finally { await ctx2.close(); }
    assert.doesNotMatch(srv.wyjscie() + srv.bledy(), /wstrzymane/);
  } finally { await ctx.close(); await srv.zatrzymaj(); }
});

test('(h2) rozliczenie: odwrócony zakres dat to błąd (bez zamiany); „Zapisz ponownie” nie wraca w kontroli danych; usunięty kurier wraca z historią', { timeout: 120000 }, async () => {
  const ctx = await przegladarka.newContext();
  try {
    const A = sledz(await ctx.newPage(), 'H2');
    await A.goto(URL_PLIKU); await gotowa(A);
    assert.deepEqual(await A.evaluate(() => [slugify('Poczta Polska – Łódź'), slugify('Głowacki Transport'), slugify('ŁÓDŹ')]),
      ['poczta-polska-lodz', 'glowacki-transport', 'lodz']);
    // ta sama operacja dwa razy, świadomie potwierdzona
    assert.match(await zapiszOp(A, { kurier: 'dpd', ilosc: 11 }), /WZ-00001/);
    await wypelnij(A, { kurier: 'dpd', ilosc: 11 });
    await A.click('#opForm button[type="submit"]');
    await A.waitForSelector('#confirmBtn');
    assert.match(await A.textContent('#modalRoot'), /Taka operacja już jest/);
    await A.click('#confirmBtn');
    assert.match(await wynikZapisu(A), /WZ-00002/);
    await doUstawien(A);
    await A.waitForFunction(() => /Kontrola danych/.test(document.getElementById('main').innerText));
    assert.doesNotMatch(await A.innerText('#main'), /Możliwy podwójny wpis/, 'potwierdzone „Zapisz ponownie” to nie duplikat');
    // rozliczenie: „od” późniejsze niż „do” — pokazane jako błąd, daty bez zmian, wydruk i CSV wyłączone
    await A.evaluate(() => openCourierDetail('dpd'));
    await A.waitForSelector('#stFrom');
    const [dzis, wczoraj] = await A.evaluate(() => [todayStr(), addDays(todayStr(), -1)]);
    await A.fill('#stTo', wczoraj);
    await A.waitForFunction((w) => stTo === w, wczoraj);
    await A.fill('#stFrom', dzis);
    await A.waitForSelector('#stRangeErr');
    assert.deepEqual(await A.evaluate(() => [stFrom, stTo]), [dzis, wczoraj], 'daty nie są zamieniane');
    assert.match(await A.textContent('#stRangeErr'), /jest późniejsza niż „do”/);
    assert.equal(await A.getAttribute('[data-action="st-print"]', 'aria-disabled'), 'true');
    assert.equal(await A.getAttribute('[data-action="st-csv"]', 'aria-disabled'), 'true');
    await A.click('[data-action="st-csv"]', { force: true });   // wygląda na wyłączony, ale klik daje komunikat
    await czekajNaToast(A, /Popraw okres/, true);
    // poprawienie daty i od razu klik w CSV (bez wychodzenia z pola): pierwszy klik działa
    await A.fill('#stTo', dzis);
    const csv = await pobierz(A, '[data-action="st-csv"]');
    assert.match(csv.nazwa, new RegExp(`${dzis}-${dzis}\\.csv$`));
    assert.equal(await A.getAttribute('[data-action="st-csv"]', 'aria-disabled'), null);
    // usunięty kurier z operacjami: „Dodaj kuriera” z tą samą nazwą proponuje przywrócenie z historią
    const nazwa = await A.evaluate(() => courierById('dpd').name);
    await A.evaluate(() => deleteCourier('dpd'));
    await A.waitForFunction(() => !courierById('dpd'));
    await A.evaluate(() => openAddCourierModal());
    await A.fill('#addCourierName', nazwa.toLowerCase());
    await A.click('#addCourierForm button[type="submit"]');
    await A.waitForSelector('#confirmBtn');
    assert.match(await A.textContent('#modalRoot'), /był już w ewidencji[\s\S]*2 operacje/);
    await A.click('#confirmBtn');
    await czekajNaToast(A, /Przywrócono kuriera/);
    await A.waitForFunction(() => courierById('dpd') && couriers.length === 4);
    await saldo(A, '22 szt.');
    assert.deepEqual(A.bledy, []);
  } finally { await ctx.close(); }
});

test('(h3) „Połącz” w trybie serwera: operacje z pliku z zajętymi numerami dostają kolejne wolne numery (bez dziur)', { timeout: 120000 }, async () => {
  const dane = tymczasowyKatalog(); sprzatanie.push(dane);
  const srv = await uruchomSerwer({ dataDir: dane });
  await zasiej(srv.port);
  const op = (id, n, createdAt) => ({ kurierId: 'dpd', kurierNazwa: 'DPD', typ: 'wydanie', ilosc: n, data: '2026-10-01', uwagi: '', createdAt, nr: `WZ-0000${n}` });
  await postJson(srv.port, '/api/batch', { writes: [
    ...[1, 2, 3, 4, 5].map((n) => ({ op: 'set', coll: 'transactions', id: `loc${n}`, data: op(`loc${n}`, n, 1000 + n) })),
    { op: 'set', coll: 'meta', id: 'counters', data: { wz: 5, pz: 0 } },
  ] });
  const tmp = tymczasowyKatalog('ep-kopia-'); sprzatanie.push(tmp);
  const plik = path.join(tmp, 'druga-lokalizacja.json');
  fs.writeFileSync(plik, JSON.stringify({ app: 'ewidencja-palet', format: 1, exportedAt: new Date().toISOString(),
    couriers: [{ id: 'dpd', name: 'DPD', order: 1, color: '#DC0032', custom: false, enabled: true }],
    transactions: [1, 2, 3, 4, 5].map((n) => ({ id: `rem${n}`, ...op(`rem${n}`, n, 5000 + n) })), meta: { counters: { wz: 5, pz: 0 } }, logos: {} }));
  const ctx = await przegladarka.newContext();
  try {
    const A = sledz(await ctx.newPage(), 'H3');
    await A.goto(srv.url); await gotowa(A);
    await wczytajKopie(A, plik, 'merge');
    const snap = await zadanieJson(srv.port, '/api/snapshot');
    const tx = snap.collections.transactions;
    assert.deepEqual([1, 2, 3, 4, 5].map((n) => tx[`rem${n}`].nr), ['WZ-00006', 'WZ-00007', 'WZ-00008', 'WZ-00009', 'WZ-00010']);
    sprawdzNumery(snap, 10);
    assert.match(await zapiszOp(A, { kurier: 'dpd', ilosc: 3 }), /WZ-00011/, 'kolejna operacja — następny numer, bez dziury');
    assert.deepEqual(A.bledy, []);
  } finally { await ctx.close(); await srv.zatrzymaj(); }
});

test('(h3b) „Połącz”: operacja zapisana na innym urządzeniu, gdy import czeka na numerację, nie dubluje numeru z pliku', { timeout: 120000 }, async () => {
  const dane = tymczasowyKatalog(); sprzatanie.push(dane);
  const srv = await uruchomSerwer({ dataDir: dane });
  await zasiej(srv.port);
  const op = (n, createdAt) => ({ kurierId: 'dpd', kurierNazwa: 'DPD', typ: 'wydanie', ilosc: n, data: '2026-10-01', uwagi: '', createdAt, nr: `WZ-0000${n}` });
  await postJson(srv.port, '/api/batch', { writes: [
    ...[1, 2, 3, 4, 5].map((n) => ({ op: 'set', coll: 'transactions', id: `loc${n}`, data: op(n, 1000 + n) })),
    { op: 'set', coll: 'meta', id: 'counters', data: { wz: 5, pz: 0 } },
  ] });
  const tmp = tymczasowyKatalog('ep-kopia-'); sprzatanie.push(tmp);
  const plik = path.join(tmp, 'siedem.json');   // druga lokalizacja ma już WZ-00001…WZ-00007
  fs.writeFileSync(plik, JSON.stringify({ app: 'ewidencja-palet', format: 1, exportedAt: new Date().toISOString(),
    couriers: [{ id: 'dpd', name: 'DPD', order: 1, color: '#DC0032', custom: false, enabled: true }],
    transactions: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `rem${n}`, ...op(n, 5000 + n) })), meta: { counters: { wz: 7, pz: 0 } }, logos: {} }));
  const ctx = await przegladarka.newContext();
  try {
    const A = sledz(await ctx.newPage(), 'H3b-A'), B = sledz(await ctx.newPage(), 'H3b-B');
    await A.goto(srv.url); await gotowa(A); await B.goto(srv.url); await gotowa(B);
    await A.waitForTimeout(3000);   // dzierżawy numeracji z uruchomienia wygasają
    await doUstawien(A); await A.setInputFiles('#backupFile', plik); await A.waitForSelector('#importGo');
    await A.check('#modalRoot input[name="importMode"][value="merge"]');
    assert.match(await zapiszOp(B, { kurier: 'dpd', ilosc: 51 }), /WZ-00006/);   // B trzyma teraz dzierżawę ~2,5 s
    await A.waitForFunction(() => transactions.some((t) => t.nr === 'WZ-00006'));
    // A klika „Wczytaj” i czeka na dzierżawę; B w tym czasie zapisuje kolejną operację
    const [, drugi] = await Promise.all([A.click('#importGo'), zapiszOp(B, { kurier: 'dpd', ilosc: 52 })]);
    assert.match(drugi, /WZ-00007/);
    await czekajNaToast(A, /Wczytano kopię/, false, 60000);
    sprawdzNumery(await zadanieJson(srv.port, '/api/snapshot'), 14);   // bez dubli, licznik WZ = najwyższy numer
    assert.deepEqual([...A.bledy, ...B.bledy], []);
  } finally { await ctx.close(); await srv.zatrzymaj(); }
});

test('(h4) usunięty kurier: Esc w pytaniu o przywrócenie niczego nie dodaje; „nowy kurier” w formularzu operacji wraca z historią', { timeout: 120000 }, async () => {
  const ctx = await przegladarka.newContext();
  try {
    const A = sledz(await ctx.newPage(), 'H4');
    await A.goto(URL_PLIKU); await gotowa(A);
    await A.evaluate(async () => {
      const db = await window.claude.use('db'); const b = db.batch(); const d = addDays(todayStr(), -1);
      b.set(db.collection('transactions').doc('s1'), { kurierId: 'stary-kurier', kurierNazwa: 'Stary Kurier', typ: 'wydanie', ilosc: 5, data: d, uwagi: '', createdAt: Date.now() - 9e6, nr: 'WZ-00001' });
      b.set(db.collection('transactions').doc('s2'), { kurierId: 'stary-kurier', kurierNazwa: 'Stary Kurier', typ: 'zwrot', ilosc: 1, data: d, uwagi: '', createdAt: Date.now() - 8e6, nr: 'PZ-00001' });
      b.set(db.doc('meta/counters'), { wz: 1, pz: 1 }); await b.commit();
    });
    await A.waitForFunction(() => transactions.length === 2);
    // „Dodaj kuriera” z nazwą usuniętego → pytanie; Esc = wycofanie się, nic nie powstaje
    await A.evaluate(() => openAddCourierModal());
    await A.fill('#addCourierName', 'Stary Kurier');
    await A.click('#addCourierForm button[type="submit"]');
    await A.waitForSelector('#confirmBtn');
    assert.match(await A.textContent('#modalRoot'), /był już w ewidencji[\s\S]*zostały 2 operacje \(bilans \+4\)/);
    await A.keyboard.press('Escape');
    await A.waitForFunction(() => !document.getElementById('confirmBtn'));
    await A.waitForTimeout(300);
    assert.equal(await A.evaluate(() => couriers.filter((c) => /stary/i.test(c.name)).length), 0, 'Esc nic nie dodaje');
    // formularz operacji → „+ nowy kurier” z tą nazwą → „Przywróć z historią” → operacja u przywróconego kuriera
    await idzDo(A, 'new'); await A.waitForSelector('#opForm');
    await A.click('#opForm label.opt-wydanie');
    await A.selectOption('#kurierSelect', '__new__');
    await A.fill('#newCourierName', 'stary kurier');
    await A.fill('#opForm input[name="ilosc"]', '3');
    await A.click('#opForm button[type="submit"]');
    await A.waitForSelector('#confirmBtn');
    assert.match(await A.textContent('#modalRoot'), /Przywrócić go razem z tą historią/);
    await A.click('#confirmBtn');
    assert.match(await wynikZapisu(A), /WZ-00002/);
    assert.deepEqual(await A.evaluate(() => [couriers.filter((c) => /stary/i.test(c.name)).map((c) => c.id), transactions.filter((t) => t.kurierId === 'stary-kurier').length]), [['stary-kurier'], 3]);
    await saldo(A, '7 szt.');
    assert.deepEqual(A.bledy, []);
  } finally { await ctx.close(); }
});

test('(h5) blokada haseł (429) na serwerze: zalogowana karta działa dalej; karta bez sesji czeka do końca blokady i łączy się sama', { timeout: 120000 }, async () => {
  const dane = tymczasowyKatalog(); sprzatanie.push(dane);
  const srv = await uruchomSerwer({ dataDir: dane, env: { EP_HASLO: 'tajne', EP_BLOKADA_HASLA_MS: '4000' } });
  const url = `http://127.0.0.1:${srv.port}/`;
  const { zadanie } = require('./pomocnicy-serwera');
  const zgaduj = async () => { for (let i = 0; i < 5; i++) await zadanie(srv.port, { path: '/api/ping', headers: { Authorization: `Basic ${Buffer.from(`x:zle${i}`).toString('base64')}` } }); };
  const ctxA = await przegladarka.newContext({ httpCredentials: { username: 'biuro', password: 'tajne' } });
  const ctxB = await przegladarka.newContext({ httpCredentials: { username: 'magazyn', password: 'tajne' } });
  try {
    const A = sledz(await ctxA.newPage(), 'H5-A');
    await A.goto(url); await gotowa(A);
    await zgaduj();   // ktoś inny z tego samego adresu wpisuje złe hasła → blokada 4 s
    await dodajOperacje(A, { kurier: 'dpd', ilosc: 4 });
    await czekajNaToast(A, /WZ-00001/);   // zalogowana karta (ciasteczko sesji) zapisuje w czasie blokady
    await zgaduj();
    const B = await ctxB.newPage();   // nowe urządzenie bez sesji trafia na blokadę
    const r = await B.goto(url);
    assert.equal(r.status(), 429);
    assert.match(await B.textContent('body'), /Za dużo błędnych haseł/);
    await B.waitForTimeout(4500);
    await B.reload(); await gotowa(B);   // po blokadzie logowanie działa
    await saldo(B, '4 szt.');
    // otwarta karta bez ważnej sesji trafia na blokadę: pasek z godziną, a po blokadzie łączy się sama
    await ctxB.clearCookies();
    await B.waitForTimeout(4500);
    await zgaduj();
    await B.evaluate(() => window.claude.use('db').then((db) => db.collection('transactions').get()).catch(() => null));
    const baner = await B.waitForSelector('[data-ep-banner="auth"]', { timeout: 10000 });
    assert.match(await baner.textContent(), /wstrzymane do \d\d:\d\d:\d\d[\s\S]*połączy się ponownie sama/);
    await B.waitForFunction(() => !document.querySelector('[data-ep-banner="auth"]') && window.EP_LOCAL.online === true, null, { timeout: 15000 });
    await dodajOperacje(B, { kurier: 'dpd', ilosc: 2 });
    await czekajNaToast(B, /WZ-00002/);
    assert.deepEqual(A.bledy, []);
  } finally { await ctxA.close(); await ctxB.close(); await srv.zatrzymaj(); }
});

test('(h6) kopia zapasowa serwera: stan w „O aplikacji”; gdy się nie zapisuje — pasek ostrzeżenia, znika po naprawie', { timeout: 120000 }, async () => {
  const dane = tymczasowyKatalog(); sprzatanie.push(dane);
  const tmp = tymczasowyKatalog('ep-kz-'); sprzatanie.push(tmp);
  const zly = path.join(tmp, 'kopia'); fs.writeFileSync(zly, 'zwykły plik zamiast folderu');
  const port = await wolnyPort();
  let srv = await uruchomSerwer({ dataDir: dane, port, env: { EP_KOPIA_ZAPASOWA: zly, EP_KOPIA_ZAPASOWA_MS: '200', EP_HEARTBEAT_MS: '500' } });
  const ctx = await przegladarka.newContext();
  try {
    const A = sledz(await ctx.newPage(), 'H6');
    await A.goto(srv.url); await gotowa(A);
    const baner = await A.waitForSelector('[data-ep-banner="kopia"]', { timeout: 10000 });
    assert.match(await baner.textContent(), /kopia zapasowa na serwerze się nie zapisuje/);
    await doUstawien(A);
    await A.waitForFunction(() => /Kopia zapasowa\s*nie zapisuje się/.test(document.getElementById('main').innerText));
    // naprawa: folder zamiast pliku — serwer ponawia przy zmianie, pasek znika sam
    fs.unlinkSync(zly); fs.mkdirSync(zly);
    await dodajOperacje(A, { kurier: 'dpd', ilosc: 3 });
    await czekajNaToast(A, /WZ-00001/);
    await A.waitForFunction(() => !document.querySelector('[data-ep-banner="kopia"]'), null, { timeout: 15000 });
    assert.ok(fs.existsSync(path.join(zly, 'ewidencja-palet-aktualna.json')));
    await idzDo(A, 'dashboard'); await doUstawien(A);
    await A.waitForFunction(() => /Kopia zapasowa\s*po każdej zmianie · ostatnia: \d\d\.\d\d\.\d{4}/.test(document.getElementById('main').innerText));
    assert.deepEqual(A.bledy, []);
  } finally { await ctx.close(); await srv.zatrzymaj(); }
});
