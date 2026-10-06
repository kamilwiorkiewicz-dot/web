// Testy budowania wersji lokalnej (narzedzia/zbuduj.js) i kontrola plików wydania
// (czcionki, programy uruchamiające, Docker). Bez zależności, bez przeglądarki.
// Uruchomienie:  node --test testy/test-zbuduj.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { zbuduj, weryfikuj, BladBudowania, LINK_CZCIONEK, ZNACZNIK_RUNTIME } = require('../narzedzia/zbuduj');

const KATALOG = path.join(__dirname, '..');
const ZBUDUJ = path.join(KATALOG, 'narzedzia', 'zbuduj.js');
const ZRODLO = path.join(KATALOG, 'zrodlo', 'aplikacja.html');
const czytaj = (p) => fs.readFileSync(path.join(KATALOG, p), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ep-zbuduj-'));
const uruchom = (args) => spawnSync(process.execPath, [ZBUDUJ, ...args], { encoding: 'utf8' });

// mała, ale wierna budowa pliku aplikacji (te same znaczniki co w zrodlo/aplikacja.html)
const GOOGLE = [
  '<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  '<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">',
];
function mini(nl = '\n', { linki = GOOGLE, skrypt = `<script>${nl}console.log("app");${nl}</script>`, przed = '' } = {}) {
  return ['<!DOCTYPE html>', '<html lang="pl">', '<head>', '<meta charset="UTF-8" />', '<title>T</title>', ...linki,
    '<style>body{font-family:"Space Grotesk"}</style>', '</head>', '<body>', przed, '<div id="main"></div>', skrypt, '</body>', '</html>', ''].join(nl);
}
const oczekujBledu = (fn, wzor) => assert.throws(fn, (e) => e instanceof BladBudowania && wzor.test(e.message));

/* ---------------------------- zbuduj() ---------------------------- */
test('prawdziwe źródło: dokładnie dwie zmiany, odwracalne bajt w bajt', () => {
  const src = fs.readFileSync(ZRODLO, 'utf8');
  const out = zbuduj(src);
  assert.equal(out.split(LINK_CZCIONEK).length, 2, 'jeden link do fonts/fonts.css');
  assert.equal(out.split(ZNACZNIK_RUNTIME).length, 2, 'jeden <script src="runtime-lokalny.js">');
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(out), 'żadnych odwołań do Google Fonts');
  // runtime stoi tuż przed pierwszym wbudowanym skryptem aplikacji
  const pierwszyInline = /<script\b(?![^>]*\bsrc=)[^>]*>/i.exec(out);
  assert.ok(pierwszyInline);
  assert.equal(out.slice(pierwszyInline.index - ZNACZNIK_RUNTIME.length - 1, pierwszyInline.index), ZNACZNIK_RUNTIME + '\n');
  assert.ok(out.indexOf(LINK_CZCIONEK) < out.indexOf('<style>'), 'arkusz czcionek w <head>, przed stylami aplikacji');
  // poza dwoma miejscami — identycznie
  const blok = src.slice(src.indexOf(GOOGLE[0]), src.indexOf(GOOGLE[2]) + GOOGLE[2].length);
  assert.equal(out.replace(ZNACZNIK_RUNTIME + '\n', '').replace(LINK_CZCIONEK, blok), src);
  assert.equal(Buffer.byteLength(src) - Buffer.byteLength(out), Buffer.byteLength(blok) - Buffer.byteLength(LINK_CZCIONEK) - Buffer.byteLength(ZNACZNIK_RUNTIME + '\n'));
});

// EP_ZRODLO=testy/baseline-v3.html — index.html zbudowany z innej (np. zamrożonej) wersji aplikacji, jak w test-przegladarka.js
const ZRODLO_INDEXU = process.env.EP_ZRODLO ? path.resolve(process.env.EP_ZRODLO) : ZRODLO;
test(`index.html jest aktualny względem ${path.relative(KATALOG, ZRODLO_INDEXU)} (node narzedzia/zbuduj.js --sprawdz)`, () => {
  const r = uruchom(['--sprawdz', '--zrodlo', ZRODLO_INDEXU]);
  assert.equal(r.status, 0, `index.html nieaktualny — uruchom: node narzedzia/zbuduj.js${process.env.EP_ZRODLO ? ` --zrodlo ${process.env.EP_ZRODLO}` : ''}\n${r.stderr}`);
  assert.equal(czytaj('index.html'), zbuduj(fs.readFileSync(ZRODLO_INDEXU, 'utf8')));
});

test('małe źródło: LF i CRLF zachowane, wynik przechodzi weryfikację', () => {
  for (const nl of ['\n', '\r\n']) {
    const src = mini(nl);
    const out = zbuduj(src, { fontsCss: czytaj('fonts/fonts.css') });
    assert.ok(out.includes(ZNACZNIK_RUNTIME + nl + '<script>'), `znacznik runtime z końcem linii ${JSON.stringify(nl)}`);
    assert.ok(out.includes(`<title>T</title>${nl}${LINK_CZCIONEK}${nl}<style>`));
    if (nl === '\r\n') assert.ok(!/[^\r]\n/.test(out), 'w pliku CRLF nie może pojawić się samo LF');
  }
});

test('runtime trafia przed PIERWSZY skrypt wbudowany, a nie przed zewnętrzny', () => {
  const src = mini('\n', { przed: '<script src="inny.js"></script>' });
  const out = zbuduj(src, { fontsCss: null });
  assert.ok(out.indexOf('<script src="inny.js">') < out.indexOf(ZNACZNIK_RUNTIME));
  assert.ok(out.includes(ZNACZNIK_RUNTIME + '\n<script>\nconsole.log'));
});

test('błędy budowania: czytelny komunikat zamiast cichej, złej wersji', () => {
  oczekujBledu(() => zbuduj(''), /pusty/);
  oczekujBledu(() => zbuduj(mini('\n', { linki: GOOGLE.slice(1) })), /dokładnie 3/);
  oczekujBledu(() => zbuduj(mini('\n', { linki: [GOOGLE[0], '<meta name="x">', GOOGLE[1], GOOGLE[2]] })), /nie stoją obok siebie/);
  oczekujBledu(() => zbuduj(mini('\n', { przed: '<style>@import url(https://fonts.googleapis.com/css2?family=X);</style>' })), /Google Fonts/);
  oczekujBledu(() => zbuduj(mini('\n', { skrypt: '' })), /wbudowanego <script>/);
  oczekujBledu(() => zbuduj(zbuduj(mini(), { fontsCss: null })), /zbudowany plik/);
  // aplikacja zamawia wagę, której lokalne czcionki nie mają
  const bez700 = czytaj('fonts/fonts.css').replace(/@font-face\s*{[^}]*font-weight:\s*700;[^}]*}/g, '');
  oczekujBledu(() => zbuduj(mini(), { fontsCss: bez700 }), /w wadze 700/);
});

test('weryfikacja wykrywa każdą inną zmianę', () => {
  const src = mini(); const out = zbuduj(src, { fontsCss: null });
  const blok = GOOGLE.join('\n');
  weryfikuj(src, out, blok, '\n'); // poprawny wynik przechodzi
  oczekujBledu(() => weryfikuj(src, out.replace('console.log("app")', 'console.log("APP")'), blok, '\n'), /różni się od źródła/);
  oczekujBledu(() => weryfikuj(src, out + ZNACZNIK_RUNTIME + '\n', blok, '\n'), /inną liczbę razy/);
});

test('wiersz poleceń: --zrodlo/--wyjscie, --sprawdz (kod 1 gdy nieaktualny), błąd nie rusza wyniku', () => {
  const d = tmp();
  try {
    const src = path.join(d, 'a.html'), wyj = path.join(d, 'index.html');
    fs.writeFileSync(src, mini());
    let r = uruchom(['--zrodlo', src, '--wyjscie', wyj]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Zbudowano/);
    assert.equal(fs.readFileSync(wyj, 'utf8'), zbuduj(mini()));
    assert.equal(uruchom(['--zrodlo', src, '--wyjscie', wyj, '--sprawdz']).status, 0);
    fs.writeFileSync(src, mini().replace('"app"', '"app2"'));
    r = uruchom(['--zrodlo', src, '--wyjscie', wyj, '--sprawdz']);
    assert.equal(r.status, 1); assert.match(r.stderr, /nieaktualny/);
    const przed = fs.readFileSync(wyj, 'utf8');
    fs.writeFileSync(src, mini('\n', { linki: GOOGLE.slice(0, 2) }));
    r = uruchom(['--zrodlo', src, '--wyjscie', wyj]);
    assert.equal(r.status, 1); assert.match(r.stderr, /BŁĄD BUDOWANIA — index\.html NIE został zmieniony/);
    assert.equal(fs.readFileSync(wyj, 'utf8'), przed);
    assert.deepEqual(fs.readdirSync(d).filter((f) => f.includes('.tmp-')), [], 'bez plików tymczasowych');
    r = uruchom(['--zrodlo', path.join(d, 'nie-ma.html'), '--wyjscie', wyj]);
    assert.equal(r.status, 1); assert.match(r.stderr, /Nie ma pliku źródłowego/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

/* ---------------------------- czcionki ---------------------------- */
test('fonts/: Space Grotesk i IBM Plex Mono 400–700, latin + latin-ext, prawdziwe pliki woff2, licencje OFL', () => {
  const css = czytaj('fonts/fonts.css');
  const reguly = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
  assert.equal(reguly.length, 16);
  const mamy = new Set();
  for (const r of reguly) {
    const fam = /font-family:\s*'([^']+)'/.exec(r)[1], w = /font-weight:\s*(\d+)/.exec(r)[1];
    const plik = /src:\s*url\(\.\/([^)]+)\)\s*format\('woff2'\)/.exec(r)[1];
    const zakres = /unicode-range:\s*([^;]+);/.exec(r)[1];
    assert.match(r, /font-display:\s*swap/);
    const buf = fs.readFileSync(path.join(KATALOG, 'fonts', plik));
    assert.equal(buf.slice(0, 4).toString('latin1'), 'wOF2', `${plik} to nie woff2`);
    assert.ok(buf.length > 5000, `${plik} podejrzanie mały`);
    const podzbior = plik.includes('latin-ext') ? 'latin-ext' : 'latin';
    if (podzbior === 'latin-ext') assert.match(zakres, /U\+0100-02BA/, 'latin-ext obejmuje polskie litery (ą ę ł ń ś ź ż)');
    else assert.match(zakres, /U\+0000-00FF/);
    mamy.add(`${fam}|${w}|${podzbior}`);
  }
  for (const fam of ['Space Grotesk', 'IBM Plex Mono']) for (const w of [400, 500, 600, 700]) for (const p of ['latin', 'latin-ext']) assert.ok(mamy.has(`${fam}|${w}|${p}`), `brak ${fam} ${w} ${p}`);
  for (const lic of ['fonts/OFL-SpaceGrotesk.txt', 'fonts/OFL-IBMPlexMono.txt']) assert.match(czytaj(lic), /SIL Open Font License, Version 1\.1/);
});

/* ---------------------------- pliki wydania ---------------------------- */
test('programy uruchamiające: .bat z CRLF, .command i uruchom.sh z LF i prawem wykonania, otwierają przeglądarkę', () => {
  const bat = fs.readFileSync(path.join(KATALOG, 'Uruchom serwer (Windows).bat'), 'latin1');
  assert.ok(bat.includes('\r\n') && !/[^\r]\n/.test(bat), '.bat musi mieć wyłącznie końce linii CRLF');
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(bat), '.bat tylko ASCII (cmd.exe i strona kodowa)');
  assert.match(bat, /node server\.js --otworz/);
  assert.match(bat, /cd \/d "%~dp0"/, '.bat działa z folderu, w którym leży');
  for (const f of ['Uruchom serwer (Mac).command', 'uruchom.sh']) {
    const t = fs.readFileSync(path.join(KATALOG, f), 'utf8');
    assert.ok(!t.includes('\r'), `${f}: bez CR`);
    assert.match(t, /^#!\/bin\/(ba)?sh\n/, `${f}: shebang`);
    assert.match(t, /cd "\$\(dirname "\$0"\)"/, `${f}: działa z własnego folderu`);
    if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(KATALOG, f)).mode & 0o111, `${f}: brak prawa wykonania (chmod +x)`);
    const sh = spawnSync(f.endsWith('.command') ? 'bash' : 'sh', ['-n', path.join(KATALOG, f)], { encoding: 'utf8' });
    if (!sh.error) assert.equal(sh.status, 0, `${f}: błąd składni\n${sh.stderr}`);
  }
  assert.match(czytaj('Uruchom serwer (Mac).command'), /node server\.js --otworz/);
  const ga = czytaj('.gitattributes');
  assert.match(ga, /^\*\.bat\s+text eol=crlf$/m);
  assert.match(ga, /^\*\.command\s+text eol=lf$/m);
  assert.match(ga, /^\*\.sh\s+text eol=lf$/m);
});

test('Docker: node:22-alpine, użytkownik bez roota, wolumen /app/dane, HEALTHCHECK; compose zgodny z instrukcją', () => {
  const df = czytaj('Dockerfile');
  assert.match(df, /^FROM node:22-alpine$/m);
  assert.match(df, /^USER node$/m);
  assert.match(df, /^VOLUME \/app\/dane$/m);
  assert.match(df, /^HEALTHCHECK [\s\S]*kontrola-zdrowia\.js/m);
  assert.match(df, /^CMD \["node", "server\.js"\]$/m);
  // wszystko, co kopiuje Dockerfile, istnieje i nie jest wykluczone w .dockerignore
  const ign = czytaj('.dockerignore').split(/\r?\n/).filter(Boolean);
  for (const m of df.matchAll(/^COPY (?:--chown=\S+ )?(.+) \S+$/gm)) {
    for (const p of m[1].split(/\s+/)) {
      assert.ok(fs.existsSync(path.join(KATALOG, p)), `Dockerfile kopiuje nieistniejący ${p}`);
    }
  }
  for (const wzor of ['dane', 'testy', 'zrodlo', 'node_modules']) assert.ok(ign.includes(wzor), `.dockerignore powinien wykluczać ${wzor}`);
  assert.ok(ign.includes('!narzedzia/kontrola-zdrowia.js'));
  const dc = czytaj('docker-compose.yml');
  assert.match(dc, /- "8080:8080"/);
  assert.match(dc, /- \.\/dane:\/app\/dane/);
  assert.match(dc, /restart: unless-stopped/);
  assert.match(dc, /TZ=Europe\/Warsaw/);
  assert.match(dc, /^\s*# - 'EP_HASLO=[^']*'$/m, 'EP_HASLO zakomentowane, w apostrofach');
  assert.match(dc, /^\s*# - EP_HASLO_PLIK=\/app\/dane\/haslo\.txt$/m, 'hasło z pliku w folderze danych (zamontowanym w /app/dane)');
  assert.match(dc, /każdy znak \$ wpisz PODWÓJNIE \(\$\$\)/, 'komentarz ostrzega przed $ w haśle');
  assert.match(dc, /obcina hasło od „ #”/, 'komentarz ostrzega przed # w haśle');
  assert.ok(!/^\s*- EP_HASLO/m.test(dc), 'hasło domyślnie wyłączone');
  assert.match(dc, /EP_UZYTKOWNIK=auto/);
  assert.match(df, /EP_DOCKER=1/, 'serwer wie, że działa w kontenerze');
});

// docker compose (bez demona): przykład hasła z komentarza przechodzi bez obcięcia i bez podmiany $
const compose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
test('docker-compose.yml: hasło z $ i # w zapisie z komentarza dociera do kontenera bez zmian (docker compose config)', { skip: (compose.error || compose.status !== 0) && 'brak docker compose' }, () => {
  const d = tmp();
  try {
    const dc = czytaj('docker-compose.yml');
    const przyklad = /^(\s*)# (- 'EP_HASLO=[^']*')$/m.exec(dc);
    assert.ok(przyklad, 'przykład EP_HASLO w komentarzu');
    const plikHasla = /^(\s*)# (- EP_HASLO_PLIK=\S+)$/m.exec(dc);
    const warianty = {
      B: dc.replace(przyklad[0], przyklad[1] + przyklad[2]),
      A: dc.replace(plikHasla[0], plikHasla[1] + plikHasla[2]),
      zle: dc.replace(przyklad[0], `${przyklad[1]}- EP_HASLO=Ab$12 #x`),
    };
    const env = {};
    for (const [n, tresc] of Object.entries(warianty)) {
      fs.writeFileSync(path.join(d, 'docker-compose.yml'), tresc);
      const r = spawnSync('docker', ['compose', '-f', path.join(d, 'docker-compose.yml'), 'config', '--format', 'json'], { encoding: 'utf8', cwd: d });
      assert.equal(r.status, 0, r.stderr);
      env[n] = JSON.parse(r.stdout).services['ewidencja-palet'].environment;
    }
    // w postaci kanonicznej compose zapisuje $ jako $$ — w kontenerze to jeden znak $: „Ab$12 #x”
    assert.equal(env.B.EP_HASLO, 'Ab$$12 #x');
    assert.equal(env.A.EP_HASLO_PLIK, '/app/dane/haslo.txt');
    assert.equal(env.A.EP_HASLO, undefined);
    assert.notEqual(env.zle.EP_HASLO, 'Ab$$12 #x', 'bez apostrofów hasło jest psute — dlatego komentarz każe użyć apostrofów');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('programy uruchamiające bez reszty folderu (np. prosto z ZIP): komunikat po polsku zamiast błędu Node', { skip: process.platform === 'win32' && 'test dla Linuksa/macOS' }, () => {
  const d = tmp();
  try {
    for (const [f, powloka, wzor] of [['Uruchom serwer (Mac).command', 'bash', /rozpakuj CAŁE archiwum \(dwuklik na pliku \.zip w Finderze\)/], ['uruchom.sh', 'sh', /Rozpakuj CAŁE archiwum/]]) {
      fs.copyFileSync(path.join(KATALOG, f), path.join(d, f));
      const r = spawnSync(powloka, [path.join(d, f)], { encoding: 'utf8', input: '\n', timeout: 20000 });
      const out = r.stdout + r.stderr;
      assert.equal(r.status, 1, `${f}: kod wyjścia\n${out}`);
      assert.match(out, /Brakuje plików aplikacji obok tego skryptu \(nie ma: server\.js\)/, f);
      assert.match(out, wzor, f);
      assert.doesNotMatch(out, /MODULE_NOT_FOUND|Cannot find module|at Module/, f);
    }
    // pełny folder bez index.html i bez narzedzia/ (np. częściowo rozpakowany) — też komunikat, nie stos
    for (const p of ['server.js', 'runtime-lokalny.js']) fs.copyFileSync(path.join(KATALOG, p), path.join(d, p));
    fs.mkdirSync(path.join(d, 'fonts')); fs.copyFileSync(path.join(KATALOG, 'fonts', 'fonts.css'), path.join(d, 'fonts', 'fonts.css'));
    const r = spawnSync('sh', [path.join(d, 'uruchom.sh')], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /nie ma: index\.html/);
    assert.doesNotMatch(r.stdout + r.stderr, /MODULE_NOT_FOUND/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
  // Windows: ta sama kontrola w .bat (uruchomienie z ZIP wypakowuje tylko ten jeden plik do %TEMP%)
  const bat = fs.readFileSync(path.join(KATALOG, 'Uruchom serwer (Windows).bat'), 'latin1');
  for (const p of ['server.js', 'runtime-lokalny.js', 'fonts\\fonts.css']) assert.ok(bat.includes(`if not exist "${p}" set "BRAK=`), `.bat sprawdza ${p}`);
  assert.match(bat, /if not exist "index\.html" if not exist "narzedzia\\zbuduj\.js" set "BRAK=index\.html"/);
  assert.match(bat, /"Wyodrebnij wszystkie\.\.\."/);
  assert.match(bat, /find \/i "\.zip"/);
  assert.ok(bat.indexOf('goto brak_plikow') < bat.indexOf('where node'), '.bat najpierw sprawdza pliki, potem Node.js');
});

test('package.json: skrypty wskazują istniejące pliki, brak zależności', () => {
  const pkg = JSON.parse(czytaj('package.json'));
  assert.equal(pkg.dependencies, undefined);
  for (const s of Object.values(pkg.scripts)) {
    for (const m of s.matchAll(/(?:^|\s)((?:testy|narzedzia)\/[\w.-]+\.js|server\.js)/g)) assert.ok(fs.existsSync(path.join(KATALOG, m[1])), `brak ${m[1]} (${s})`);
  }
});
