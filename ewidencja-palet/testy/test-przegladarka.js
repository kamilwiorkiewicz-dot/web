// Testy wersji lokalnej w prawdziwej przeglądarce (Chromium przez Playwright).
// Uruchomienie:  NODE_PATH=$(npm root -g) node testy/test-przegladarka.js
//   (a) tryb przeglądarki z dysku (file://): zapis przez UI, odświeżenie, druga karta na żywo,
//       restart przeglądarki, logo, eksport CSV i kopii, brak żądań do internetu
//   (b) tryb serwera: dwa „urządzenia” na żywo, logo u obu, restart serwera, utrata połączenia
//   (c) brak błędów w konsoli (w fazach bez celowo wywołanych awarii)
//   (d) semantyka API bazy (where/orderBy/limit/onSnapshot/docChanges/update/...)
//   (e) tryby awaryjne: localStorage, sama pamięć (z ostrzeżeniem), brak BroadcastChannel (Safari 14)
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

before(async () => {
  const zbudowany = zbuduj(fs.readFileSync(path.join(KATALOG, 'zrodlo', 'aplikacja.html'), 'utf8'));
  assert.ok(fs.existsSync(INDEX) && fs.readFileSync(INDEX, 'utf8') === zbudowany,
    'index.html jest nieaktualny względem zrodlo/aplikacja.html — uruchom: node narzedzia/zbuduj.js');
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
      const db = await usePromise;
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
      for (const f of [() => C.orderBy('n').orderBy('s'), () => C.where('n', '~', 1), () => C.where('s', 'in', 'a'), () => C.limit(-1), () => db.collection('zła nazwa'), () => db.doc('tylko-kolekcja'), () => C.doc('a/b')]) {
        try { f(); bledy.push('brak błędu'); } catch (e) { bledy.push(e.code); }
      }
      out.bledyBudowania = bledy;

      // DocumentSnapshot / deep copy
      const s = await C.doc('a').get();
      out.snap = { id: s.id, exists: s.exists, meta: s.metadata };
      const kopia = s.data(); kopia.n = 999; kopia.tag.push('z');
      out.glebokaKopia = (await C.doc('a').get()).data();
      out.nieistnieje = await C.doc('brak').get().then((x) => ({ exists: x.exists, data: x.data() === undefined ? 'undefined' : x.data() }));

      // update: scalanie, __delete__, not_found
      await C.doc('a').update({ n: 4, s: { __delete__: true }, nowe: null });
      out.poUpdate = (await C.doc('a').get()).data();
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
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
      const up = await assets.upload(new File([png], 'logo.png', { type: 'image/png' }));
      out.upload = { idOk: /^[a-z0-9]{20}$/.test(up.id), urlData: up.url.startsWith('data:image/png;base64,'), size: up.sizeBytes, type: up.contentType };
      out.assetUrl = window.EP_LOCAL.assetUrl(up.id) === up.url;
      const lista = await assets.list();
      out.lista = { jest: lista.assets.some((a) => a.id === up.id), bajty: lista.usage.bytes >= png.length };
      await assets.delete(up.id);
      out.poUsunieciu = [window.EP_LOCAL.assetUrl(up.id), (await assets.list()).assets.some((a) => a.id === up.id)];
      const bezTypu = await assets.upload(new File([png], 'logo.webp', { type: '' }));
      out.typZRozszerzenia = bezTypu.contentType;
      return out;
    });

    assert.equal(wynik.usePromise, true);
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
    assert.deepEqual(wynik.bledyBudowania, Array(7).fill('invalid_argument'));
    assert.deepEqual(wynik.snap, { id: 'a', exists: true, meta: {} });
    assert.deepEqual(wynik.glebokaKopia, { n: 3, s: 'b', tag: ['x', 'y'], d: '2026-01-02' }, 'data() zwraca kopię');
    assert.deepEqual(wynik.nieistnieje, { exists: false, data: 'undefined' });
    assert.deepEqual(wynik.poUpdate, { n: 4, tag: ['x', 'y'], d: '2026-01-02', nowe: null });
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

    assert.equal(wynik.zlyTyp, 'invalid_argument');
    assert.equal(wynik.zaDuze, 'invalid_argument');
    assert.deepEqual(wynik.upload, { idOk: true, urlData: true, size: PNG_1X1.length, type: 'image/png' });
    assert.equal(wynik.assetUrl, true);
    assert.deepEqual(wynik.lista, { jest: true, bajty: true });
    assert.deepEqual(wynik.poUsunieciu, [null, false]);
    assert.equal(wynik.typZRozszerzenia, 'image/webp');

    // downloads.save: tekst, bajty, Blob
    const pobrania = [];
    P.on('download', (d) => pobrania.push(d));
    await P.evaluate(async () => {
      const dl = await window.claude.use('downloads');
      await dl.save({ filename: 'a.csv', data: '﻿x;y\r\n1;ą' });
      await dl.save({ filename: 'b.bin', data: new Uint8Array([1, 2, 3]) });
      await dl.save({ filename: 'c.bin', data: new Uint8Array([4, 5]).buffer });
      await dl.save({ filename: 'd/../e.json', data: new Blob(['{"a":1}'], { type: 'application/json' }) });
      window.__zlyZapis = await dl.save({ filename: '', data: 'x' }).then(() => 'ok', (e) => e.code);
    });
    await P.waitForTimeout(500);
    assert.equal(await P.evaluate(() => window.__zlyZapis), 'invalid_argument');
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
      return o;
    });
    assert.deepEqual(w.x, { n: 3 });
    assert.equal(w.brak, 'not_found');
    assert.equal(w.zla, 'invalid_argument');
    assert.deepEqual(w.lista, ['b1', 'x']);
    assert.equal(w.ostatni, 105);
    assert.equal(w.par, 12);
    await Q.waitForFunction(() => window.__zmiany.length && window.__zmiany[window.__zmiany.length - 1] === 'x=105,b1=0', null, { timeout: 10000 });
    const naDysku = JSON.parse(fs.readFileSync(path.join(dane, 'baza.json'), 'utf8'));
    assert.deepEqual(naDysku.collections.test_s, { x: { n: 105 }, b1: { n: 0 } });
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
