// Testy serwera lokalnego (node:test, bez zależności).
// Uruchomienie:  node --test testy/test-serwer.js     (albo: node testy/test-serwer.js)
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { KATALOG, tymczasowyKatalog, uruchomSerwer, zadanie, jsonPost, klientSse, PNG_1X1 } = require('./pomocnicy-serwera');

const dzis = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
const sprzatanie = [];
let S, dir;

before(async () => {
  assert.ok(fs.existsSync(path.join(KATALOG, 'index.html')), 'Brak index.html — najpierw: node narzedzia/zbuduj.js');
  dir = tymczasowyKatalog(); sprzatanie.push(dir);
  S = await uruchomSerwer({ dataDir: dir });
});
after(async () => {
  if (S) await S.zatrzymaj();
  for (const d of sprzatanie) fs.rmSync(d, { recursive: true, force: true });
});

const zapisz = (port, w) => jsonPost(port, '/api/write', w);
const snapshot = async (port, headers) => (await zadanie(port, { path: '/api/snapshot', headers })).json;

test('GET /api/ping', async () => {
  const r = await zadanie(S.port, { path: '/api/ping' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /application\/json/);
  assert.equal(r.json.app, 'ewidencja-palet');
  assert.equal(r.json.mode, 'server');
  assert.equal(typeof r.json.version, 'string');
});

test('GET /api/snapshot — pusta baza ma właściwy kształt', async () => {
  const s = await snapshot(S.port);
  assert.equal(typeof s.rev, 'number');
  assert.deepEqual(s.collections, {});
  assert.deepEqual(s.assets, []);
});

test('set / update (scalanie, __delete__) / delete', async () => {
  let r = await zapisz(S.port, { op: 'set', coll: 'couriers', id: 'dpd', data: { name: 'DPD', order: 1, color: '#DC0032', custom: false }, clientId: 'k1' });
  assert.equal(r.status, 200); assert.equal(r.json.ok, true);
  const rev1 = r.json.rev; assert.equal(typeof rev1, 'number');

  r = await zapisz(S.port, { op: 'update', coll: 'couriers', id: 'dpd', data: { order: 5, custom: { __delete__: true }, logoAssetId: null } });
  assert.equal(r.status, 200); assert.equal(r.json.rev, rev1 + 1);
  let s = await snapshot(S.port);
  assert.deepEqual(s.collections.couriers.dpd, { name: 'DPD', order: 5, color: '#DC0032', logoAssetId: null });
  assert.equal(s.rev, rev1 + 1);

  // set zastępuje cały dokument
  await zapisz(S.port, { op: 'set', coll: 'couriers', id: 'dpd', data: { name: 'DPD 2' } });
  s = await snapshot(S.port);
  assert.deepEqual(s.collections.couriers.dpd, { name: 'DPD 2' });

  // polskie znaki i liczby całkowite przechodzą bez zmian
  await zapisz(S.port, { op: 'set', coll: 'transactions', id: 't1', data: { kurierId: 'dpd', kurierNazwa: 'DPD', typ: 'wydanie', ilosc: 12, data: '2026-10-03', uwagi: 'zażółć gęślą jaźń „cudzysłów”', createdAt: 1791000000000, nr: 'WZ-00001' } });
  s = await snapshot(S.port);
  assert.equal(s.collections.transactions.t1.uwagi, 'zażółć gęślą jaźń „cudzysłów”');
  assert.equal(s.collections.transactions.t1.ilosc, 12);

  r = await zapisz(S.port, { op: 'delete', coll: 'couriers', id: 'dpd' });
  assert.equal(r.status, 200);
  s = await snapshot(S.port);
  assert.equal(s.collections.couriers, undefined);
  // usunięcie nieistniejącego dokumentu — bez błędu, bez zmiany rev
  const revPrzed = s.rev;
  r = await zapisz(S.port, { op: 'delete', coll: 'couriers', id: 'nie-ma' });
  assert.equal(r.status, 200); assert.equal(r.json.rev, revPrzed);
});

test('update nieistniejącego dokumentu → 404 {error:"not_found"}', async () => {
  const r = await zapisz(S.port, { op: 'update', coll: 'couriers', id: 'brak', data: { x: 1 } });
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'not_found');
  const s = await snapshot(S.port);
  assert.ok(!s.collections.couriers || !s.collections.couriers.brak);
});

test('walidacja zapisów', async () => {
  const zle = [
    { op: 'set', coll: 'zła kolekcja', id: 'a', data: {} },
    { op: 'set', coll: 'couriers', id: 'a/b', data: {} },
    { op: 'set', coll: 'couriers', id: '', data: {} },
    { op: 'set', coll: 'couriers', id: 'x'.repeat(201), data: {} },
    { op: 'set', coll: '../etc', id: 'a', data: {} },
    { op: 'merge', coll: 'couriers', id: 'a', data: {} },
    { op: 'set', coll: 'couriers', id: 'a', data: [1, 2] },
    { op: 'set', coll: 'couriers', id: 'a', data: 'tekst' },
    { op: 'update', coll: 'couriers', id: 'a' },
  ];
  for (const w of zle) {
    const r = await zapisz(S.port, w);
    assert.equal(r.status, 400, `oczekiwano 400 dla ${JSON.stringify(w).slice(0, 80)}`);
    assert.equal(r.json.error, 'invalid_argument');
  }
  // dozwolone znaki w identyfikatorach
  const ok = await zapisz(S.port, { op: 'set', coll: 'meta', id: 'A-z_0.9~:@+', data: { ok: true } });
  assert.equal(ok.status, 200);
  await zapisz(S.port, { op: 'delete', coll: 'meta', id: 'A-z_0.9~:@+' });
  // klucz "__proto__" nie psuje bazy
  const proto = await zapisz(S.port, { op: 'set', coll: 'meta', id: '__proto__', data: JSON.parse('{"__proto__":{"zly":1},"a":1}') });
  assert.equal(proto.status, 200);
  const s = await snapshot(S.port);
  assert.equal(s.collections.meta.__proto__ !== undefined, true);
  assert.equal(({}).zly, undefined);
  await zapisz(S.port, { op: 'delete', coll: 'meta', id: '__proto__' });

  // zły JSON, zły Content-Type, za duże ciało
  let r = await jsonPost(S.port, '/api/write', '{nie json');
  assert.equal(r.status, 400);
  r = await zadanie(S.port, { method: 'POST', path: '/api/write', body: JSON.stringify({ op: 'set', coll: 'a', id: 'b', data: {} }), headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 415, 'POST bez application/json musi być odrzucony (ochrona CSRF)');
  r = await jsonPost(S.port, '/api/write', { op: 'set', coll: 'a', id: 'b', data: { x: 'y'.repeat(1024 * 1024 + 10) } });
  assert.equal(r.status, 413);
  assert.equal(r.json.error, 'too_large');
  // metoda
  r = await zadanie(S.port, { path: '/api/write' });
  assert.equal(r.status, 405);
  r = await zadanie(S.port, { path: '/api/nieznane' });
  assert.equal(r.status, 404);
});

test('POST /api/batch — atomowo: wszystko albo nic', async () => {
  const przed = await snapshot(S.port);
  let r = await jsonPost(S.port, '/api/batch', { writes: [
    { op: 'set', coll: 'couriers', id: 'b1', data: { name: 'B1' } },
    { op: 'update', coll: 'couriers', id: 'nie-istnieje', data: { x: 1 } },
  ] });
  assert.equal(r.status, 404); assert.equal(r.json.error, 'not_found'); assert.equal(r.json.index, 1);
  let s = await snapshot(S.port);
  assert.equal(s.rev, przed.rev, 'nieudana paczka nie może zmienić rev');
  assert.ok(!s.collections.couriers || !s.collections.couriers.b1, 'nieudana paczka nie może nic zapisać');

  r = await jsonPost(S.port, '/api/batch', { writes: [
    { op: 'set', coll: 'couriers', id: 'b1', data: { name: 'B1', order: 1 } },
    { op: 'update', coll: 'couriers', id: 'b1', data: { order: 2 } },     // widzi poprzedni zapis z paczki
    { op: 'set', coll: 'couriers', id: 'b2', data: { name: 'B2' } },
    { op: 'delete', coll: 'couriers', id: 'b2' },
  ], clientId: 'kb' });
  assert.equal(r.status, 200);
  assert.equal(r.json.rev, przed.rev + 4);
  assert.deepEqual(r.json.results.map(x => x.rev), [przed.rev + 1, przed.rev + 2, przed.rev + 3, przed.rev + 4]);
  s = await snapshot(S.port);
  assert.deepEqual(s.collections.couriers.b1, { name: 'B1', order: 2 });
  assert.equal(s.collections.couriers.b2, undefined);

  r = await jsonPost(S.port, '/api/batch', { writes: [{ op: 'set', coll: 'zła kolekcja', id: 'x', data: {} }] });
  assert.equal(r.status, 400);
  r = await jsonPost(S.port, '/api/batch', { nie: 'tak' });
  assert.equal(r.status, 400);
  await jsonPost(S.port, '/api/batch', { writes: [{ op: 'delete', coll: 'couriers', id: 'b1' }] });
});

test('SSE: zmiana dociera do dwóch klientów (z clientId), hello i nagłówki', async () => {
  const a = await klientSse(S.port), b = await klientSse(S.port);
  try {
    assert.match(a.naglowki['content-type'], /text\/event-stream/);
    assert.match(a.naglowki['cache-control'], /no-cache/);
    assert.equal(a.naglowki['x-accel-buffering'], 'no');
    const helloA = await a.czekaj(z => z.event === 'hello');
    assert.equal(typeof helloA.data.rev, 'number');
    await b.czekaj(z => z.event === 'hello');

    const r = await zapisz(S.port, { op: 'set', coll: 'transactions', id: 'sse1', data: { ilosc: 3 }, clientId: 'klient-A' });
    const zA = await a.czekaj(z => z.event === 'change' && z.data.id === 'sse1');
    const zB = await b.czekaj(z => z.event === 'change' && z.data.id === 'sse1');
    for (const z of [zA, zB]) {
      assert.deepEqual(z.data, { rev: r.json.rev, coll: 'transactions', id: 'sse1', data: { ilosc: 3 }, clientId: 'klient-A' });
    }
    await zapisz(S.port, { op: 'delete', coll: 'transactions', id: 'sse1' });
    const del = await b.czekaj(z => z.event === 'change' && z.data.id === 'sse1' && z.data.data === null);
    assert.equal(del.data.clientId, null);
  } finally { a.zamknij(); b.zamknij(); }
});

test('SSE: heartbeat „ping” co EP_HEARTBEAT_MS', async () => {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  const s2 = await uruchomSerwer({ dataDir: d, env: { EP_HEARTBEAT_MS: '150' } });
  const k = await klientSse(s2.port);
  try { const p = await k.czekaj(z => z.event === 'ping', 3000); assert.equal(typeof p.data.rev, 'number'); }
  finally { k.zamknij(); await s2.zatrzymaj(); }
});

test('zasoby (loga): wgrywanie, serwowanie, lista, usuwanie, limity', async () => {
  let r = await zadanie(S.port, { method: 'POST', path: '/api/assets', body: PNG_1X1, headers: { 'Content-Type': 'image/png', 'Content-Length': PNG_1X1.length } });
  assert.equal(r.status, 200);
  const { id, url, sizeBytes, contentType } = r.json;
  assert.match(id, /^[a-z0-9]{20}$/);
  assert.equal(url, `/_blob/${id}`);
  assert.equal(sizeBytes, PNG_1X1.length);
  assert.equal(contentType, 'image/png');

  r = await zadanie(S.port, { path: url });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/png');
  assert.ok(r.buf.equals(PNG_1X1));
  assert.match(r.headers['content-security-policy'], /sandbox/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  const r304 = await zadanie(S.port, { path: url, headers: { 'If-None-Match': r.headers.etag } });
  assert.equal(r304.status, 304);

  const s = await snapshot(S.port);
  const wpis = s.assets.find(a => a.id === id);
  assert.equal(typeof wpis.createdAt, 'number');
  assert.deepEqual(wpis, { id, contentType: 'image/png', sizeBytes: PNG_1X1.length, createdAt: wpis.createdAt });
  r = await zadanie(S.port, { path: '/api/assets' });
  assert.equal(r.status, 200);
  assert.ok(r.json.assets.some(a => a.id === id && a.url === url));
  assert.ok(r.json.usage.bytes >= PNG_1X1.length);
  assert.ok(fs.existsSync(path.join(dir, 'zalaczniki', id)));

  // tylko obrazy, maks. 4 MB, niepuste
  r = await zadanie(S.port, { method: 'POST', path: '/api/assets', body: 'hello', headers: { 'Content-Type': 'text/html' } });
  assert.equal(r.status, 415);
  const duzy = Buffer.alloc(4 * 1024 * 1024 + 1, 1);
  r = await zadanie(S.port, { method: 'POST', path: '/api/assets', body: duzy, headers: { 'Content-Type': 'image/png', 'Content-Length': duzy.length } });
  assert.equal(r.status, 413);
  r = await zadanie(S.port, { method: 'POST', path: '/api/assets', body: Buffer.alloc(0), headers: { 'Content-Type': 'image/png', 'Content-Length': 0 } });
  assert.equal(r.status, 400);

  r = await zadanie(S.port, { method: 'DELETE', path: `/api/assets/${id}` });
  assert.equal(r.status, 200); assert.equal(r.json.existed, true);
  r = await zadanie(S.port, { path: url });
  assert.equal(r.status, 404);
  assert.ok(!fs.existsSync(path.join(dir, 'zalaczniki', id)));
  r = await zadanie(S.port, { method: 'DELETE', path: `/api/assets/${id}` });
  assert.equal(r.status, 200); assert.equal(r.json.existed, false);
  r = await zadanie(S.port, { path: '/_blob/..%2Fbaza.json' });
  assert.equal(r.status, 404);
});

test('GET /api/kopia — cała baza w formacie kopii aplikacji (do wczytania w „Wczytaj kopię z pliku”), loga jako data URL', async () => {
  const up = await zadanie(S.port, { method: 'POST', path: '/api/assets', body: PNG_1X1, headers: { 'Content-Type': 'image/png' } });
  await zapisz(S.port, { op: 'set', coll: 'couriers', id: 'kop', data: { name: 'Kopia', order: 9, logoAssetId: up.json.id } });
  await zapisz(S.port, { op: 'set', coll: 'transactions', id: 'tk1', data: { kurierId: 'kop', kurierNazwa: 'Kopia', typ: 'wydanie', ilosc: 2, data: '2026-10-01', uwagi: '', createdAt: 1, nr: 'WZ-00007' } });
  await zapisz(S.port, { op: 'set', coll: 'meta', id: 'counters', data: { wz: 7, pz: 0 } });
  await zapisz(S.port, { op: 'set', coll: 'meta', id: 'settings', data: { seeded: true } });
  const r = await zadanie(S.port, { path: '/api/kopia' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-disposition'], /^attachment; filename="ewidencja-palet-kopia-\d{4}-\d{2}-\d{2}\.json"$/);
  const k = r.json;
  // dokładnie to, czego wymaga parseBackup() aplikacji
  assert.equal(k.app, 'ewidencja-palet'); assert.equal(k.format, 1); assert.equal(k.source, 'server');
  assert.ok(Array.isArray(k.couriers) && Array.isArray(k.transactions));
  assert.deepEqual(k.couriers.find(c => c.id === 'kop'), { id: 'kop', name: 'Kopia', order: 9, logoAssetId: up.json.id });
  assert.deepEqual(k.transactions.find(t => t.id === 'tk1'), { id: 'tk1', kurierId: 'kop', kurierNazwa: 'Kopia', typ: 'wydanie', ilosc: 2, data: '2026-10-01', uwagi: '', createdAt: 1, nr: 'WZ-00007' });
  assert.deepEqual(k.meta, { counters: { wz: 7, pz: 0 } });
  assert.equal(k.logos[up.json.id], `data:image/png;base64,${PNG_1X1.toString('base64')}`);
  // dodatkowo (aplikacja to pomija): reszta bazy, żeby serwer mógł odtworzyć wszystko
  assert.deepEqual(k.pozostale.meta.settings, { seeded: true });
  assert.equal(typeof k.rev, 'number');
  for (const [c, id] of [['couriers', 'kop'], ['transactions', 'tk1'], ['meta', 'counters'], ['meta', 'settings']]) await zapisz(S.port, { op: 'delete', coll: c, id });
});

test('update scala zagnieżdżone obiekty rekurencyjnie (jak platforma), tablice zastępuje, __delete__ działa głęboko', async () => {
  await zapisz(S.port, { op: 'set', coll: 'meta', id: 'gl', data: { a: { b: 1, c: { d: 2, e: 3 }, lista: [1, 2] }, x: 1, usun: { __delete__: true }, z: { w: { __delete__: true }, q: 1 } } });
  let s = await snapshot(S.port);
  assert.deepEqual(s.collections.meta.gl, { a: { b: 1, c: { d: 2, e: 3 }, lista: [1, 2] }, x: 1, z: { q: 1 } }, 'set nie zapisuje znaczników __delete__');
  await zapisz(S.port, { op: 'update', coll: 'meta', id: 'gl', data: { a: { c: { d: 20, e: { __delete__: true } }, lista: [9], nowe: { k: { __delete__: true }, m: 1 } }, x: { y: 1 } } });
  s = await snapshot(S.port);
  assert.deepEqual(s.collections.meta.gl, { a: { b: 1, c: { d: 20 }, lista: [9], nowe: { m: 1 } }, x: { y: 1 }, z: { q: 1 } });
  await zapisz(S.port, { op: 'delete', coll: 'meta', id: 'gl' });
});

test('POST /api/acquire — dzierżawa: zajęta/wolna/odnowienie/wygaśnięcie, data scalane i ogłaszane przez SSE', async () => {
  const k = await klientSse(S.port);
  try {
    await k.czekaj(z => z.event === 'hello');
    const acq = (o) => jsonPost(S.port, '/api/acquire', { coll: 'meta', id: 'numeracja', ...o });
    let r = await acq({ holder: 'A', ttlMs: 1000 });
    assert.equal(r.status, 200);
    assert.equal(r.json.acquired, true); assert.equal(r.json.holder, 'A'); assert.equal(typeof r.json.version, 'number');
    assert.ok(Date.parse(r.json.expiresAt) > Date.now());
    r = await acq({ holder: 'B', ttlMs: 1000 });
    assert.deepEqual(Object.keys(r.json).sort(), ['acquired', 'expiresAt']);
    assert.equal(r.json.acquired, false, 'zajęta przez A');
    r = await acq({ holder: 'A', ttlMs: 1000 });
    assert.equal(r.json.acquired, true, 'ten sam posiadacz odnawia');
    // równoległe próby: dokładnie jedna wygrywa
    const wyniki = await Promise.all(['C1', 'C2', 'C3', 'C4'].map((h) => jsonPost(S.port, '/api/acquire', { coll: 'meta', id: 'rownolegle', holder: h, ttlMs: 5000 })));
    assert.equal(wyniki.filter(x => x.json.acquired).length, 1);
    // ttl przycinane do min. 1 s; po wygaśnięciu inny posiadacz dostaje dzierżawę
    await new Promise(res => setTimeout(res, 1100));
    r = await acq({ holder: 'B', ttlMs: 10, data: { przez: 'B', usun: { __delete__: true } } });
    assert.equal(r.json.acquired, true);
    assert.ok(Date.parse(r.json.expiresAt) - Date.now() > 500, 'ttlMs < 1000 przycięte do 1000');
    assert.deepEqual(r.json.change.data, { przez: 'B' });
    const z = await k.czekaj(e => e.event === 'change' && e.data.id === 'numeracja');
    assert.deepEqual(z.data.data, { przez: 'B' });
    assert.deepEqual((await snapshot(S.port)).collections.meta.numeracja, { przez: 'B' });
    // walidacja
    for (const zle of [{ holder: '' }, { holder: 5 }, { holder: 'x', data: [1] }, { holder: 'x', coll: 'zła nazwa' }]) {
      r = await jsonPost(S.port, '/api/acquire', { coll: 'meta', id: 'n', ...zle });
      assert.equal(r.status, 400, JSON.stringify(zle));
    }
    await zapisz(S.port, { op: 'delete', coll: 'meta', id: 'numeracja' });
  } finally { k.zamknij(); }
});

test('pliki statyczne: MIME, 304, brak dostępu do server.js, danych, plików z kropką, path traversal', async () => {
  let r = await zadanie(S.port, { path: '/' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.ok(r.text.includes('<script src="runtime-lokalny.js"></script>'));
  assert.ok(r.text.includes('<link rel="stylesheet" href="fonts/fonts.css">'));
  const r304 = await zadanie(S.port, { path: '/', headers: { 'If-None-Match': r.headers.etag } });
  assert.equal(r304.status, 304);
  r = await zadanie(S.port, { path: '/index.html', method: 'HEAD' });
  assert.equal(r.status, 200); assert.equal(r.buf.length, 0);

  r = await zadanie(S.port, { path: '/runtime-lokalny.js' });
  assert.equal(r.status, 200); assert.match(r.headers['content-type'], /^text\/javascript/);
  r = await zadanie(S.port, { path: '/fonts/fonts.css' });
  assert.equal(r.status, 200); assert.match(r.headers['content-type'], /^text\/css/);
  r = await zadanie(S.port, { path: '/fonts/space-grotesk-latin-ext-400-normal.woff2' });
  assert.equal(r.status, 200); assert.equal(r.headers['content-type'], 'font/woff2');
  r = await zadanie(S.port, { path: '/fonts/OFL-SpaceGrotesk.txt' });
  assert.equal(r.status, 200);
  r = await zadanie(S.port, { path: '/favicon.ico' });
  assert.ok(r.status === 200 || r.status === 204);

  // zapis, żeby baza.json na pewno istniała
  await zapisz(S.port, { op: 'set', coll: 'meta', id: 'x', data: { a: 1 } });
  const zablokowane = [
    '/server.js', '/../server.js', '/fonts/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/fonts/..%2f..%2fserver.js',
    '/fonts/..%5c..%5cserver.js', '/%2e%2e/%2e%2e/%2e%2e/etc/passwd', '/../../../../etc/passwd', '//etc/passwd',
    '/dane/baza.json', '/.gitignore', '/.git/config', '/%2egitignore', '/testy/dane-testowe.json', '/narzedzia/zbuduj.js',
    '/fonts', '/fonts/', '/index.html%00.js', '/Dockerfile', '/docker-compose.yml', '/uruchom.sh',
    '/package.json', '/INSTRUKCJA.md', '/zrodlo/aplikacja.html', '/.dockerignore', '/Uruchom%20serwer%20(Windows).bat',
    `/${encodeURIComponent(path.join(dir, 'baza.json'))}`, '/C:%5cWindows%5cwin.ini',
  ];
  for (const p of zablokowane) {
    r = await zadanie(S.port, { path: p });
    assert.ok([400, 404].includes(r.status), `${p} → ${r.status} (powinno być 404/400)`);
    assert.ok(!r.text.includes('stworzSerwer') && !r.text.includes('"collections"'), `${p} ujawnia treść!`);
  }
  r = await zadanie(S.port, { path: '/index.html', method: 'POST', body: 'x' });
  assert.equal(r.status, 405);
});

test('DATA_DIR wewnątrz folderu aplikacji też nie jest serwowany', async () => {
  // folder o „niewinnej” nazwie w katalogu głównym — chroni go tylko sprawdzenie DATA_DIR (realpath)
  const nazwa = `tmp-moje-dane-${process.pid}`;
  const wew = path.join(KATALOG, nazwa);
  sprzatanie.push(wew);
  const s2 = await uruchomSerwer({ dataDir: wew });
  try {
    await zapisz(s2.port, { op: 'set', coll: 'meta', id: 'x', data: { tajne: 1 } });
    assert.ok(fs.existsSync(path.join(wew, 'baza.json')));
    for (const p of [`/${nazwa}/baza.json`, `/${nazwa}/kopie/baza-${dzis}.json`, `/fonts/../${nazwa}/baza.json`]) {
      const r = await zadanie(s2.port, { path: p });
      assert.equal(r.status, 404, p);
    }
    // kontrola: plik tekstowy w INNYM folderze obok byłby serwowany (więc 404 wyżej to zasługa ochrony DATA_DIR)
    fs.mkdirSync(`${wew}-inny`); sprzatanie.push(`${wew}-inny`);
    fs.writeFileSync(path.join(`${wew}-inny`, 'kontrola.txt'), 'x');
    assert.equal((await zadanie(s2.port, { path: `/${nazwa}-inny/kontrola.txt` })).status, 200);
    fs.writeFileSync(path.join(wew, 'kontrola.txt'), 'x');
    assert.equal((await zadanie(s2.port, { path: `/${nazwa}/kontrola.txt` })).status, 404);
    // pliki *.json w folderze aplikacji (np. pobrane kopie zapasowe) nie są serwowane nigdy
    fs.writeFileSync(path.join(wew, '..', `${nazwa}.json`), '{}');
    sprzatanie.push(path.join(wew, '..', `${nazwa}.json`));
    assert.equal((await zadanie(s2.port, { path: `/${nazwa}.json` })).status, 404);
  } finally { await s2.zatrzymaj(); }
});

test('trwałość po restarcie (SIGTERM → kod 0), zapis atomowy, kopia dzienna', async () => {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  let s2 = await uruchomSerwer({ dataDir: d });
  await zapisz(s2.port, { op: 'set', coll: 'couriers', id: 'dpd', data: { name: 'DPD', order: 1 } });
  await zapisz(s2.port, { op: 'set', coll: 'transactions', id: 't1', data: { ilosc: 5, uwagi: 'ąę' } });
  await zapisz(s2.port, { op: 'update', coll: 'couriers', id: 'dpd', data: { enabled: false } });
  const up = await zadanie(s2.port, { method: 'POST', path: '/api/assets', body: PNG_1X1, headers: { 'Content-Type': 'image/png' } });
  const przed = await snapshot(s2.port);
  // brak plików tymczasowych po zapisie
  assert.deepEqual(fs.readdirSync(d).filter(f => f.includes('.tmp-')), []);
  JSON.parse(fs.readFileSync(path.join(d, 'baza.json'), 'utf8')); // poprawny JSON
  const wynik = await s2.zatrzymaj('SIGTERM');
  assert.equal(wynik.code, 0, `kod wyjścia ${JSON.stringify(wynik)}; stdout: ${s2.wyjscie()}`);
  assert.match(s2.wyjscie(), /Serwer zatrzymany/);

  s2 = await uruchomSerwer({ dataDir: d });
  try {
    const po = await snapshot(s2.port);
    assert.deepEqual(po.collections, przed.collections);
    assert.equal(po.rev, przed.rev);
    assert.deepEqual(po.assets, przed.assets);
    const blob = await zadanie(s2.port, { path: `/_blob/${up.json.id}` });
    assert.equal(blob.status, 200); assert.ok(blob.buf.equals(PNG_1X1));
    // kopia dzienna powstała przy starcie (baza już istniała) — w formacie kopii aplikacji, z logo
    const plikKopii = path.join(d, 'kopie', `baza-${dzis}.json`);
    assert.ok(fs.existsSync(plikKopii), 'brak kopii dziennej');
    const kopia = JSON.parse(fs.readFileSync(plikKopii, 'utf8'));
    assert.equal(kopia.app, 'ewidencja-palet'); assert.equal(kopia.format, 1);
    // stan z dysku sprzed drugiego zapisu tego dnia (pierwszy zapis dopiero utworzył baza.json)
    assert.deepEqual(kopia.couriers, [{ id: 'dpd', name: 'DPD', order: 1 }]);
    assert.deepEqual(kopia.transactions, []);
    assert.deepEqual(kopia.meta, { counters: {} });
    assert.equal(kopia.rev, 1);
    // kolejny zapis działa po restarcie i podbija rev
    const r = await zapisz(s2.port, { op: 'set', coll: 'meta', id: 'po', data: { a: 1 } });
    assert.equal(r.json.rev, przed.rev + 1);
  } finally { await s2.zatrzymaj(); }
});

test('uszkodzony baza.json → odłożony jako baza.uszkodzona-*.json, dane z najnowszej kopii', async () => {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  fs.mkdirSync(path.join(d, 'kopie'), { recursive: true });
  const stara = { format: 'ewidencja-palet', wersja: 1, rev: 3, collections: { couriers: { dpd: { name: 'Stara' } } }, assets: {} };
  const nowa = { format: 'ewidencja-palet', wersja: 1, rev: 7, collections: { couriers: { dpd: { name: 'Nowa' } }, transactions: { t1: { ilosc: 2 } } }, assets: {} };
  fs.writeFileSync(path.join(d, 'kopie', 'baza-2026-09-01.json'), JSON.stringify(stara));
  fs.writeFileSync(path.join(d, 'kopie', 'baza-2026-09-02.json'), JSON.stringify(nowa));
  fs.writeFileSync(path.join(d, 'kopie', 'baza-2026-09-03.json'), '{"uszkodzona kopia');
  fs.writeFileSync(path.join(d, 'baza.json'), '{"format":"ewidencja-palet","collections":{"couriers":{"dpd":{"name":"Uci');
  const s2 = await uruchomSerwer({ dataDir: d });
  try {
    assert.match(s2.bledy(), /USZKODZONY/);
    assert.match(s2.bledy(), /PRZYWRÓCONO dane z kopii: .*baza-2026-09-02\.json/);
    const odlozone = fs.readdirSync(d).filter(f => /^baza\.uszkodzona-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/.test(f));
    assert.equal(odlozone.length, 1);
    assert.match(fs.readFileSync(path.join(d, odlozone[0]), 'utf8'), /"name":"Uci$/);
    const s = await snapshot(s2.port);
    assert.deepEqual(s.collections, nowa.collections);
    assert.equal(s.rev, 7);
    JSON.parse(fs.readFileSync(path.join(d, 'baza.json'), 'utf8'));
  } finally { await s2.zatrzymaj(); }

  // pusty plik (np. po awarii zasilania) bez żadnych kopii → start z pustą bazą, głośny komunikat
  const d2 = tymczasowyKatalog(); sprzatanie.push(d2);
  fs.writeFileSync(path.join(d2, 'baza.json'), '');
  const s3 = await uruchomSerwer({ dataDir: d2 });
  try {
    assert.match(s3.bledy(), /USZKODZONY/);
    assert.match(s3.bledy(), /PUSTĄ bazą/);
    assert.deepEqual((await snapshot(s3.port)).collections, {});
  } finally { await s3.zatrzymaj(); }
});

test('odtworzenie z kopii dziennej w formacie aplikacji: dane, liczniki, inne dokumenty i brakujące pliki logo', async () => {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  fs.mkdirSync(path.join(d, 'kopie'), { recursive: true });
  const logo = `data:image/png;base64,${PNG_1X1.toString('base64')}`;
  const kopia = {
    app: 'ewidencja-palet', format: 1, exportedAt: '2026-10-02T06:00:00.000Z', source: 'server', rev: 12,
    couriers: [{ id: 'dpd', name: 'DPD', order: 1, logoAssetId: 'logo1' }],
    transactions: [{ id: 't1', kurierId: 'dpd', kurierNazwa: 'DPD', typ: 'wydanie', ilosc: 4, data: '2026-10-01', uwagi: '', createdAt: 5, nr: 'WZ-00001' }],
    meta: { counters: { wz: 1, pz: 0 } }, logos: { logo1: logo }, pozostale: { meta: { settings: { seeded: true } } },
  };
  fs.writeFileSync(path.join(d, 'kopie', 'baza-2026-10-02.json'), JSON.stringify(kopia));
  fs.writeFileSync(path.join(d, 'baza.json'), '{"rev": 1, "collections": {"cour');
  const s2 = await uruchomSerwer({ dataDir: d });
  try {
    assert.match(s2.bledy(), /PRZYWRÓCONO dane z kopii: .*baza-2026-10-02\.json/);
    const s = await snapshot(s2.port);
    assert.equal(s.rev, 12);
    assert.deepEqual(s.collections, {
      couriers: { dpd: { name: 'DPD', order: 1, logoAssetId: 'logo1' } },
      transactions: { t1: { kurierId: 'dpd', kurierNazwa: 'DPD', typ: 'wydanie', ilosc: 4, data: '2026-10-01', uwagi: '', createdAt: 5, nr: 'WZ-00001' } },
      meta: { counters: { wz: 1, pz: 0 }, settings: { seeded: true } },
    });
    const blob = await zadanie(s2.port, { path: '/_blob/logo1' });
    assert.equal(blob.status, 200, 'logo odtworzone z kopii');
    assert.ok(blob.buf.equals(PNG_1X1));
    assert.equal(blob.headers['content-type'], 'image/png');
  } finally { await s2.zatrzymaj(); }
});

test('kopie dzienne: zostaje 30 najnowszych', async () => {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  fs.mkdirSync(path.join(d, 'kopie'), { recursive: true });
  const baza = { format: 'ewidencja-palet', wersja: 1, rev: 1, collections: { meta: { a: { x: 1 } } }, assets: {} };
  fs.writeFileSync(path.join(d, 'baza.json'), JSON.stringify(baza));
  for (let i = 0; i < 35; i++) {
    const dt = new Date(2025, 0, 1 + i); const p = (n) => String(n).padStart(2, '0');
    fs.writeFileSync(path.join(d, 'kopie', `baza-${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}.json`), JSON.stringify(baza));
  }
  const s2 = await uruchomSerwer({ dataDir: d });
  try {
    const kopie = fs.readdirSync(path.join(d, 'kopie')).filter(f => /^baza-.*\.json$/.test(f)).sort();
    assert.equal(kopie.length, 30);
    assert.ok(kopie.includes(`baza-${dzis}.json`));
    assert.ok(!kopie.includes('baza-2025-01-01.json'));
  } finally { await s2.zatrzymaj(); }
});

test('EP_HASLO: HTTP Basic dla wszystkiego (dowolna nazwa użytkownika)', async () => {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  const s2 = await uruchomSerwer({ dataDir: d, env: { EP_HASLO: 'tajne hasło ąę' } });
  const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`, 'utf8').toString('base64')}`;
  try {
    for (const p of ['/', '/api/ping', '/api/snapshot', '/runtime-lokalny.js', '/fonts/fonts.css', '/api/kopia', '/_blob/abc']) {
      const r = await zadanie(s2.port, { path: p });
      assert.equal(r.status, 401, `${p} bez hasła`);
      assert.match(r.headers['www-authenticate'], /^Basic realm="Ewidencja Palet"/);
    }
    let r = await zadanie(s2.port, { path: '/api/ping', headers: { Authorization: basic('ktokolwiek', 'złe') } });
    assert.equal(r.status, 401);
    r = await zadanie(s2.port, { path: '/api/ping', headers: { Authorization: 'Bearer abc' } });
    assert.equal(r.status, 401);
    r = await zadanie(s2.port, { path: '/api/ping', headers: { Authorization: basic('ktokolwiek', 'tajne hasło ąę') } });
    assert.equal(r.status, 200);
    r = await zadanie(s2.port, { path: '/', headers: { Authorization: basic('', 'tajne hasło ąę') } });
    assert.equal(r.status, 200);
    r = await jsonPost(s2.port, '/api/write', { op: 'set', coll: 'a', id: 'b', data: {} });
    assert.equal(r.status, 401);
    r = await jsonPost(s2.port, '/api/write', { op: 'set', coll: 'a', id: 'b', data: {} }, { Authorization: basic('x', 'tajne hasło ąę') });
    assert.equal(r.status, 200);
    await assert.rejects(klientSse(s2.port), (e) => e.status === 401);
    const k = await klientSse(s2.port, { Authorization: basic('x', 'tajne hasło ąę') });
    await k.czekaj(z => z.event === 'hello'); k.zamknij();
  } finally { await s2.zatrzymaj(); }
});

test('równoległe zapisy: każdy jest na dysku zanim przyjdzie odpowiedź (group commit)', async () => {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  const s2 = await uruchomSerwer({ dataDir: d });
  try {
    const N = 60;
    const rev0 = (await snapshot(s2.port)).rev;
    const wyniki = await Promise.all(Array.from({ length: N }, (_, i) => (async () => {
      const r = await zapisz(s2.port, { op: 'set', coll: 'transactions', id: `r${i}`, data: { ilosc: i + 1 } });
      assert.equal(r.status, 200);
      // w chwili odpowiedzi zmiana MUSI już być w pliku
      const naDysku = JSON.parse(fs.readFileSync(path.join(d, 'baza.json'), 'utf8'));
      assert.deepEqual(naDysku.collections.transactions[`r${i}`], { ilosc: i + 1 }, `r${i} nie było na dysku w chwili odpowiedzi`);
      return r.json.rev;
    })()));
    assert.equal(new Set(wyniki).size, N, 'każdy zapis ma własny rev');
    const s = await snapshot(s2.port);
    assert.equal(s.rev, rev0 + N);
    assert.equal(Object.keys(s.collections.transactions).length, N);
    // aktualizacje tego samego dokumentu po kolei
    for (let i = 0; i < 5; i++) await zapisz(s2.port, { op: 'update', coll: 'transactions', id: 'r0', data: { ilosc: 100 + i } });
    assert.equal((await snapshot(s2.port)).collections.transactions.r0.ilosc, 104);
  } finally { await s2.zatrzymaj(); }
});

test('błąd zapisu na dysk → 500, stan wycofany, brak zdarzenia SSE; potem zapis znów działa', async () => {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  const s2 = await uruchomSerwer({ dataDir: d });
  const k = await klientSse(s2.port);
  try {
    await k.czekaj(z => z.event === 'hello');
    const ok = await zapisz(s2.port, { op: 'set', coll: 'meta', id: 'a', data: { v: 1 } });
    assert.equal(ok.status, 200);
    // zamieniamy baza.json w katalog — rename() pliku tymczasowego się nie uda
    fs.rmSync(path.join(d, 'baza.json')); fs.mkdirSync(path.join(d, 'baza.json'));
    const [r1, r2] = await Promise.all([
      zapisz(s2.port, { op: 'set', coll: 'meta', id: 'b', data: { v: 2 } }),
      zapisz(s2.port, { op: 'update', coll: 'meta', id: 'a', data: { v: 3 } }),
    ]);
    for (const r of [r1, r2]) { assert.equal(r.status, 500); assert.equal(r.json.error, 'storage_failed'); }
    assert.match(s2.bledy(), /BŁĄD ZAPISU BAZY/);
    let s = await snapshot(s2.port);
    assert.deepEqual(s.collections.meta, { a: { v: 1 } }, 'nieudane zapisy nie mogą zostać w pamięci');
    // numer zmian nie cofa się (klient mógł pobrać migawkę z wycofanymi zmianami) — wycofanie to nowy numer,
    // a klienci dostają „reset” i wczytują stan od nowa
    assert.ok(s.rev > ok.json.rev + 2, `rev po wycofaniu ${s.rev} musi być wyższy niż numery wycofanych zmian`);
    const reset = await k.czekaj(z => z.event === 'reset');
    assert.equal(reset.data.rev, s.rev);
    assert.equal((await zadanie(s2.port, { path: '/api/rev' })).json.rev, s.rev, '/api/rev po wycofaniu');
    fs.rmdirSync(path.join(d, 'baza.json'));
    const r3 = await zapisz(s2.port, { op: 'set', coll: 'meta', id: 'c', data: { v: 4 } });
    assert.equal(r3.status, 200); assert.equal(r3.json.rev, s.rev + 1);
    s = await snapshot(s2.port);
    assert.deepEqual(s.collections.meta, { a: { v: 1 }, c: { v: 4 } });
    await k.czekaj(z => z.event === 'change' && z.data.id === 'c');
    assert.ok(!k.zdarzenia.some(z => z.event === 'change' && (z.data.id === 'b' || (z.data.id === 'a' && z.data.data.v === 3))), 'SSE nie może ogłaszać niezapisanych zmian');
  } finally { k.zamknij(); await s2.zatrzymaj(); }
});

const jestRoot = typeof process.getuid === 'function' && process.getuid() === 0;
test('EP_UZYTKOWNIK (Docker/Synology): root nadaje folderowi danych właściciela i przechodzi na zwykłego użytkownika', { skip: !jestRoot && 'wymaga uruchomienia testów jako root' }, async () => {
  const uidProcesu = (pid) => Number(/^Uid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]);
  // auto + folder należący do roota (tak go tworzy Docker) → użytkownik "node" (1000)
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  fs.mkdirSync(path.join(d, 'kopie')); fs.writeFileSync(path.join(d, 'kopie', 'stary.txt'), 'x');
  let s2 = await uruchomSerwer({ dataDir: d, env: { EP_UZYTKOWNIK: 'auto' } });
  try {
    assert.equal(uidProcesu(s2.proc.pid), 1000);
    assert.equal(fs.statSync(d).uid, 1000);
    assert.equal(fs.statSync(path.join(d, 'kopie', 'stary.txt')).uid, 1000);
    const r = await zapisz(s2.port, { op: 'set', coll: 'meta', id: 'x', data: { a: 1 } });
    assert.equal(r.status, 200);
    assert.equal(fs.statSync(path.join(d, 'baza.json')).uid, 1000);
    assert.equal((await zadanie(s2.port, { path: '/' })).status, 200, 'pliki aplikacji muszą być czytelne po zmianie użytkownika');
  } finally { await s2.zatrzymaj(); }
  // auto + folder należący do użytkownika DSM (np. 1026:100) → działa jako ten użytkownik
  const d2 = tymczasowyKatalog(); sprzatanie.push(d2);
  fs.chownSync(d2, 1026, 100);
  s2 = await uruchomSerwer({ dataDir: d2, env: { EP_UZYTKOWNIK: 'auto' } });
  try {
    assert.equal(uidProcesu(s2.proc.pid), 1026);
    await zapisz(s2.port, { op: 'set', coll: 'meta', id: 'x', data: { a: 1 } });
    assert.equal(fs.statSync(path.join(d2, 'baza.json')).uid, 1026);
    assert.match(s2.wyjscie(), /uid=1026, gid=100/);
  } finally { await s2.zatrzymaj(); }
  // jawne UID:GID; błędna wartość → czytelny błąd
  const d3 = tymczasowyKatalog(); sprzatanie.push(d3);
  s2 = await uruchomSerwer({ dataDir: d3, env: { EP_UZYTKOWNIK: '1234:1234' } });
  try { assert.equal(uidProcesu(s2.proc.pid), 1234); assert.equal(fs.statSync(d3).gid, 1234); } finally { await s2.zatrzymaj(); }
  await assert.rejects(uruchomSerwer({ dataDir: d3, env: { EP_UZYTKOWNIK: 'janek' } }), /EP_UZYTKOWNIK/);
});

test('kontrola zdrowia (Docker HEALTHCHECK): 0 gdy serwer odpowiada (także z hasłem), 1 gdy nie', async () => {
  const { spawnSync } = require('child_process');
  const zdrowie = (env) => spawnSync(process.execPath, [path.join(KATALOG, 'narzedzia', 'kontrola-zdrowia.js')], { env: { ...process.env, EP_HASLO: '', ...env }, timeout: 10000 }).status;
  assert.equal(zdrowie({ PORT: String(S.port) }), 0);
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  const s2 = await uruchomSerwer({ dataDir: d, env: { EP_HASLO: 'h4slo' } });
  try {
    assert.equal(zdrowie({ PORT: String(s2.port), EP_HASLO: 'h4slo' }), 0);
    assert.equal(zdrowie({ PORT: String(s2.port), EP_HASLO: 'zle' }), 1);
  } finally { await s2.zatrzymaj(); }
  assert.equal(zdrowie({ PORT: String(s2.port) }), 1, 'serwer zatrzymany');
});

test('HOST=0.0.0.0 wypisuje adresy w sieci lokalnej; --otworz otwiera przeglądarkę (xdg-open/open/start)', { skip: process.platform === 'win32' && 'test dla Linuksa/macOS' }, async () => {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  const bin = tymczasowyKatalog('ep-bin-'); sprzatanie.push(bin);
  const znacznik = path.join(bin, 'otwarto.txt');
  for (const nazwa of ['xdg-open', 'open']) {
    fs.writeFileSync(path.join(bin, nazwa), `#!/bin/sh\necho "$1" > "${znacznik}"\n`, { mode: 0o755 });
  }
  const { spawn } = require('child_process');
  const { wolnyPort } = require('./pomocnicy-serwera');
  const port = await wolnyPort();
  const proc = spawn(process.execPath, [path.join(KATALOG, 'server.js'), '--otworz'], { env: { ...process.env, PORT: String(port), HOST: '0.0.0.0', DATA_DIR: d, PATH: `${bin}:${process.env.PATH}`, EP_HASLO: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout.on('data', (c) => { out += c; });
  try {
    const koniec = Date.now() + 10000;
    while (!fs.existsSync(znacznik) && Date.now() < koniec) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(znacznik), `przeglądarka nie została otwarta; wyjście:\n${out}`);
    assert.equal(fs.readFileSync(znacznik, 'utf8').trim(), `http://localhost:${port}`);
    assert.match(out, new RegExp(`Na tym komputerze:\\s+http://localhost:${port}`));
    assert.match(out, /W sieci lokalnej:\s+(http:\/\/\d+\.\d+\.\d+\.\d+:\d+|\(nie wykryto połączenia sieciowego\))/);
    assert.match(out, /Dane zapisywane w:/);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => proc.on('exit', r));
  }
});

test('zajęty port → czytelny błąd i kod wyjścia 1', async () => {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  const net = require('net');
  const blokada = net.createServer().listen(0, '127.0.0.1');
  await new Promise(r => blokada.once('listening', r));
  const port = blokada.address().port;
  try {
    await assert.rejects(uruchomSerwer({ dataDir: d, port }), /port \d+ jest zajęty/);
  } finally { blokada.close(); }
});

/* ======================================================================
   Poprawki po QA wersji lokalnej
   ====================================================================== */
const { stworzSerwer, konfiguracja, dozwolonyHost, tekstStartowy } = require('../server.js');
const spij = (ms) => new Promise((r) => setTimeout(r, ms));
const basic = (haslo, user = 'u') => ({ Authorization: `Basic ${Buffer.from(`${user}:${haslo}`, 'utf8').toString('base64')}` });

/** Serwer w tym samym procesie (testy podstawiają np. wolny dysk: baza.zapiszPlik). */
async function serwerWProcesie(env = {}) {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  const s = stworzSerwer(konfiguracja({ HOST: '127.0.0.1', PORT: '0', DATA_DIR: d, ...env }, []), { warn: () => {}, error: () => {} });
  s.start();
  await new Promise((r) => s.serwer.listen(0, '127.0.0.1', r));
  return {
    ...s, dir: d, port: s.serwer.address().port,
    async zamknij() { s.zatrzymaj(); if (s.serwer.closeAllConnections) s.serwer.closeAllConnections(); await new Promise((r) => s.serwer.close(r)); },
  };
}

test('GET /api/rev, „hello” i „ping” podają numer ostatniej zmiany zapisanej i rozesłanej', async () => {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  const s2 = await uruchomSerwer({ dataDir: d, env: { EP_HEARTBEAT_MS: '150' } });
  let k = null;
  try {
    let r = await zadanie(s2.port, { path: '/api/rev' });
    assert.equal(r.status, 200);
    assert.equal(r.json.rev, 0);
    assert.match(r.json.serverId, /^[a-z0-9]{12}$/);
    const w = await zapisz(s2.port, { op: 'set', coll: 'meta', id: 'counters', data: { wz: 1 } });
    r = await zadanie(s2.port, { path: '/api/rev' });
    assert.equal(r.json.rev, w.json.rev);
    k = await klientSse(s2.port);
    const h = await k.czekaj((z) => z.event === 'hello');
    assert.deepEqual(h.data, { rev: w.json.rev, serverId: r.json.serverId });
    const p = await k.czekaj((z) => z.event === 'ping');
    assert.equal(p.data.rev, w.json.rev);
    assert.equal((await snapshot(s2.port)).serverId, r.json.serverId);
    assert.equal((await zadanie(s2.port, { path: '/api/rev', method: 'POST' })).status, 405);
  } finally { if (k) k.zamknij(); await s2.zatrzymaj(); }
});

test('SSE: paczka (batch) idzie jednym zdarzeniem „changes” (przeglądarka stosuje ją naraz), pojedynczy zapis — „change”', async () => {
  const k = await klientSse(S.port);
  try {
    await k.czekaj((z) => z.event === 'hello');
    const r = await jsonPost(S.port, '/api/batch', { writes: [
      { op: 'set', coll: 'qa', id: 'p1', data: { a: 1 } }, { op: 'set', coll: 'qa', id: 'p2', data: { a: 2 } }, { op: 'delete', coll: 'qa', id: 'nie-ma' },
    ], clientId: 'kp' });
    const z = await k.czekaj((e) => e.event === 'changes');
    assert.deepEqual(z.data, { clientId: 'kp', changes: r.json.results.map(({ rev, coll, id, data }) => ({ rev, coll, id, data })) });
    assert.ok(!k.zdarzenia.some((e) => e.event === 'change' && e.data.coll === 'qa'));
    await jsonPost(S.port, '/api/batch', { writes: [{ op: 'delete', coll: 'qa', id: 'p1' }] });
    const jeden = await k.czekaj((e) => e.event === 'change' && e.data.id === 'p1');
    assert.equal(jeden.data.data, null);
    await jsonPost(S.port, '/api/write', { op: 'delete', coll: 'qa', id: 'p2' });
  } finally { k.zamknij(); }
});

test('acquire: nowy posiadacz dostaje dzierżawę dopiero, gdy zapisy poprzedniego są na dysku i rozesłane (wolny dysk)', async () => {
  const s = await serwerWProcesie();
  const oryg = s.baza.zapiszPlik.bind(s.baza);
  s.baza.zapiszPlik = async (t) => { await spij(1500); return oryg(t); }; // np. dysk NAS-a wybudzany ze snu
  const k = await klientSse(s.port);
  try {
    await k.czekaj((z) => z.event === 'hello');
    const acq = (holder) => jsonPost(s.port, '/api/acquire', { coll: 'meta', id: 'numeracja', holder, ttlMs: 1000 });
    let r = await acq('A');
    assert.equal(r.json.acquired, true);
    assert.equal(r.json.serverId, (await zadanie(s.port, { path: '/api/rev' })).json.serverId);
    // A zapisuje licznik; zapis na dysk trwa dłużej niż dzierżawa
    const zapisA = jsonPost(s.port, '/api/write', { op: 'set', coll: 'meta', id: 'counters', data: { wz: 7 } });
    await spij(1100); // dzierżawa A wygasła, zapis A jeszcze trwa
    const pB = acq('B');
    await spij(100);
    const rC = await acq('C');
    assert.equal(rC.json.acquired, false, 'w trakcie przekazywania dzierżawy B nikt inny jej nie dostaje');
    const [rB, wA] = await Promise.all([pB, zapisA]);
    assert.equal(wA.status, 200);
    assert.equal(rB.json.acquired, true);
    assert.ok(rB.json.rev >= wA.json.rev, `rev w odpowiedzi dla B (${rB.json.rev}) musi obejmować zapis A (${wA.json.rev})`);
    assert.ok(s.revRozeslany() >= wA.json.rev);
    assert.ok(Date.parse(rB.json.expiresAt) - Date.now() > 600, 'czas dzierżawy B liczy się od jej przyznania');
    const zd = await k.czekaj((z) => z.event === 'change' && z.data.id === 'counters');
    assert.deepEqual(zd.data.data, { wz: 7 });
    // odnowienie przez tego samego posiadacza nie czeka na dysk
    const t0 = Date.now();
    const odn = jsonPost(s.port, '/api/write', { op: 'set', coll: 'meta', id: 'inny', data: { x: 1 } });
    await spij(50);
    r = await acq('B');
    assert.equal(r.json.acquired, true);
    assert.ok(Date.now() - t0 < 1000, 'odnowienie bez czekania na zapisy');
    await odn;
  } finally { k.zamknij(); await s.zamknij(); }
});

test('nagłówek Host: localhost, adresy IP, nazwy lokalne i EP_HOSTY — tak; obca domena (DNS rebinding) — 403', async () => {
  const dobre = ['localhost', 'localhost:8080', '127.0.0.1:8080', '192.168.1.20', '[::1]:8080', '[fe80::1]', 'nas', 'DiskStation:5000',
    'nas.local', 'NAS.Local.', 'serwer.lan:8080', 'nas.home.arpa', 'app.localhost', 'nas.internal',
    'nas.home', 'diskstation.localdomain', 'nas.fritz.box:5000', 'serwer.corp'];
  const zle = ['rebind.attacker.example', 'rebind.attacker.example:8080', 'evil.com', '127.0.0.1.nip.io', 'localhost.evil.com', '', ' ',
    'a b', 'nas.local@evil.com', '[::1', 'xn--80ak6aa92e.com', 'evil.box', 'nas.home.evil.com', 'fritz.box.evil.com'];
  for (const h of dobre) assert.ok(dozwolonyHost(h, []), `powinno być dozwolone: ${h}`);
  for (const h of zle) assert.ok(!dozwolonyHost(h, []), `powinno być odrzucone: ${JSON.stringify(h)}`);
  assert.ok(dozwolonyHost(undefined, []), 'HTTP/1.0 bez nagłówka Host');
  const hosty = konfiguracja({ EP_HOSTY: ' Palety.Example.pl:443 , *.moj-nas.pl,https://inna.example.pl/ ' }, []).hosty;
  assert.deepEqual(hosty, ['palety.example.pl', '*.moj-nas.pl', 'inna.example.pl']);
  assert.ok(dozwolonyHost('PALETY.example.pl:8443', hosty));
  assert.ok(dozwolonyHost('nas.moj-nas.pl', hosty));
  assert.ok(!dozwolonyHost('moj-nas.pl.evil.com', hosty));
  assert.ok(dozwolonyHost('cokolwiek.example', ['*']), 'EP_HOSTY=* wyłącza kontrolę');

  const d = tymczasowyKatalog(); sprzatanie.push(d);
  const s2 = await uruchomSerwer({ dataDir: d, env: { EP_HOSTY: 'palety.example.pl,*.moj-nas.pl' } });
  try {
    for (const [host, oczek] of [['rebind.attacker.example:8080', 403], ['palety.example.pl', 200], ['nas.moj-nas.pl:443', 200], ['nas', 200], ['nas.local:8080', 200]]) {
      for (const p of ['/', '/api/kopia', '/api/ping', '/api/snapshot']) {
        const r = await zadanie(s2.port, { path: p, headers: { Host: host } });
        assert.equal(r.status, oczek, `Host: ${host} ${p}`);
        if (oczek === 403) { assert.match(r.text, /EP_HOSTY/); assert.ok(!r.text.includes('"collections"')); }
      }
    }
    const w = await jsonPost(s2.port, '/api/write', { op: 'set', coll: 'x', id: 'y', data: {} }, { Host: 'rebind.attacker.example' });
    assert.equal(w.status, 403);
    assert.deepEqual((await snapshot(s2.port)).collections, {}, 'zapis spod obcej nazwy nie przeszedł');
    assert.match(s2.bledy(), /Odrzucono żądanie z nieznaną nazwą serwera \(Host: rebind\.attacker\.example:8080\)/);
  } finally { await s2.zatrzymaj(); }
});

test('X-Frame-Options: DENY i CSP frame-ancestors \'none\' — aplikacji nie da się osadzić w ramce', async () => {
  for (const p of ['/', '/index.html', '/api/ping', '/runtime-lokalny.js', '/nie-ma']) {
    const r = await zadanie(S.port, { path: p });
    assert.equal(r.headers['x-frame-options'], 'DENY', p);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/, p);
  }
  const up = await zadanie(S.port, { method: 'POST', path: '/api/assets', body: PNG_1X1, headers: { 'Content-Type': 'image/png', 'Content-Length': PNG_1X1.length } });
  const b = await zadanie(S.port, { path: up.json.url });
  assert.equal(b.status, 200);
  assert.match(b.headers['content-security-policy'], /sandbox/);
  assert.match(b.headers['content-security-policy'], /frame-ancestors 'none'/);
  await zadanie(S.port, { method: 'DELETE', path: `/api/assets/${up.json.id}` });
});

test('EP_HASLO: po 5 błędnych hasłach z jednego adresu kolejne próby są wstrzymywane (429), coraz dłużej', async () => {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  const s2 = await uruchomSerwer({ dataDir: d, env: { EP_HASLO: 'tajne', EP_BLOKADA_HASLA_MS: '800' } });
  const st = async (h) => (await zadanie(s2.port, { path: '/', headers: h || {} }));
  try {
    for (let i = 0; i < 8; i++) assert.equal((await st()).status, 401, 'pierwsze wejście bez hasła się nie liczy');
    for (let i = 0; i < 4; i++) assert.equal((await st(basic('zle'))).status, 401);
    assert.equal((await st(basic('tajne'))).status, 200, 'poprawne hasło kasuje licznik');
    for (let i = 0; i < 5; i++) assert.equal((await st(basic(`zle${i}`))).status, 401);
    let r = await st(basic('tajne'));
    assert.equal(r.status, 429, 'w czasie blokady hasło nie jest nawet sprawdzane');
    assert.ok(Number(r.headers['retry-after']) >= 1);
    assert.equal(r.headers['www-authenticate'], undefined);
    assert.match(r.text, /Za dużo błędnych haseł.*spróbuj ponownie za \d+ s/);
    assert.doesNotMatch(r.text, /z tego urządzenia/, 'za proxy blokada dotyczy wszystkich — tekst neutralny');
    assert.equal((await st()).status, 401, 'bez hasła: zwykłe pytanie o hasło');
    await spij(900);
    assert.equal((await st(basic('zle'))).status, 401); // szósta pomyłka → blokada 1,6 s
    assert.equal((await st(basic('tajne'))).status, 429);
    await spij(1000);
    assert.equal((await st(basic('tajne'))).status, 429, 'druga blokada dwa razy dłuższa');
    await spij(800);
    assert.equal((await st(basic('tajne'))).status, 200);
    assert.equal((await st(basic('zle'))).status, 401, 'po poprawnym haśle licznik od zera');
    assert.match(s2.bledy(), /błędnych haseł z adresu/);
  } finally { await s2.zatrzymaj(); }
});

test('EP_HASLO: ciasteczko sesji po zalogowaniu omija blokadę; to samo złe hasło liczy się raz', async () => {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  const s2 = await uruchomSerwer({ dataDir: d, env: { EP_HASLO: 'tajne', EP_BLOKADA_HASLA_MS: '60000' } });
  const st = async (h) => (await zadanie(s2.port, { path: '/api/ping', headers: h || {} }));
  try {
    assert.equal((await st(basic('tajne'))).headers['set-cookie'], undefined, 'kontrola zdrowia (bez User-Agent) nie zakłada sesji');
    const ok = await zadanie(s2.port, { path: '/', headers: { ...basic('tajne'), 'User-Agent': 'Mozilla/5.0' } });
    assert.equal(ok.status, 200);
    const ck = String(ok.headers['set-cookie'] || '');
    assert.match(ck, /^ep_sesja=[A-Za-z0-9_-]{20,64}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict$/);
    const ciastko = { Cookie: ck.split(';')[0] };
    // przeglądarka z zapamiętanym starym hasłem (np. po zmianie hasła) ponawia je w kółko — to jedna pomyłka
    for (let i = 0; i < 20; i++) assert.equal((await st(basic('stare'))).status, 401);
    assert.equal((await st(basic('tajne'))).status, 200, 'powtarzane to samo złe hasło nie blokuje logowania');
    for (let i = 0; i < 5; i++) assert.equal((await st(basic(`zgaduje${i}`))).status, 401);
    assert.equal((await st(basic('tajne'))).status, 429, 'pięć różnych złych haseł → blokada');
    const zal = await zadanie(s2.port, { path: '/api/ping', headers: { ...ciastko, ...basic('cokolwiek') } });
    assert.equal(zal.status, 200, 'zalogowane urządzenie działa w czasie blokady');
    assert.equal(zal.headers['set-cookie'], undefined, 'ważna sesja — bez nowego ciasteczka');
    assert.equal((await zadanie(s2.port, { path: '/api/ping', headers: { Cookie: 'ep_sesja=zmyslonytokenzmyslonytoken12' } })).status, 401, 'nieznany token nie wpuszcza');
  } finally { await s2.zatrzymaj(); }
  // nowy start serwera (np. ze zmienionym hasłem) unieważnia sesje
  const s3 = await uruchomSerwer({ dataDir: d, env: { EP_HASLO: 'nowe' } });
  try {
    const r = await zadanie(s3.port, { path: '/api/ping', headers: basic('tajne') });
    assert.equal(r.status, 401);
  } finally { await s3.zatrzymaj(); }
});

test('EP_ZAUFANE_PROXY: błędne hasła liczone osobno dla klientów z X-Forwarded-For (bez tej zmiennej nagłówek się nie liczy)', async () => {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  const st = async (port, xff, h) => (await zadanie(port, { path: '/', headers: { 'X-Forwarded-For': xff, ...h } }));
  const s2 = await uruchomSerwer({ dataDir: d, env: { EP_HASLO: 'tajne', EP_BLOKADA_HASLA_MS: '60000', EP_ZAUFANE_PROXY: '1' } });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await st(s2.port, `1.2.3.4, 10.0.0.${i}`, basic(`zle${i}`))).status, 401, 'różni klienci — każdy po jednej pomyłce');
    for (let i = 0; i < 5; i++) assert.equal((await st(s2.port, 'spoof, 10.0.0.9', basic(`zle${i}`))).status, 401);
    assert.equal((await st(s2.port, '10.0.0.9', basic('tajne'))).status, 429, 'klient 10.0.0.9 zablokowany');
    const ua = { 'User-Agent': 'Mozilla/5.0' };
    const inny = await st(s2.port, '10.0.0.1', { ...basic('tajne'), ...ua });
    assert.equal(inny.status, 200, 'inni użytkownicy za tym samym proxy logują się normalnie');
    assert.match(String(inny.headers['set-cookie']), /^ep_sesja=/);
    assert.doesNotMatch(String(inny.headers['set-cookie']), /Secure/);
    const https = await st(s2.port, '10.0.0.2', { ...basic('tajne'), ...ua, 'X-Forwarded-Proto': 'https' });
    assert.match(String(https.headers['set-cookie']), /; Secure$/, 'za proxy HTTPS ciasteczko tylko po HTTPS');
  } finally { await s2.zatrzymaj(); }
  const s3 = await uruchomSerwer({ dataDir: d, env: { EP_HASLO: 'tajne', EP_BLOKADA_HASLA_MS: '60000', EP_ZAUFANE_PROXY: '192.0.2.1' } });
  try {
    for (let i = 0; i < 5; i++) await st(s3.port, `10.0.0.${i}`, basic(`zle${i}`));
    assert.equal((await st(s3.port, '10.0.0.7', basic('tajne'))).status, 429, 'nadawca spoza listy proxy — X-Forwarded-For pominięty');
  } finally { await s3.zatrzymaj(); }
  assert.equal(konfiguracja({ EP_ZAUFANE_PROXY: '0' }, []).zaufaneProxy, null);
  assert.deepEqual(konfiguracja({ EP_ZAUFANE_PROXY: '::ffff:172.17.0.1, 10.0.0.1' }, []).zaufaneProxy, ['172.17.0.1', '10.0.0.1']);
});

test('błędne kodowanie „%” albo „//” w adresie → 400 (nigdy 500 ani stos w logu)', async () => {
  const przed = S.bledy().length;
  for (const [method, p] of [['GET', '/_blob/%'], ['GET', '/_blob/%E0%A4%A'], ['DELETE', '/api/assets/%E0%A4%A'], ['DELETE', '/api/assets/%'],
    ['GET', '/%ff'], ['GET', '/%'], ['GET', '/fonts/%zz.css'], ['GET', '//index.html'], ['GET', '//etc/passwd']]) {
    const r = await zadanie(S.port, { method, path: p });
    assert.equal(r.status, 400, `${method} ${p}`);
  }
  assert.doesNotMatch(S.bledy().slice(przed), /Błąd obsługi|URIError/);
});

test('/index.html/ → przekierowanie na stronę główną; ukośnik na końcu albo pusty segment w innych ścieżkach → 404', async () => {
  const r = await zadanie(S.port, { path: '/index.html/' });
  assert.equal(r.status, 301);
  assert.equal(new URL(r.headers.location, `http://h:1/index.html/`).pathname, '/');
  assert.equal(new URL(r.headers.location, `http://h:1/palety/index.html/`).pathname, '/palety/', 'względne — działa też za odwrotnym proxy');
  for (const p of ['/index.html/x', '/index.html//', '/fonts//fonts.css', '/runtime-lokalny.js/', '/fonts/fonts.css/', '/index.html;x']) {
    assert.equal((await zadanie(S.port, { path: p })).status, 404, p);
  }
});

test('baza.json ze znakiem BOM i końcami linii CRLF (Notatnik) jest czytana normalnie, bez „odtwarzania z kopii”', async () => {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  let s2 = await uruchomSerwer({ dataDir: d });
  await zapisz(s2.port, { op: 'set', coll: 'transactions', id: 't1', data: { ilosc: 1 } });
  await zapisz(s2.port, { op: 'set', coll: 'transactions', id: 't2', data: { ilosc: 2 } });
  await s2.zatrzymaj();
  const plik = path.join(d, 'baza.json');
  fs.writeFileSync(plik, '\uFEFF' + fs.readFileSync(plik, 'utf8').replace(/\n/g, '\r\n'));
  s2 = await uruchomSerwer({ dataDir: d });
  try {
    const s = await snapshot(s2.port);
    assert.deepEqual(Object.keys(s.collections.transactions).sort(), ['t1', 't2']);
    assert.deepEqual(fs.readdirSync(d).filter((f) => f.startsWith('baza.uszkodzona')), []);
    assert.equal((await zadanie(s2.port, { path: '/api/ping' })).json.odtworzenie, undefined);
    assert.doesNotMatch(s2.bledy(), /USZKODZONY/);
  } finally { await s2.zatrzymaj(); }
});

test('odtworzenie bazy przy starcie: informacja w /api/ping i /api/snapshot (dla aplikacji), także po kolejnym starcie', async () => {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  let s2 = await uruchomSerwer({ dataDir: d });
  await zapisz(s2.port, { op: 'set', coll: 'transactions', id: 't1', data: { ilosc: 1 } });
  await zapisz(s2.port, { op: 'set', coll: 'transactions', id: 't2', data: { ilosc: 2 } }); // kopia dzienna = stan sprzed tej zmiany
  await s2.zatrzymaj();
  const plik = path.join(d, 'baza.json');
  fs.writeFileSync(plik, '{"collections": {"transactions": ');
  s2 = await uruchomSerwer({ dataDir: d });
  let info;
  try {
    info = (await zadanie(s2.port, { path: '/api/ping' })).json.odtworzenie;
    assert.ok(info, 'ping zawiera informację o odtworzeniu');
    assert.match(info.zKopii, new RegExp(`^baza-${dzis}\\.json$`));
    assert.match(info.odlozony, /^baza\.uszkodzona-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/);
    assert.ok(fs.existsSync(path.join(d, info.odlozony)));
    assert.equal(info.pusta, false); assert.equal(info.brakPliku, false);
    assert.ok(Date.now() - Date.parse(info.kiedy) < 60000);
    const s = await snapshot(s2.port);
    assert.deepEqual(s.odtworzenie, info);
    assert.deepEqual(Object.keys(s.collections.transactions), ['t1'], 'stan z kopii (z początku dnia)');
  } finally { await s2.zatrzymaj(); }
  // zwykły ponowny start: ta sama informacja (aplikacja pokaże ją raz na urządzeniu)
  s2 = await uruchomSerwer({ dataDir: d });
  try { assert.deepEqual((await zadanie(s2.port, { path: '/api/ping' })).json.odtworzenie, info); } finally { await s2.zatrzymaj(); }
  // po 30 dniach ślad znika
  const znak = path.join(d, 'odtworzenie.json');
  fs.writeFileSync(znak, JSON.stringify({ ...info, kiedy: new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString() }));
  s2 = await uruchomSerwer({ dataDir: d });
  try {
    assert.equal((await zadanie(s2.port, { path: '/api/ping' })).json.odtworzenie, undefined);
    assert.ok(!fs.existsSync(znak));
  } finally { await s2.zatrzymaj(); }
  // brak baza.json, ale są kopie → pusta baza i informacja „brakPliku”
  fs.unlinkSync(plik);
  s2 = await uruchomSerwer({ dataDir: d });
  try {
    const i2 = (await zadanie(s2.port, { path: '/api/ping' })).json.odtworzenie;
    assert.equal(i2.brakPliku, true); assert.equal(i2.pusta, true); assert.notEqual(i2.id, info.id);
  } finally { await s2.zatrzymaj(); }
  // baza.json jako folder → czytelny błąd po polsku
  fs.rmSync(plik, { force: true }); fs.mkdirSync(plik);
  await assert.rejects(uruchomSerwer({ dataDir: d }), /baza\.json jest folderem/);
});

test('w kontenerze (EP_DOCKER=1): bez wewnętrznego adresu Dockera i bez „Ctrl+C”, ze wskazówką: adres NAS-a i port z docker-compose.yml', async () => {
  const lan = [{ nazwa: 'eth0', adres: '172.18.0.2' }];
  const t = tekstStartowy(konfiguracja({ EP_DOCKER: '1', DATA_DIR: '/app/dane' }, []), 8080, lan);
  assert.doesNotMatch(t, /172\.18\.0\.2|localhost|Ctrl\+C|zamknij to okno/);
  assert.match(t, /http:\/\/ADRES-NAS:PORT/);
  assert.match(t, /PRZED dwukropkiem w docker-compose\.yml → ports/);
  assert.match(t, /Container Manager → Projekt → Zatrzymaj/);
  const t2 = tekstStartowy(konfiguracja({ EP_DOCKER: '0', HOST: '0.0.0.0' }, []), 8080, [{ nazwa: 'en0', adres: '192.168.1.20' }]);
  assert.match(t2, /W sieci lokalnej:\s+http:\/\/192\.168\.1\.20:8080/);
  assert.match(t2, /Ctrl\+C/);
  assert.equal(konfiguracja({ EP_DOCKER: '1' }, []).docker, true);
  assert.equal(konfiguracja({ EP_DOCKER: '0' }, []).docker, false);
  // prawdziwy proces z EP_DOCKER=1
  const { spawn } = require('child_process');
  const { wolnyPort } = require('./pomocnicy-serwera');
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  const port = await wolnyPort();
  const proc = spawn(process.execPath, [path.join(KATALOG, 'server.js'), '--otworz'], { env: { ...process.env, PORT: String(port), HOST: '0.0.0.0', DATA_DIR: d, EP_DOCKER: '1', EP_HASLO: '', PATH: '/nie-ma' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout.on('data', (c) => { out += c; });
  try {
    const koniec = Date.now() + 10000;
    while (!out.includes('Zatrzymanie:') && Date.now() < koniec) await spij(50);
    assert.match(out, /serwer lokalny działa \(w kontenerze Docker\)/);
    assert.doesNotMatch(out, /W sieci lokalnej|Ctrl\+C/);
    assert.equal((await zadanie(port, { path: '/api/ping' })).status, 200);
  } finally { proc.kill('SIGTERM'); await new Promise((r) => proc.on('exit', r)); }
});

test('EP_HASLO_PLIK: hasło z pliku (BOM, CRLF, znaki $ # \' i spacje), kontrola zdrowia też; brak pliku → czytelny błąd', async () => {
  const d = tymczasowyKatalog(); sprzatanie.push(d);
  const plik = path.join(d, 'haslo.txt');
  const haslo = "Za$$ż #1 it's ";
  fs.writeFileSync(plik, `\uFEFF${haslo}\r\ndruga linia jest pomijana\r\n`);
  const cfg = konfiguracja({ EP_HASLO_PLIK: plik, EP_HASLO: 'ignorowane' }, []);
  assert.equal(cfg.haslo, haslo);
  const s2 = await uruchomSerwer({ dataDir: d, env: { EP_HASLO_PLIK: plik } });
  try {
    assert.equal((await zadanie(s2.port, { path: '/api/ping', headers: basic(haslo) })).status, 200);
    for (const zle of ['Za$ż #1 it\'s ', 'Za$$ż', haslo.trim(), `\uFEFF${haslo}`]) assert.equal((await zadanie(s2.port, { path: '/api/ping', headers: basic(zle) })).status, 401, JSON.stringify(zle));
    const { spawnSync } = require('child_process');
    const zdrowie = (env) => spawnSync(process.execPath, [path.join(KATALOG, 'narzedzia', 'kontrola-zdrowia.js')], { env: { ...process.env, EP_HASLO: '', PORT: String(s2.port), ...env }, timeout: 10000 }).status;
    assert.equal(zdrowie({ EP_HASLO_PLIK: plik }), 0);
    assert.equal(zdrowie({ EP_HASLO_PLIK: path.join(d, 'nie-ma.txt') }), 1);
  } finally { await s2.zatrzymaj(); }
  await assert.rejects(uruchomSerwer({ dataDir: d, env: { EP_HASLO_PLIK: path.join(d, 'nie-ma.txt') } }), /nie można odczytać pliku z hasłem EP_HASLO_PLIK/);
  fs.writeFileSync(plik, '\r\n');
  await assert.rejects(uruchomSerwer({ dataDir: d, env: { EP_HASLO_PLIK: plik } }), /jest pusty/);
});
