#!/usr/bin/env node
/* =========================================================================
   EWIDENCJA PALET — lokalny serwer (Node.js >= 18, bez żadnych zależności)

   Udostępnia aplikację (index.html) w sieci lokalnej i przechowuje wspólną bazę
   danych dla wszystkich komputerów/telefonów, które ją otworzą.

   Zmienne środowiskowe:
     PORT       port HTTP (domyślnie 8080)
     HOST       adres nasłuchiwania (domyślnie 0.0.0.0 = cała sieć lokalna;
                127.0.0.1 = tylko ten komputer)
     DATA_DIR   folder z danymi (domyślnie ./dane obok tego pliku)
     EP_HASLO   jeśli ustawione — każde wejście wymaga hasła (HTTP Basic,
                dowolna nazwa użytkownika)
     EP_UZYTKOWNIK  (Docker/Synology) "auto" albo "UID:GID" — gdy serwer startuje
                jako root: nadaje folderowi danych właściciela i przechodzi na
                zwykłego użytkownika (patrz docker-compose.yml)
   Opcja wiersza poleceń:
     --otworz   po starcie otwiera aplikację w przeglądarce

   Dane:  DATA_DIR/baza.json           cała baza (zapis atomowy przy każdej zmianie)
          DATA_DIR/zalaczniki/<id>     wgrane loga kurierów
          DATA_DIR/kopie/baza-RRRR-MM-DD.json   kopia dzienna (30 ostatnich)
   ========================================================================= */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');

const APP = 'ewidencja-palet';
const VERSION = '1.0.0';
const ROOT = __dirname;

const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const ASSET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const LIMIT_BODY = 1024 * 1024;           // 1 MB na zapis JSON
const LIMIT_ASSET = 4 * 1024 * 1024;      // 4 MB na logo
const LIMIT_BATCH = 5000;                 // zapisów w jednej paczce
const KOPII_DZIENNYCH = 30;
const OPS = new Set(['set', 'update', 'delete']);

/* ---------------------------- konfiguracja ---------------------------- */
function konfiguracja(env, argv) {
  const port = env.PORT === undefined || env.PORT === '' ? 8080 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Nieprawidłowy PORT: "${env.PORT}" (dozwolone 0–65535).`);
  }
  return {
    port,
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, 'dane')),
    haslo: env.EP_HASLO || '',
    otworz: argv.includes('--otworz'),
    heartbeatMs: Number(env.EP_HEARTBEAT_MS) > 0 ? Number(env.EP_HEARTBEAT_MS) : 25000,
  };
}

/* ---------------------------- narzędzia ---------------------------- */
const pad2 = (n) => String(n).padStart(2, '0');
function dzisiaj(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function znacznikCzasu(d = new Date()) { return `${dzisiaj(d)}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`; }
function noweId(len = 20) {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'; let s = '';
  while (s.length < len) { const b = crypto.randomBytes(len * 2); for (const x of b) { if (x < 252 && s.length < len) s += abc[x % 36]; } }
  return s;
}
function czyObiekt(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function czyUsun(v) { return czyObiekt(v) && v.__delete__ === true && Object.keys(v).length === 1; }
function ustaw(o, k, v) { Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); }
// głęboka kopia przez JSON (dane są czystym JSON-em); bezpieczna dla kluczy typu "__proto__"
function klon(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
// set: znaczniki {__delete__:true} nie trafiają do dokumentu (na żadnym poziomie)
function bezZnacznikowUsun(data) {
  const o = {};
  for (const k of Object.keys(data)) if (!czyUsun(data[k])) ustaw(o, k, czyObiekt(data[k]) ? bezZnacznikowUsun(data[k]) : data[k]);
  return o;
}
// update: jak na platformie — zagnieżdżone obiekty scalają się rekurencyjnie, tablice i reszta zastępują
// pole w całości, {__delete__:true} usuwa pole (także zagnieżdżone)
function scal(stare, zmiana) {
  const o = {};
  for (const k of Object.keys(stare)) ustaw(o, k, stare[k]);
  for (const k of Object.keys(zmiana)) {
    const v = zmiana[k];
    if (czyUsun(v)) delete o[k];
    else if (czyObiekt(v) && czyObiekt(o[k])) ustaw(o, k, scal(o[k], v));
    else ustaw(o, k, czyObiekt(v) ? bezZnacznikowUsun(v) : v);
  }
  return o;
}
// podobiekt pod kluczem k (tworzy go); bezpieczne także dla klucza "__proto__"
function grupa(o, k) { if (!Object.prototype.hasOwnProperty.call(o, k)) ustaw(o, k, {}); return o[k]; }
const poprawneId = (v) => typeof v === 'string' && ID_RE.test(v) && v !== '.' && v !== '..';
function spij(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* ignore */ } }

function fsyncKatalog(dir) {
  if (process.platform === 'win32') return;
  try { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch (e) { /* niektóre systemy plików nie pozwalają — trudno */ }
}
let tmpSeq = 0;
/** Zapis atomowy: plik tymczasowy → fsync → rename → fsync katalogu. */
function zapiszAtomowo(plik, dane) {
  const buf = Buffer.isBuffer(dane) ? dane : Buffer.from(dane, 'utf8');
  const tmp = `${plik}.tmp-${process.pid}-${++tmpSeq}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    let off = 0; while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  for (let proba = 0; ; proba++) {
    try { fs.renameSync(tmp, plik); break; }
    catch (e) {
      // Windows: antywirus / indeksowanie potrafi chwilowo blokować plik
      if (proba < 20 && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) { spij(50); continue; }
      try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
      throw e;
    }
  }
  fsyncKatalog(path.dirname(plik));
}
/** To samo asynchronicznie (nie blokuje serwera podczas zapisu bazy). */
async function zapiszAtomowoAsync(plik, dane) {
  const buf = Buffer.isBuffer(dane) ? dane : Buffer.from(dane, 'utf8');
  const tmp = `${plik}.tmp-${process.pid}-${++tmpSeq}`;
  const fh = await fs.promises.open(tmp, 'w');
  try { await fh.writeFile(buf); await fh.sync(); } finally { await fh.close(); }
  for (let proba = 0; ; proba++) {
    try { await fs.promises.rename(tmp, plik); break; }
    catch (e) {
      if (proba < 20 && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) { await new Promise((r) => setTimeout(r, 50)); continue; }
      await fs.promises.unlink(tmp).catch(() => {});
      throw e;
    }
  }
  if (process.platform !== 'win32') {
    try { const d = await fs.promises.open(path.dirname(plik), 'r'); try { await d.sync(); } finally { await d.close(); } } catch (e) { /* ignore */ }
  }
}

/* ---------------------------- baza danych ---------------------------- */
class Baza {
  constructor(dataDir, log) {
    this.dir = dataDir;
    this.plik = path.join(dataDir, 'baza.json');
    this.dirZal = path.join(dataDir, 'zalaczniki');
    this.dirKopie = path.join(dataDir, 'kopie');
    this.log = log;
    this.rev = 0;
    this.kolekcje = new Map();   // coll -> Map(id -> data)
    this.zalaczniki = new Map(); // id -> {contentType, sizeBytes, createdAt}
    this.dzienKopii = null;
    this.oczekujace = [];        // żądania czekające na trwały zapis
    this.petla = null;           // trwająca pętla zapisu
    this.wersjaStanu = 0;        // rośnie przy każdej zmianie w pamięci
    this.wersjaZapisana = 0;     // wersja, która jest już na dysku
    this.ostatnioZapisany = null;// treść ostatnio zapisanego pliku (do wycofania przy błędzie zapisu)
    this.liczbaZapisow = 0;
    this.revZapisany = 0;        // rev stanu, który jest już na dysku
  }

  przygotujKatalogi() {
    for (const d of [this.dir, this.dirZal, this.dirKopie]) fs.mkdirSync(d, { recursive: true });
    const proba = path.join(this.dir, `.proba-zapisu-${process.pid}`);
    fs.writeFileSync(proba, 'ok'); fs.unlinkSync(proba);
    // sprzątanie po ewentualnej awarii w trakcie zapisu
    for (const d of [this.dir, this.dirZal, this.dirKopie]) {
      for (const f of fs.readdirSync(d)) if (/\.tmp-\d+-\d+$/.test(f)) { try { fs.unlinkSync(path.join(d, f)); } catch (e) { /* ignore */ } }
    }
  }

  /** Czyta plik bazy (baza.json) ALBO kopię w formacie aplikacji (kopie dzienne, /api/kopia, „Pobierz kopię”). */
  static parsuj(tekst) {
    let o = JSON.parse(tekst);
    if (czyObiekt(o) && o.app === APP && Array.isArray(o.couriers) && Array.isArray(o.transactions)) o = zKopiiAplikacji(o);
    if (!czyObiekt(o) || !czyObiekt(o.collections)) throw new Error('brak sekcji "collections"');
    for (const [c, docs] of Object.entries(o.collections)) {
      if (!poprawneId(c) || !czyObiekt(docs)) throw new Error(`nieprawidłowa kolekcja "${c}"`);
      for (const [id, d] of Object.entries(docs)) if (!poprawneId(id) || !czyObiekt(d)) throw new Error(`nieprawidłowy dokument "${c}/${id}"`);
    }
    if (o.assets !== undefined && !czyObiekt(o.assets)) throw new Error('nieprawidłowa sekcja "assets"');
    return o;
  }

  zastosujStan(o) {
    this.rev = Number.isInteger(o.rev) && o.rev >= 0 ? o.rev : 0;
    this.revZapisany = this.rev;
    this.kolekcje = new Map();
    for (const [c, docs] of Object.entries(o.collections)) this.kolekcje.set(c, new Map(Object.entries(docs)));
    this.zalaczniki = new Map();
    for (const [id, a] of Object.entries(o.assets || {})) {
      if (ASSET_ID_RE.test(id) && czyObiekt(a)) this.zalaczniki.set(id, { contentType: String(a.contentType || 'application/octet-stream'), sizeBytes: Number(a.sizeBytes) || 0, createdAt: Number(a.createdAt) || 0 });
    }
  }

  wczytaj() {
    if (!fs.existsSync(this.plik)) {
      const kopie = this.listaKopii();
      if (kopie.length) this.log.warn(`Uwaga: brak pliku ${this.plik}, ale istnieją kopie w ${this.dirKopie}. Startuję z pustą bazą — aby przywrócić dane, skopiuj wybraną kopię jako baza.json i uruchom serwer ponownie.`);
      return { przywrocono: false };
    }
    const tekst = fs.readFileSync(this.plik, 'utf8'); // błąd dysku/uprawnień — przerywamy start
    try { this.zastosujStan(Baza.parsuj(tekst)); }
    catch (e) { return this.odzyskaj(e); }             // treść nieczytelna — odzyskujemy z kopii
    this.ostatnioZapisany = tekst;
    return { przywrocono: false };
  }

  odzyskaj(przyczyna) {
    const odlozony = path.join(this.dir, `baza.uszkodzona-${znacznikCzasu()}.json`);
    fs.renameSync(this.plik, odlozony);
    const linia = '!'.repeat(78);
    const msg = [linia, '!!  UWAGA: plik bazy danych jest USZKODZONY i nie da się go odczytać.',
      `!!  Przyczyna: ${przyczyna && przyczyna.message}`,
      `!!  Uszkodzony plik odłożono jako: ${odlozony}`];
    for (const f of this.listaKopii().reverse()) {
      const p = path.join(this.dirKopie, f);
      try {
        const o = Baza.parsuj(fs.readFileSync(p, 'utf8'));
        this.zastosujStan(o);
        this.odtworzPlikiZalacznikow(o.logos);
        this.ostatnioZapisany = this.serializuj();
        zapiszAtomowo(this.plik, this.ostatnioZapisany);
        msg.push(`!!  PRZYWRÓCONO dane z kopii: ${p}`, '!!  Zmiany wprowadzone po utworzeniu tej kopii mogły zostać utracone.', linia);
        this.log.error(msg.join('\n'));
        return { przywrocono: true, zKopii: p, odlozony };
      } catch (e) {
        msg.push(`!!  Kopia ${f} też jest nieczytelna (${e.message}) — próbuję starszej.`);
      }
    }
    this.zastosujStan({ rev: 0, collections: {} });
    msg.push('!!  Nie znaleziono żadnej poprawnej kopii — startuję z PUSTĄ bazą.', linia);
    this.log.error(msg.join('\n'));
    return { przywrocono: false, odlozony };
  }

  /** Kopia w formacie aplikacji niesie loga jako data URL — brakujące pliki w zalaczniki/ odtwarzamy z niej. */
  odtworzPlikiZalacznikow(logos) {
    if (!czyObiekt(logos)) return;
    for (const [id, du] of Object.entries(logos)) {
      const plik = path.join(this.dirZal, id);
      const d = dataUrlNaBufor(du);
      if (!ASSET_ID_RE.test(id) || !d || fs.existsSync(plik)) continue;
      try { zapiszAtomowo(plik, d.buf); } catch (e) { this.log.error(`Nie udało się odtworzyć logo ${id}: ${e.message}`); }
    }
  }

  serializuj() {
    // czytelny JSON: jeden dokument w wierszu (łatwo podejrzeć / naprawić ręcznie)
    const linie = ['{"format":"ewidencja-palet","wersja":1,', `"rev":${this.rev},"zapisano":${JSON.stringify(new Date().toISOString())},`, '"collections":{'];
    const kol = [...this.kolekcje.entries()].filter(([, m]) => m.size > 0);
    kol.forEach(([c, m], i) => {
      linie.push(`${JSON.stringify(c)}:{`);
      const docs = [...m.entries()].map(([id, d]) => `${JSON.stringify(id)}:${JSON.stringify(d)}`);
      linie.push(docs.join(',\n'));
      linie.push(i < kol.length - 1 ? '},' : '}');
    });
    linie.push('},', '"assets":{');
    linie.push([...this.zalaczniki.entries()].map(([id, a]) => `${JSON.stringify(id)}:${JSON.stringify(a)}`).join(',\n'));
    linie.push('}}');
    return linie.join('\n') + '\n';
  }

  /* --- trwały zapis: „group commit” ---
     Zmiany trafiają najpierw do pamięci, a potem jeden zapis atomowy pliku obejmuje wszystkie zmiany,
     które przyszły w tym czasie (np. 6 równoległych zapisów przy wczytywaniu kopii = 1 zapis pliku).
     Każde żądanie dostaje odpowiedź dopiero, gdy JEGO zmiana jest już bezpiecznie na dysku.
     Jeśli zapis się nie uda, stan w pamięci wraca do ostatnio zapisanego, a żądania dostają błąd. */
  utrwal() {
    return new Promise((resolve, reject) => {
      this.oczekujace.push({ resolve, reject });
      if (!this.petla) this.petla = this.petlaZapisu();
    });
  }

  async petlaZapisu() {
    await new Promise((r) => setImmediate(r)); // dołącz zapisy, które przyszły w tej samej chwili
    for (;;) {
      if (!this.oczekujace.length) { this.petla = null; return; }
      const grupa = this.oczekujace.splice(0);
      const wersja = this.wersjaStanu, rev = this.rev;
      const tekst = this.serializuj();
      this.kopiaDzienna(); // kopia stanu sprzed pierwszej zmiany dnia
      try {
        await zapiszAtomowoAsync(this.plik, tekst);
        this.ostatnioZapisany = tekst; this.wersjaZapisana = wersja; this.revZapisany = rev; this.liczbaZapisow++;
        for (const w of grupa) w.resolve();
      } catch (e) {
        this.log.error(`BŁĄD ZAPISU BAZY (${this.plik}): ${e.message}`);
        const wszyscy = grupa.concat(this.oczekujace.splice(0));
        this.przywrocOstatniZapisany();
        const blad = e.code === 'ENOSPC'
          ? bladApi(507, 'quota_exceeded', 'Brak miejsca na dysku serwera — zmiany nie zostały zapisane')
          : bladApi(500, 'storage_failed', 'Nie udało się zapisać danych na dysku serwera');
        for (const w of wszyscy) w.reject(blad);
      }
    }
  }

  przywrocOstatniZapisany() {
    try { this.zastosujStan(this.ostatnioZapisany ? Baza.parsuj(this.ostatnioZapisany) : { rev: 0, collections: {} }); }
    catch (e) { this.log.error(`Nie udało się przywrócić stanu: ${e.message}`); }
    this.wersjaStanu = this.wersjaZapisana;
  }

  /** Czeka, aż wszystko, co jest w pamięci, będzie na dysku (dla odczytów całej bazy). */
  poZapisie() { return this.wersjaStanu === this.wersjaZapisana ? Promise.resolve() : this.utrwal().catch(() => {}); }

  listaKopii() {
    try { return fs.readdirSync(this.dirKopie).filter(f => /^baza-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch (e) { return []; }
  }

  /**
   * Kopia dzienna: stan bazy z początku dnia (sprzed pierwszej zmiany tego dnia), w formacie kopii
   * aplikacji — razem z logami — więc da się ją wczytać w aplikacji („Wczytaj kopię z pliku”) albo
   * posłuży serwerowi do odtworzenia uszkodzonego baza.json.
   */
  kopiaDzienna() {
    const dzien = dzisiaj();
    if (this.dzienKopii === dzien) return;
    if (!fs.existsSync(this.plik)) return; // nic jeszcze nie zapisano
    const cel = path.join(this.dirKopie, `baza-${dzien}.json`);
    try {
      if (!fs.existsSync(cel)) {
        const stan = Baza.parsuj(this.ostatnioZapisany !== null ? this.ostatnioZapisany : fs.readFileSync(this.plik, 'utf8'));
        zapiszAtomowo(cel, JSON.stringify(doKopiiAplikacji(stan, this.dirZal), null, 1));
      }
      this.dzienKopii = dzien;
      const kopie = this.listaKopii();
      for (const f of kopie.slice(0, Math.max(0, kopie.length - KOPII_DZIENNYCH))) fs.unlinkSync(path.join(this.dirKopie, f));
    } catch (e) { this.log.error(`Nie udało się utworzyć kopii dziennej: ${e.message}`); }
  }

  snapshot() {
    const collections = {};
    for (const [c, m] of this.kolekcje) if (m.size) ustaw(collections, c, Object.fromEntries(m));
    const assets = [...this.zalaczniki.entries()].map(([id, a]) => ({ id, contentType: a.contentType, sizeBytes: a.sizeBytes, createdAt: a.createdAt }));
    return { rev: this.rev, collections, assets };
  }

  /**
   * Waliduje i atomowo stosuje listę zapisów. Albo wszystkie, albo żaden.
   * Zwraca listę zmian [{op, coll, id, rev, data|null}] (bez operacji nic-nie-robiących).
   */
  zastosuj(zapisy) {
    // 1) walidacja
    for (let i = 0; i < zapisy.length; i++) {
      const w = zapisy[i]; const gdzie = zapisy.length > 1 ? ` (zapis #${i})` : '';
      if (!czyObiekt(w)) throw bladApi(400, 'invalid_argument', `Zapis musi być obiektem${gdzie}`);
      if (!OPS.has(w.op)) throw bladApi(400, 'invalid_argument', `Nieznana operacja "${w.op}"${gdzie}`);
      if (!poprawneId(w.coll)) throw bladApi(400, 'invalid_argument', `Nieprawidłowa nazwa kolekcji${gdzie}`);
      if (!poprawneId(w.id)) throw bladApi(400, 'invalid_argument', `Nieprawidłowy identyfikator dokumentu${gdzie}`);
      if (w.op !== 'delete' && !czyObiekt(w.data)) throw bladApi(400, 'invalid_argument', `Pole "data" musi być obiektem${gdzie}`);
    }
    // 2) wyliczenie nowych wartości na „nakładce”, bez ruszania bazy
    const nakladka = new Map(); // "coll\u0000id" -> data|null
    const klucz = (c, id) => `${c}\u0000${id}`;
    const obecny = (c, id) => { const k = klucz(c, id); if (nakladka.has(k)) return nakladka.get(k); const m = this.kolekcje.get(c); return m && m.has(id) ? m.get(id) : null; };
    const plan = [];
    zapisy.forEach((w, i) => {
      const stary = obecny(w.coll, w.id);
      let nowy;
      if (w.op === 'set') nowy = bezZnacznikowUsun(klon(w.data));
      else if (w.op === 'update') {
        if (!stary) { const e = bladApi(404, 'not_found', `Dokument ${w.coll}/${w.id} nie istnieje`); e.index = i; throw e; }
        nowy = scal(stary, klon(w.data));
      } else { if (!stary) return; nowy = null; }
      nakladka.set(klucz(w.coll, w.id), nowy);
      plan.push({ op: w.op, coll: w.coll, id: w.id, data: nowy });
    });
    if (!plan.length) return [];
    // 3) zatwierdzenie w pamięci (trwały zapis: await baza.utrwal() — dopiero potem odpowiedź i SSE)
    for (const p of plan) {
      let m = this.kolekcje.get(p.coll);
      if (!m) { m = new Map(); this.kolekcje.set(p.coll, m); }
      if (p.data === null) m.delete(p.id); else m.set(p.id, p.data);
      p.rev = ++this.rev;
    }
    this.wersjaStanu++;
    return plan;
  }

  async dodajZalacznik(buf, contentType) {
    let id; do { id = noweId(); } while (this.zalaczniki.has(id));
    const plik = path.join(this.dirZal, id);
    await zapiszAtomowoAsync(plik, buf);
    const meta = { contentType, sizeBytes: buf.length, createdAt: Date.now() };
    this.zalaczniki.set(id, meta); this.wersjaStanu++;
    try { await this.utrwal(); }
    catch (e) { await fs.promises.unlink(plik).catch(() => {}); throw e; }
    return { id, ...meta };
  }

  async usunZalacznik(id) {
    if (!this.zalaczniki.has(id)) return false;
    this.zalaczniki.delete(id); this.wersjaStanu++;
    await this.utrwal();
    await fs.promises.unlink(path.join(this.dirZal, id)).catch(() => {}); // plik mógł już zniknąć
    return true;
  }

  /** Pełna kopia bieżącego stanu w formacie aplikacji (GET /api/kopia). */
  kopiaDoPobrania() {
    const s = this.snapshot();
    const assets = {};
    for (const [id, a] of this.zalaczniki) ustaw(assets, id, a);
    return doKopiiAplikacji({ rev: s.rev, collections: s.collections, assets }, this.dirZal);
  }
}

/* ---------------------------- format kopii aplikacji ----------------------------
   Ten sam plik, który daje „Ustawienia i kopia → Pobierz kopię (.json)” (w każdej wersji):
     {app:'ewidencja-palet', format:1, exportedAt, source, couriers:[{id,...}], transactions:[{id,...}],
      meta:{counters}, logos:{<id logo>: 'data:image/…;base64,…'}}
   Dodatkowo (aplikacja te pola pomija): rev oraz pozostale = dokumenty spoza kurierów/operacji/liczników
   (np. meta/settings), żeby odtworzenie bazy przez serwer niczego nie gubiło. */
function dataUrlNaBufor(du) {
  const m = typeof du === 'string' && /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(;[^,]*)?,(.*)$/is.exec(du);
  if (!m) return null;
  const base64 = /;base64/i.test(m[2] || '');
  try { return { contentType: m[1].toLowerCase(), buf: base64 ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8') }; } catch (e) { return null; }
}
function doKopiiAplikacji(stan, dirZal) {
  const kol = stan.collections || {};
  const zId = (docs) => Object.entries(docs || {}).map(([id, d]) => ({ id, ...d }));
  const couriers = zId(kol.couriers).sort((a, b) => (Number.isFinite(a.order) ? a.order : 999) - (Number.isFinite(b.order) ? b.order : 999));
  const transactions = zId(kol.transactions);
  const meta = kol.meta || {};
  const pozostale = {};
  for (const [c, docs] of Object.entries(kol)) {
    if (c === 'couriers' || c === 'transactions') continue;
    for (const [id, d] of Object.entries(docs)) {
      if (c === 'meta' && id === 'counters') continue;
      ustaw(grupa(pozostale, c), id, d);
    }
  }
  const logos = {};
  const assets = stan.assets || {};
  for (const c of couriers) {
    const id = c.logoAssetId;
    const ma = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    if (typeof id !== 'string' || !ASSET_ID_RE.test(id) || ma(logos, id)) continue;
    try {
      const typ = (ma(assets, id) && assets[id].contentType) || 'application/octet-stream';
      ustaw(logos, id, `data:${typ};base64,${fs.readFileSync(path.join(dirZal, id)).toString('base64')}`);
    } catch (e) { /* brak pliku logo — kopia bez niego */ }
  }
  return {
    app: APP, format: 1, exportedAt: new Date().toISOString(), source: 'server', appVersion: `serwer ${VERSION}`,
    couriers, transactions, meta: { counters: meta.counters || {} }, logos,
    rev: stan.rev || 0, pozostale,
  };
}
function zKopiiAplikacji(k) {
  const collections = {};
  const dodaj = (c, id, d) => {
    if (!poprawneId(c) || !poprawneId(id) || !czyObiekt(d)) throw new Error(`nieprawidłowy wpis "${c}/${id}"`);
    ustaw(grupa(collections, c), id, d);
  };
  const bezId = (x) => { const o = {}; for (const [kk, v] of Object.entries(x)) if (kk !== 'id' && v !== undefined) ustaw(o, kk, v); return o; };
  for (const c of k.couriers) { if (!czyObiekt(c)) throw new Error('nieprawidłowy kurier'); dodaj('couriers', c.id, bezId(c)); }
  for (const t of k.transactions) { if (!czyObiekt(t)) throw new Error('nieprawidłowa operacja'); dodaj('transactions', t.id, bezId(t)); }
  if (czyObiekt(k.pozostale)) for (const [c, docs] of Object.entries(k.pozostale)) if (czyObiekt(docs)) for (const [id, d] of Object.entries(docs)) dodaj(c, id, d);
  if (k.meta && czyObiekt(k.meta.counters) && Object.keys(k.meta.counters).length) dodaj('meta', 'counters', k.meta.counters);
  const assets = {};
  if (czyObiekt(k.logos)) {
    for (const [id, du] of Object.entries(k.logos)) {
      const d = dataUrlNaBufor(du);
      if (ASSET_ID_RE.test(id) && d) ustaw(assets, id, { contentType: d.contentType, sizeBytes: d.buf.length, createdAt: 0 });
    }
  }
  return { rev: Number.isInteger(k.rev) && k.rev >= 0 ? k.rev : 0, collections, assets, logos: k.logos };
}

function bladApi(status, code, message) { const e = new Error(message); e.status = status; e.code = code; e.api = true; return e; }

/* ---------------------------- HTTP ---------------------------- */
// Celowo bez .json i .md: w folderze aplikacji leżą często pobrane kopie zapasowe (*.json) — nie serwujemy ich.
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf',
};
// foldery/pliki, których nigdy nie serwujemy (oprócz plików z kropką i DATA_DIR)
const ZAKAZANE = new Set(['server.js', 'node_modules', 'testy', 'narzedzia', 'dane', 'zrodlo']);

function wyslijJson(res, status, obj, naglowki) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...(naglowki || {}) });
  res.end(body);
}
function wyslijTekst(res, status, tekst, naglowki) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(tekst), ...(naglowki || {}) });
  res.end(tekst);
}

/** Czyta ciało żądania do limitu. Przy przekroczeniu: odczytuje resztę „w próżnię” i zgłasza 413. */
function czytajCialo(req, limit) {
  return new Promise((resolve, reject) => {
    const zadeklarowane = Number(req.headers['content-length']);
    const kawalki = []; let rozmiar = 0; let zaDuzo = Number.isFinite(zadeklarowane) && zadeklarowane > limit;
    req.on('data', (c) => {
      rozmiar += c.length;
      if (zaDuzo) { if (rozmiar > limit * 16) req.destroy(); return; }
      if (rozmiar > limit) { zaDuzo = true; kawalki.length = 0; return; }
      kawalki.push(c);
    });
    req.on('end', () => zaDuzo ? reject(bladApi(413, 'too_large', `Za duże dane (limit ${Math.round(limit / 1024 / 1024)} MB)`)) : resolve(Buffer.concat(kawalki)));
    req.on('error', reject);
  });
}
async function czytajJson(req) {
  // Wymagamy application/json: inna strona otwarta w przeglądarce nie może wtedy wysłać „prostego”
  // żądania POST (formularz / text/plain) do tego serwera — przeglądarka zażąda zgody CORS, której nie dajemy.
  const ct = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(ct)) { req.resume(); throw bladApi(415, 'invalid_argument', 'Oczekiwano Content-Type: application/json'); }
  const buf = await czytajCialo(req, LIMIT_BODY);
  try { return JSON.parse(buf.toString('utf8')); } catch (e) { throw bladApi(400, 'invalid_argument', 'Nieprawidłowy JSON'); }
}

function stworzSerwer(cfg, log) {
  const baza = new Baza(cfg.dataDir, log);
  const klienciSse = new Set();
  const dzierzawy = new Map();   // "coll\u0000id" -> {holder, exp, ver} — krótkie dzierżawy acquire() (tylko w pamięci)
  const serverId = noweId(12);
  let dataDirReal = cfg.dataDir; let rootReal = ROOT;

  function rozeslij(zmiany, clientId) {
    for (const z of zmiany) {
      const linia = `event: change\ndata: ${JSON.stringify({ rev: z.rev, coll: z.coll, id: z.id, data: z.data, clientId: clientId || null })}\n\n`;
      for (const res of klienciSse) res.write(linia);
    }
  }

  function autoryzowany(req) {
    if (!cfg.haslo) return true;
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(String(req.headers.authorization || ''));
    if (!m) return false;
    const dek = Buffer.from(m[1], 'base64').toString('utf8');
    const i = dek.indexOf(':'); if (i < 0) return false;
    const h = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();
    return crypto.timingSafeEqual(h(dek.slice(i + 1)), h(cfg.haslo));
  }

  async function obsluzApi(req, res, sciezka) {
    const metoda = req.method;
    if (sciezka === '/api/ping') {
      if (metoda !== 'GET' && metoda !== 'HEAD') throw bladApi(405, 'method_not_allowed', 'Dozwolone: GET');
      return wyslijJson(res, 200, { app: APP, version: VERSION, mode: 'server' });
    }
    if (sciezka === '/api/snapshot') {
      if (metoda !== 'GET') throw bladApi(405, 'method_not_allowed', 'Dozwolone: GET');
      await baza.poZapisie(); // nie pokazuj zmian, które jeszcze nie są na dysku
      return wyslijJson(res, 200, { ...baza.snapshot(), serverId, version: VERSION });
    }
    if (sciezka === '/api/write') {
      if (metoda !== 'POST') throw bladApi(405, 'method_not_allowed', 'Dozwolone: POST');
      const w = await czytajJson(req);
      if (!czyObiekt(w)) throw bladApi(400, 'invalid_argument', 'Oczekiwano obiektu JSON');
      const clientId = typeof w.clientId === 'string' ? w.clientId.slice(0, 100) : null;
      const zmiany = baza.zastosuj([{ op: w.op, coll: w.coll, id: w.id, data: w.data }]);
      if (zmiany.length) await baza.utrwal();   // odpowiedź dopiero po trwałym zapisie
      rozeslij(zmiany, clientId);
      const z = zmiany[0];
      // rev TEGO zapisu (nie bieżący globalny — w międzyczasie mogły dojść inne zapisy)
      return wyslijJson(res, 200, { ok: true, rev: z ? z.rev : baza.rev, data: z ? z.data : null, changed: !!z });
    }
    if (sciezka === '/api/batch') {
      if (metoda !== 'POST') throw bladApi(405, 'method_not_allowed', 'Dozwolone: POST');
      const b = await czytajJson(req);
      if (!czyObiekt(b) || !Array.isArray(b.writes)) throw bladApi(400, 'invalid_argument', 'Oczekiwano {writes:[...]}');
      if (b.writes.length > LIMIT_BATCH) throw bladApi(400, 'invalid_argument', `Za dużo zapisów w paczce (maks. ${LIMIT_BATCH})`);
      const clientId = typeof b.clientId === 'string' ? b.clientId.slice(0, 100) : null;
      const zmiany = baza.zastosuj(b.writes);
      if (zmiany.length) await baza.utrwal();
      rozeslij(zmiany, clientId);
      return wyslijJson(res, 200, { ok: true, rev: zmiany.length ? zmiany[zmiany.length - 1].rev : baza.rev, results: zmiany.map(z => ({ op: z.op, coll: z.coll, id: z.id, rev: z.rev, data: z.data })) });
    }
    if (sciezka === '/api/acquire') {
      // kooperacyjna dzierżawa dokumentu (DocumentReference.acquire na platformie Claude): zajęta przez
      // innego posiadacza i ważna → {acquired:false, expiresAt}; wolna/wygasła/własna → przyznana (odnowiona)
      if (metoda !== 'POST') throw bladApi(405, 'method_not_allowed', 'Dozwolone: POST');
      const b = await czytajJson(req);
      if (!czyObiekt(b)) throw bladApi(400, 'invalid_argument', 'Oczekiwano obiektu JSON');
      if (!poprawneId(b.coll) || !poprawneId(b.id)) throw bladApi(400, 'invalid_argument', 'Nieprawidłowa ścieżka dokumentu');
      if (typeof b.holder !== 'string' || !b.holder || b.holder.length > 200) throw bladApi(400, 'invalid_argument', 'Wymagane pole "holder" (1–200 znaków)');
      if (b.data !== undefined && b.data !== null && !czyObiekt(b.data)) throw bladApi(400, 'invalid_argument', 'Pole "data" musi być obiektem');
      const ttl = Math.min(600000, Math.max(1000, Number(b.ttlMs) || 30000));
      const teraz = Date.now(), klucz = `${b.coll}\u0000${b.id}`, obecna = dzierzawy.get(klucz);
      if (obecna && obecna.holder !== b.holder && obecna.exp > teraz) return wyslijJson(res, 200, { acquired: false, expiresAt: new Date(obecna.exp).toISOString() });
      if (dzierzawy.size > 1000) for (const [k, d] of dzierzawy) if (d.exp <= teraz) dzierzawy.delete(k);
      const moja = { holder: b.holder, exp: teraz + ttl, ver: (obecna ? obecna.ver : 0) + 1 };
      dzierzawy.set(klucz, moja); // przed jakimkolwiek await — drugie żądanie już widzi dzierżawę
      let change = null;
      if (b.data && Object.keys(b.data).length) {
        const m = baza.kolekcje.get(b.coll);
        const zmiany = baza.zastosuj([{ op: m && m.has(b.id) ? 'update' : 'set', coll: b.coll, id: b.id, data: b.data }]);
        try { if (zmiany.length) await baza.utrwal(); }
        catch (e) { if (dzierzawy.get(klucz) === moja) dzierzawy.delete(klucz); throw e; }
        rozeslij(zmiany, typeof b.clientId === 'string' ? b.clientId.slice(0, 100) : null);
        if (zmiany.length) change = { coll: b.coll, id: b.id, rev: zmiany[0].rev, data: zmiany[0].data };
      }
      return wyslijJson(res, 200, { acquired: true, version: moja.ver, expiresAt: new Date(moja.exp).toISOString(), holder: b.holder, change });
    }
    if (sciezka === '/api/events') {
      if (metoda !== 'GET') throw bladApi(405, 'method_not_allowed', 'Dozwolone: GET');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // nginx / reverse proxy Synology: nie buforuj
      });
      req.socket.setTimeout(0); req.socket.setNoDelay(true); req.socket.setKeepAlive(true, 20000);
      res.write(`:${' '.repeat(2048)}\n`); // „rozpycha” bufory niektórych proxy
      res.write('retry: 2000\n\n');
      res.write(`event: hello\ndata: ${JSON.stringify({ rev: baza.revZapisany, serverId })}\n\n`);
      klienciSse.add(res);
      const koniec = () => klienciSse.delete(res);
      req.on('close', koniec); res.on('error', koniec);
      return undefined;
    }
    if (sciezka === '/api/assets') {
      if (metoda === 'GET') await baza.poZapisie();
      if (metoda === 'GET') return wyslijJson(res, 200, { assets: baza.snapshot().assets.map(a => ({ ...a, url: `/_blob/${a.id}` })), usage: { bytes: [...baza.zalaczniki.values()].reduce((s, a) => s + a.sizeBytes, 0) } });
      if (metoda !== 'POST') throw bladApi(405, 'method_not_allowed', 'Dozwolone: GET, POST');
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!/^image\/[a-z0-9.+-]+$/.test(ct)) { req.resume(); throw bladApi(415, 'invalid_argument', 'Dozwolone są tylko obrazy (image/*)'); }
      const buf = await czytajCialo(req, LIMIT_ASSET);
      if (!buf.length) throw bladApi(400, 'invalid_argument', 'Pusty plik');
      const a = await baza.dodajZalacznik(buf, ct);
      return wyslijJson(res, 200, { id: a.id, url: `/_blob/${a.id}`, sizeBytes: a.sizeBytes, contentType: a.contentType, createdAt: a.createdAt });
    }
    const mA = /^\/api\/assets\/([^/]+)$/.exec(sciezka);
    if (mA) {
      if (metoda !== 'DELETE') throw bladApi(405, 'method_not_allowed', 'Dozwolone: DELETE');
      const id = decodeURIComponent(mA[1]);
      if (!ASSET_ID_RE.test(id)) throw bladApi(400, 'invalid_argument', 'Nieprawidłowy identyfikator');
      const byl = await baza.usunZalacznik(id);
      return wyslijJson(res, 200, { ok: true, existed: byl });
    }
    if (sciezka === '/api/kopia') {
      if (metoda !== 'GET') throw bladApi(405, 'method_not_allowed', 'Dozwolone: GET');
      await baza.poZapisie();
      const body = JSON.stringify(baza.kopiaDoPobrania(), null, 1);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="ewidencja-palet-kopia-${dzisiaj()}.json"`,
        'Content-Length': Buffer.byteLength(body),
      });
      return res.end(body);
    }
    throw bladApi(404, 'not_found', 'Nieznany adres API');
  }

  function obsluzBlob(req, res, id) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return wyslijTekst(res, 405, 'Metoda niedozwolona');
    const meta = ASSET_ID_RE.test(id) ? baza.zalaczniki.get(id) : null;
    if (!meta) return wyslijTekst(res, 404, 'Nie znaleziono');
    const plik = path.join(baza.dirZal, id);
    let st; try { st = fs.statSync(plik); } catch (e) { return wyslijTekst(res, 404, 'Nie znaleziono'); }
    const etag = `"${id}"`;
    const nag = {
      'Content-Type': meta.contentType, 'Content-Length': st.size, 'ETag': etag,
      'Cache-Control': 'private, max-age=31536000, immutable',
      // obraz SVG otwarty bezpośrednio nie może uruchomić skryptów
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { 'ETag': etag, 'Cache-Control': nag['Cache-Control'] }); return res.end(); }
    res.writeHead(200, nag);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(plik).on('error', () => res.destroy()).pipe(res);
    return undefined;
  }

  function wewnatrz(rodzic, p) { const r = path.relative(rodzic, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); }

  function obsluzStatyczne(req, res, sciezkaSurowa) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return wyslijTekst(res, 405, 'Metoda niedozwolona', { Allow: 'GET, HEAD' });
    let sc;
    try { sc = decodeURIComponent(sciezkaSurowa); } catch (e) { return wyslijTekst(res, 400, 'Nieprawidłowy adres'); }
    if (sc.includes('\0') || sc.includes('\\')) return wyslijTekst(res, 404, 'Nie znaleziono');
    if (sc === '/') sc = '/index.html';
    const segmenty = sc.split('/').filter(Boolean);
    if (!segmenty.length || segmenty.some(s => s.startsWith('.') || s.includes(':'))) return wyslijTekst(res, 404, 'Nie znaleziono');
    if (ZAKAZANE.has(segmenty[0].toLowerCase())) return wyslijTekst(res, 404, 'Nie znaleziono');
    const pelna = path.join(ROOT, ...segmenty);
    const typ = MIME[path.extname(pelna).toLowerCase()];
    if (!typ || !wewnatrz(ROOT, pelna)) return wyslijTekst(res, 404, 'Nie znaleziono');
    let real, st;
    try { real = fs.realpathSync(pelna); st = fs.statSync(real); } catch (e) {
      if (sc === '/favicon.ico') { res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' }); return res.end(); }
      if (sc === '/index.html') return wyslijTekst(res, 500, 'Brak pliku index.html — zbuduj go poleceniem:  node narzedzia/zbuduj.js');
      return wyslijTekst(res, 404, 'Nie znaleziono');
    }
    if (!st.isFile() || !wewnatrz(rootReal, real) || wewnatrz(dataDirReal, real) || real === path.join(rootReal, 'server.js')) return wyslijTekst(res, 404, 'Nie znaleziono');
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const dlugo = /^font\//.test(typ);
    const nag = {
      'Content-Type': typ, 'Content-Length': st.size, 'ETag': etag, 'Last-Modified': st.mtime.toUTCString(),
      'Cache-Control': dlugo ? 'public, max-age=604800' : 'no-cache',
      'Referrer-Policy': 'no-referrer',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { 'ETag': etag, 'Cache-Control': nag['Cache-Control'] }); return res.end(); }
    res.writeHead(200, nag);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
    return undefined;
  }

  const serwer = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    let sciezka;
    try { sciezka = new URL(req.url, 'http://localhost').pathname; } catch (e) { return wyslijTekst(res, 400, 'Nieprawidłowy adres'); }
    if (!autoryzowany(req)) {
      req.resume();
      return wyslijTekst(res, 401, 'Podaj hasło, aby otworzyć Ewidencję Palet.', { 'WWW-Authenticate': 'Basic realm="Ewidencja Palet", charset="UTF-8"' });
    }
    try {
      if (sciezka.startsWith('/api/')) return await obsluzApi(req, res, sciezka);
      if (sciezka.startsWith('/_blob/')) return obsluzBlob(req, res, decodeURIComponent(sciezka.slice(7)));
      return obsluzStatyczne(req, res, sciezka);
    } catch (e) {
      if (!e.api) log.error(`Błąd obsługi ${req.method} ${sciezka}: ${e.stack || e.message}`);
      if (res.headersSent) { res.destroy(); return undefined; }
      const status = e.api ? e.status : 500;
      const body = { error: e.api ? e.code : 'internal', message: e.api ? e.message : 'Wewnętrzny błąd serwera' };
      if (e.index !== undefined) body.index = e.index;
      return wyslijJson(res, status, body, status === 413 ? { Connection: 'close' } : undefined);
    }
  });
  serwer.keepAliveTimeout = 65000; // dłużej niż typowe proxy (60 s)
  serwer.headersTimeout = 66000;

  let heartbeat = null;
  function start() {
    baza.przygotujKatalogi();
    dataDirReal = fs.realpathSync(cfg.dataDir); rootReal = fs.realpathSync(ROOT);
    const wynik = baza.wczytaj();
    baza.kopiaDzienna();
    heartbeat = setInterval(() => {
      const linia = `event: ping\ndata: ${JSON.stringify({ rev: baza.rev, t: Date.now() })}\n\n`;
      for (const res of klienciSse) res.write(linia);
    }, cfg.heartbeatMs);
    heartbeat.unref();
    return wynik;
  }
  function zatrzymaj() {
    if (heartbeat) clearInterval(heartbeat);
    for (const res of klienciSse) { try { res.end(); } catch (e) { /* ignore */ } }
    klienciSse.clear();
  }
  return { serwer, baza, start, zatrzymaj, klienciSse };
}

/* ---------------------------- uruchomienie ---------------------------- */
function adresyLan() {
  const out = [];
  for (const [nazwa, lista] of Object.entries(os.networkInterfaces())) {
    for (const a of lista || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) out.push({ nazwa, adres: a.address });
    }
  }
  return out;
}

function otworzPrzegladarke(url) {
  try {
    let p;
    if (process.platform === 'darwin') p = spawn('open', [url], { stdio: 'ignore', detached: true });
    else if (process.platform === 'win32') p = spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true, windowsVerbatimArguments: true });
    else p = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    p.on('error', () => console.log(`(Nie udało się otworzyć przeglądarki — wejdź ręcznie na ${url})`));
    p.unref();
  } catch (e) { console.log(`(Nie udało się otworzyć przeglądarki — wejdź ręcznie na ${url})`); }
}

function pingLokalny(port, haslo) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1500, auth: haslo ? `x:${haslo}` : undefined }, (res) => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b).app === APP); } catch (e) { resolve(false); } });
    });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Docker / Synology: folder ./dane podpięty z NAS-a należy zwykle do użytkownika DSM, a gdy go nie ma —
 * Docker tworzy go jako root. Kontener uruchomiony jako root z EP_UZYTKOWNIK=auto (albo "UID:GID")
 * nadaje folderowi danych właściciela i NATYCHMIAST przechodzi na zwykłego użytkownika.
 * auto = właściciel folderu danych (np. Twój użytkownik DSM), a jeśli to root — użytkownik "node" (1000).
 * Bez EP_UZYTKOWNIK albo gdy proces nie jest rootem — nic nie robi.
 */
function zrzucUprawnienia(cfg, env) {
  const spec = env.EP_UZYTKOWNIK;
  if (!spec || typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  let uid, gid;
  if (spec === 'auto') {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const st = fs.statSync(cfg.dataDir);
    if (st.uid !== 0) { uid = st.uid; gid = st.gid; } else { uid = 1000; gid = 1000; }
  } else {
    const m = /^(\d+)(?::(\d+))?$/.exec(spec.trim());
    if (!m) throw new Error(`EP_UZYTKOWNIK: oczekiwano "auto" albo "UID:GID", jest "${spec}".`);
    uid = Number(m[1]); gid = Number(m[2] !== undefined ? m[2] : m[1]);
  }
  if (uid === 0) return null;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  (function chownR(p) {
    const st = fs.lstatSync(p);
    if (st.uid !== uid || st.gid !== gid) fs.lchownSync(p, uid, gid);
    if (st.isDirectory()) for (const f of fs.readdirSync(p)) chownR(path.join(p, f));
  })(cfg.dataDir);
  if (process.setgroups) process.setgroups([gid]);
  process.setgid(gid);
  process.setuid(uid);
  return { uid, gid };
}

function main() {
  const log = { warn: (m) => console.warn(m), error: (m) => console.error(m) };
  let cfg;
  try { cfg = konfiguracja(process.env, process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
  try {
    const kto = zrzucUprawnienia(cfg, process.env);
    if (kto) console.log(`Uprawnienia: serwer działa jako użytkownik uid=${kto.uid}, gid=${kto.gid} (właściciel folderu danych).`);
  } catch (e) { console.error(`BŁĄD przy zmianie użytkownika (EP_UZYTKOWNIK): ${e.message}`); process.exit(1); }
  const { serwer, start, zatrzymaj, baza } = stworzSerwer(cfg, log);
  try { start(); }
  catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') {
      console.error([
        `BŁĄD: brak uprawnień do zapisu w folderze danych: ${cfg.dataDir}`,
        `  (${e.message})`,
        '  Co zrobić:',
        '   • nadaj uprawnienia do zapisu temu folderowi, albo wskaż inny folder: DATA_DIR=/sciezka node server.js',
        '   • Docker/Synology: kontener działa jako użytkownik "node" (uid 1000). Nadaj zapis folderowi ./dane',
        '     (np. w File Station: Właściwości → Uprawnienia → Wszyscy: Odczyt/Zapis) albo ustaw w docker-compose.yml',
        '     „user: "UID:GID"” swojego użytkownika (sprawdzisz poleceniem: id).',
      ].join('\n'));
    } else console.error(`BŁĄD startu serwera: ${e.stack || e.message}`);
    process.exit(1);
  }

  serwer.on('error', async (e) => {
    if (e.code === 'EADDRINUSE') {
      if (await pingLokalny(cfg.port, cfg.haslo)) {
        const url = `http://localhost:${cfg.port}`;
        console.log(`Ewidencja Palet już działa pod adresem ${url} — nie uruchamiam drugiej kopii.`);
        if (cfg.otworz) otworzPrzegladarke(url);
        process.exit(0);
      }
      console.error(`BŁĄD: port ${cfg.port} jest zajęty przez inny program.\n  Zamknij ten program albo uruchom serwer na innym porcie, np.:  PORT=8081 node server.js  (Windows: set PORT=8081 && node server.js)`);
    } else if (e.code === 'EACCES') {
      console.error(`BŁĄD: brak uprawnień do portu ${cfg.port}. Porty poniżej 1024 wymagają uprawnień administratora — użyj np. PORT=8080.`);
    } else console.error(`BŁĄD serwera: ${e.message}`);
    process.exit(1);
  });

  serwer.listen(cfg.port, cfg.host, () => {
    const port = serwer.address().port;
    const tylkoLokalnie = cfg.host === '127.0.0.1' || cfg.host === 'localhost' || cfg.host === '::1';
    const linie = ['', '  Ewidencja Palet — serwer lokalny działa', '',
      `  Na tym komputerze:  http://localhost:${port}`];
    if (!tylkoLokalnie) {
      const lan = adresyLan();
      if (lan.length) for (const a of lan) linie.push(`  W sieci lokalnej:   http://${a.adres}:${port}   (${a.nazwa})`);
      else linie.push('  W sieci lokalnej:   (nie wykryto połączenia sieciowego)');
    } else linie.push('  (HOST=127.0.0.1 — serwer dostępny tylko z tego komputera)');
    linie.push('', `  Dane zapisywane w:  ${cfg.dataDir}`,
      `  Hasło dostępu:      ${cfg.haslo ? 'włączone (EP_HASLO)' : 'wyłączone — każdy w sieci lokalnej może otworzyć aplikację'}`,
      '', '  Aby zatrzymać serwer, naciśnij Ctrl+C (albo zamknij to okno).', '');
    console.log(linie.join('\n'));
    if (cfg.otworz) otworzPrzegladarke(`http://localhost:${port}`);
  });

  let zamykanie = false;
  const zamknij = (sygnal) => {
    if (zamykanie) return; zamykanie = true;
    console.log(`\nZatrzymywanie serwera (${sygnal})…`);
    zatrzymaj();
    serwer.close();
    if (serwer.closeIdleConnections) serwer.closeIdleConnections();
    // dokończ trwający zapis bazy (żądania w toku dostaną jeszcze odpowiedź)
    const zapis = baza.petla ? baza.petla.catch(() => {}) : Promise.resolve();
    Promise.race([zapis, new Promise((r) => setTimeout(r, 5000))]).then(() => {
      if (serwer.closeAllConnections) serwer.closeAllConnections();
      console.log('Serwer zatrzymany. Wszystkie dane są zapisane.');
      process.exit(0);
    });
  };
  process.on('SIGINT', () => zamknij('SIGINT'));
  process.on('SIGTERM', () => zamknij('SIGTERM'));
  process.on('SIGHUP', () => zamknij('SIGHUP')); // zamknięte okno Terminala (Mac/Linux)
  if (process.platform === 'win32') process.on('SIGBREAK', () => zamknij('SIGBREAK'));
}

module.exports = { stworzSerwer, konfiguracja, Baza, zapiszAtomowo, ID_RE, VERSION, APP };
if (require.main === module) main();
