// Wspólne pomocniki testów: uruchamianie server.js na wolnym porcie, żądania HTTP, klient SSE.
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const KATALOG = path.join(__dirname, '..');
const SERWER = path.join(KATALOG, 'server.js');

function wolnyPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function tymczasowyKatalog(prefiks = 'ep-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefiks)); }

/** Uruchamia server.js; zwraca {port, url, proc, wyjscie(), bledy(), zatrzymaj()} po wypisaniu adresu. */
async function uruchomSerwer({ dataDir, port, env = {} } = {}) {
  port = port || await wolnyPort();
  const srodowisko = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ...env };
  if (!('EP_HASLO' in env)) delete srodowisko.EP_HASLO;
  const proc = spawn(process.execPath, [SERWER], { env: srodowisko, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', errOut = '';
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { errOut += d; });
  const zakonczony = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Serwer nie wystartował w 10 s.\nstdout:\n${out}\nstderr:\n${errOut}`)), 10000);
    const sprawdz = () => { if (out.includes(`http://localhost:${port}`)) { clearTimeout(t); resolve(); } };
    proc.stdout.on('data', sprawdz);
    zakonczony.then(({ code }) => { clearTimeout(t); reject(new Error(`Serwer zakończył się kodem ${code}.\nstdout:\n${out}\nstderr:\n${errOut}`)); });
  });
  return {
    port, proc, url: `http://127.0.0.1:${port}`,
    wyjscie: () => out, bledy: () => errOut, zakonczony,
    async zatrzymaj(sygnal = 'SIGTERM') {
      if (proc.exitCode !== null || proc.signalCode !== null) return zakonczony;
      proc.kill(sygnal);
      return zakonczony;
    },
  };
}

/** Surowe żądanie HTTP (ścieżka bez normalizacji — do testów path traversal). */
function zadanie(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const kawalki = [];
      res.on('data', (c) => kawalki.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(kawalki); let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* nie JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8'), json });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}
function jsonPost(port, p, obj, headers = {}) {
  const body = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  return zadanie(port, { method: 'POST', path: p, body, headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...headers } });
}

/** Klient SSE: zbiera zdarzenia {event, data}. */
function klientSse(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const zdarzenia = []; let bufor = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(Object.assign(new Error(`SSE status ${res.statusCode}`), { status: res.statusCode })); return; }
      res.setEncoding('utf8');
      res.on('data', (c) => {
        bufor += c; let i;
        while ((i = bufor.indexOf('\n\n')) >= 0) {
          const blok = bufor.slice(0, i); bufor = bufor.slice(i + 2);
          let event = 'message', data = '';
          for (const linia of blok.split('\n')) {
            if (linia.startsWith('event: ')) event = linia.slice(7);
            else if (linia.startsWith('data: ')) data += linia.slice(6);
          }
          if (data) zdarzenia.push({ event, data: JSON.parse(data) });
        }
      });
      resolve({
        zdarzenia, naglowki: res.headers,
        zamknij() { req.destroy(); },
        async czekaj(warunek, ms = 3000) {
          const koniec = Date.now() + ms;
          for (;;) {
            const z = zdarzenia.find(warunek);
            if (z) return z;
            if (Date.now() > koniec) throw new Error(`Nie doczekano się zdarzenia SSE. Odebrane: ${JSON.stringify(zdarzenia)}`);
            await new Promise((r) => setTimeout(r, 20));
          }
        },
      });
    });
    req.on('error', reject);
  });
}

// najmniejszy poprawny PNG 1×1 (czerwony piksel)
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

module.exports = { KATALOG, SERWER, wolnyPort, tymczasowyKatalog, uruchomSerwer, zadanie, jsonPost, klientSse, PNG_1X1 };
