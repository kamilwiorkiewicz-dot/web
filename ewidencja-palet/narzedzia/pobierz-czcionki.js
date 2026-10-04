#!/usr/bin/env node
// Pobiera czcionki Space Grotesk i IBM Plex Mono (pakiety @fontsource z rejestru npm),
// kopiuje pliki woff2 (wagi 400–700, podzbiory latin + latin-ext — polskie znaki!) do fonts/
// i generuje fonts/fonts.css z regułami @font-face (font-display: swap, unicode-range).
//
// Narzędzie dla dewelopera — potrzebuje npm i internetu. Gotowy folder fonts/ jest częścią
// wydania, więc użytkownik końcowy NIE musi tego uruchamiać.
//
// Użycie:  node narzedzia/pobierz-czcionki.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const KATALOG = path.join(__dirname, '..');
const CEL = path.join(KATALOG, 'fonts');
const WAGI = [400, 500, 600, 700];
const PODZBIORY = ['latin-ext', 'latin']; // kolejność jak w Google Fonts: latin-ext przed latin
const RODZINY = [
  { pakiet: '@fontsource/space-grotesk', wersja: '5.3.0', rodzina: 'Space Grotesk', plik: 'space-grotesk', licencja: 'OFL-SpaceGrotesk.txt' },
  { pakiet: '@fontsource/ibm-plex-mono', wersja: '5.3.0', rodzina: 'IBM Plex Mono', plik: 'ibm-plex-mono', licencja: 'OFL-IBMPlexMono.txt' },
];

function npm(args, cwd) {
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' });
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-czcionki-'));
  fs.mkdirSync(CEL, { recursive: true });
  let css = '/* Czcionki lokalne aplikacji Ewidencja Palet — wygenerowane przez narzedzia/pobierz-czcionki.js.\n' +
            '   Źródło: pakiety npm @fontsource/space-grotesk i @fontsource/ibm-plex-mono (licencja SIL OFL 1.1,\n' +
            '   pliki licencji obok). Te same rodziny i wagi (400, 500, 600, 700), które aplikacja online pobiera\n' +
            '   z Google Fonts. */\n';
  try {
    for (const r of RODZINY) {
      const spec = `${r.pakiet}@${r.wersja}`;
      console.log(`Pobieram ${spec} …`);
      const tgz = npm(['pack', spec, '--silent'], tmp).trim().split(/\r?\n/).pop();
      const roz = path.join(tmp, r.plik);
      fs.mkdirSync(roz, { recursive: true });
      execFileSync('tar', ['xzf', path.join(tmp, tgz), '-C', roz]);
      const pkg = path.join(roz, 'package');
      const unicode = JSON.parse(fs.readFileSync(path.join(pkg, 'unicode.json'), 'utf8'));
      fs.copyFileSync(path.join(pkg, 'LICENSE'), path.join(CEL, r.licencja));
      for (const w of WAGI) {
        for (const sub of PODZBIORY) {
          const nazwa = `${r.plik}-${sub}-${w}-normal.woff2`;
          const zrodlo = path.join(pkg, 'files', nazwa);
          if (!fs.existsSync(zrodlo)) throw new Error(`Brak pliku ${nazwa} w pakiecie ${spec}`);
          fs.copyFileSync(zrodlo, path.join(CEL, nazwa));
          if (!unicode[sub]) throw new Error(`Brak zakresu unicode dla podzbioru ${sub} w ${spec}`);
          css += `\n/* ${r.rodzina} ${w} — ${sub} */\n@font-face {\n  font-family: '${r.rodzina}';\n  font-style: normal;\n  font-display: swap;\n  font-weight: ${w};\n  src: url(./${nazwa}) format('woff2');\n  unicode-range: ${unicode[sub]};\n}\n`;
        }
      }
    }
    fs.writeFileSync(path.join(CEL, 'fonts.css'), css);
    console.log(`Gotowe: ${CEL}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
