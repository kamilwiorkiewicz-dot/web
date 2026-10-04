#!/usr/bin/env node
// Buduje lokalną wersję aplikacji: zrodlo/aplikacja.html → index.html
//
// Zmienia DOKŁADNIE dwie rzeczy, nic więcej:
//   (a) trzy znaczniki <link> do Google Fonts (2× preconnect + arkusz css2) zastępuje jednym
//       <link rel="stylesheet" href="fonts/fonts.css">  (czcionki lokalne, działa bez internetu),
//   (b) tuż przed pierwszym wbudowanym (inline) <script> aplikacji wstawia
//       <script src="runtime-lokalny.js"></script>  (lokalna baza danych zamiast platformy Claude).
// Po zbudowaniu sprawdza odwrotną transformacją, że poza tymi dwoma miejscami plik jest identyczny
// bajt w bajt ze źródłem. Jeżeli czegoś nie znajdzie — przerywa z czytelnym błędem (kod wyjścia 1).
//
// Użycie:
//   node narzedzia/zbuduj.js                 buduje index.html
//   node narzedzia/zbuduj.js --sprawdz       tylko sprawdza, czy index.html jest aktualny (kod 1, jeśli nie)
//   node narzedzia/zbuduj.js --zrodlo A --wyjscie B   inne ścieżki (np. w testach)
'use strict';
const fs = require('fs');
const path = require('path');

const KATALOG = path.join(__dirname, '..');
const LINK_CZCIONEK = '<link rel="stylesheet" href="fonts/fonts.css">';
const ZNACZNIK_RUNTIME = '<script src="runtime-lokalny.js"></script>';
const GOOGLE_RE = /fonts\.(googleapis|gstatic)\.com/i;

class BladBudowania extends Error {}
function blad(msg) { throw new BladBudowania(msg); }

function znajdzLinkiCzcionek(src) {
  const re = /<link\b[^>]*>/gi; const out = []; let m;
  while ((m = re.exec(src))) if (GOOGLE_RE.test(m[0])) out.push({ start: m.index, end: m.index + m[0].length, tag: m[0] });
  return out;
}

// rodziny i wagi zamawiane z Google Fonts, np. {"Space Grotesk":[400,500,600,700], ...}
function rodzinyZGoogle(tag) {
  const href = (/href="([^"]+)"/i.exec(tag) || [])[1] || '';
  const out = {};
  const query = href.split('?')[1] || '';
  for (const part of query.split('&')) {
    if (!part.startsWith('family=')) continue;
    const v = decodeURIComponent(part.slice(7)).replace(/\+/g, ' ');
    const [name, spec] = v.split(':');
    let wagi = [400];
    if (spec) {
      const m = /wght@([\d;.]+)/.exec(spec);
      if (!m) blad(`Nieobsługiwany format rodziny czcionek w Google Fonts: "${v}"`);
      wagi = m[1].split(';').map(Number);
    }
    out[name] = wagi;
  }
  return out;
}

function rodzinyLokalne(css) {
  const out = {}; const re = /@font-face\s*{([^}]*)}/g; let m;
  while ((m = re.exec(css))) {
    const fam = (/font-family:\s*['"]?([^'";]+)['"]?/.exec(m[1]) || [])[1];
    const w = Number((/font-weight:\s*(\d+)/.exec(m[1]) || [])[1] || 400);
    if (fam) (out[fam] = out[fam] || new Set()).add(w);
  }
  return out;
}

/** Czysta funkcja: zwraca zbudowany HTML albo rzuca BladBudowania. */
function zbuduj(src, opcje = {}) {
  if (typeof src !== 'string' || !src.length) blad('Plik źródłowy jest pusty.');
  if (/<script\b[^>]*\bsrc\s*=\s*["']?runtime-lokalny\.js/i.test(src)) blad('Źródło już zawiera <script src="runtime-lokalny.js"> — to wygląda na zbudowany plik, a nie na zrodlo/aplikacja.html.');
  if (src.includes(LINK_CZCIONEK)) blad('Źródło już zawiera link do fonts/fonts.css — to wygląda na zbudowany plik.');
  const nl = src.includes('\r\n') ? '\r\n' : '\n';

  // (a) czcionki
  const linki = znajdzLinkiCzcionek(src);
  if (linki.length !== 3) blad(`Oczekiwano dokładnie 3 znaczników <link> do Google Fonts (2× preconnect + arkusz), znaleziono ${linki.length}.`);
  const preconnect = linki.filter(l => /rel="preconnect"/i.test(l.tag));
  const arkusz = linki.filter(l => /rel="stylesheet"/i.test(l.tag) && /fonts\.googleapis\.com\/css2?\?/i.test(l.tag));
  if (preconnect.length !== 2 || arkusz.length !== 1) blad('Znaczniki Google Fonts mają nieoczekiwaną postać (oczekiwano 2× rel="preconnect" i 1× rel="stylesheet" do fonts.googleapis.com/css2).');
  const blokStart = linki[0].start, blokEnd = linki[2].end;
  const blok = src.slice(blokStart, blokEnd);
  let pomiedzy = blok;
  for (const l of linki) pomiedzy = pomiedzy.replace(l.tag, '');
  if (pomiedzy.trim() !== '') blad('Znaczniki Google Fonts nie stoją obok siebie — między nimi jest inna treść. Zaktualizuj narzedzia/zbuduj.js.');
  if (GOOGLE_RE.test(src.slice(0, blokStart) + src.slice(blokEnd))) blad('Poza znacznikami <link> plik odwołuje się jeszcze do Google Fonts (np. @import w CSS) — wersja lokalna nie działałaby bez internetu.');

  // czy lokalne czcionki pokrywają wszystkie zamawiane rodziny i wagi?
  const fontsCss = opcje.fontsCss !== undefined ? opcje.fontsCss : (() => { try { return fs.readFileSync(path.join(KATALOG, 'fonts', 'fonts.css'), 'utf8'); } catch (e) { return null; } })();
  if (fontsCss !== null) {
    const chciane = rodzinyZGoogle(arkusz[0].tag), mamy = rodzinyLokalne(fontsCss);
    for (const [fam, wagi] of Object.entries(chciane)) {
      for (const w of wagi) if (!mamy[fam] || !mamy[fam].has(w)) blad(`Aplikacja zamawia czcionkę "${fam}" w wadze ${w}, a fonts/fonts.css jej nie ma. Uzupełnij narzedzia/pobierz-czcionki.js i uruchom je ponownie.`);
    }
  }
  let out = src.slice(0, blokStart) + LINK_CZCIONEK + src.slice(blokEnd);

  // (b) runtime — przed pierwszym <script> bez atrybutu src
  const reScript = /<script\b([^>]*)>/gi; let m, poz = -1;
  while ((m = reScript.exec(out))) { if (!/\bsrc\s*=/i.test(m[1])) { poz = m.index; break; } }
  if (poz < 0) blad('Nie znaleziono wbudowanego <script> aplikacji.');
  if (poz < blokStart) blad('Pierwszy <script> stoi przed znacznikami czcionek — nieoczekiwana budowa pliku.');
  out = out.slice(0, poz) + ZNACZNIK_RUNTIME + nl + out.slice(poz);

  weryfikuj(src, out, blok, nl);
  return out;
}

/** Odwrotna transformacja musi dać dokładnie źródło. */
function weryfikuj(src, out, blokCzcionek, nl) {
  const wstawka = ZNACZNIK_RUNTIME + nl;
  if (out.split(wstawka).length !== 2) blad('Weryfikacja: znacznik runtime-lokalny.js występuje inną liczbę razy niż 1.');
  if (out.split(LINK_CZCIONEK).length !== 2) blad('Weryfikacja: link do fonts/fonts.css występuje inną liczbę razy niż 1.');
  const odtworzone = out.replace(wstawka, '').replace(LINK_CZCIONEK, blokCzcionek);
  if (odtworzone !== src) blad('Weryfikacja nie powiodła się: poza dwoma zamierzonymi miejscami plik różni się od źródła.');
  if (GOOGLE_RE.test(out)) blad('Weryfikacja: w wyniku zostało odwołanie do Google Fonts.');
}

function zapiszAtomowo(plik, tresc) {
  const tmp = `${plik}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, tresc);
  fs.renameSync(tmp, plik);
}

function main(argv) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const zrodlo = path.resolve(arg('--zrodlo') || path.join(KATALOG, 'zrodlo', 'aplikacja.html'));
  const wyjscie = path.resolve(arg('--wyjscie') || path.join(KATALOG, 'index.html'));
  const tylkoSprawdz = argv.includes('--sprawdz');
  try {
    if (!fs.existsSync(zrodlo)) blad(`Nie ma pliku źródłowego: ${zrodlo}`);
    const src = fs.readFileSync(zrodlo, 'utf8');
    const out = zbuduj(src);
    if (tylkoSprawdz) {
      const obecny = fs.existsSync(wyjscie) ? fs.readFileSync(wyjscie, 'utf8') : null;
      if (obecny !== out) { console.error(`✗ ${path.relative(process.cwd(), wyjscie) || wyjscie} jest nieaktualny — uruchom: node narzedzia/zbuduj.js`); return 1; }
      console.log('✓ index.html jest aktualny względem zrodlo/aplikacja.html');
      return 0;
    }
    zapiszAtomowo(wyjscie, out);
    console.log(`✓ Zbudowano ${wyjscie}`);
    console.log(`  źródło: ${zrodlo} (${Buffer.byteLength(src)} B) → wynik: ${Buffer.byteLength(out)} B`);
    console.log('  zmiany: Google Fonts → fonts/fonts.css, dodany <script src="runtime-lokalny.js">; reszta identyczna (zweryfikowano).');
    return 0;
  } catch (e) {
    if (e instanceof BladBudowania) {
      console.error('\n✗ BŁĄD BUDOWANIA — index.html NIE został zmieniony.\n  ' + e.message + '\n');
      return 1;
    }
    throw e;
  }
}

module.exports = { zbuduj, weryfikuj, BladBudowania, LINK_CZCIONEK, ZNACZNIK_RUNTIME };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
