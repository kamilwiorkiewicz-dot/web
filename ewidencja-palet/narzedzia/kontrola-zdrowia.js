// Kontrola zdrowia kontenera (Docker HEALTHCHECK): kod 0, gdy serwer odpowiada na /api/ping.
// Działa także z włączonym hasłem (EP_HASLO).
'use strict';
const http = require('http');
const haslo = process.env.EP_HASLO;
const req = http.get({
  host: '127.0.0.1',
  port: Number(process.env.PORT) || 8080,
  path: '/api/ping',
  timeout: 4000,
  headers: haslo ? { Authorization: `Basic ${Buffer.from(`zdrowie:${haslo}`, 'utf8').toString('base64')}` } : {},
}, (res) => {
  let body = '';
  res.on('data', (c) => { body += c; });
  res.on('end', () => {
    try { process.exit(res.statusCode === 200 && JSON.parse(body).app === 'ewidencja-palet' ? 0 : 1); }
    catch (e) { process.exit(1); }
  });
});
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));
