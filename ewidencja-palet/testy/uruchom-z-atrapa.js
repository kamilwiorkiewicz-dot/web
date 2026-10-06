// Pomocnik: otwiera zrodlo/aplikacja.html w Chromium z atrapą platformy Claude i danymi testowymi.
// Użycie w testach: const {openApp} = require('./uruchom-z-atrapa'); const {page, browser} = await openApp({seed, width, height});
const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright');
async function openApp(opts={}){
  const html = fs.readFileSync(opts.htmlPath || path.join(__dirname,'..','zrodlo','aplikacja.html'),'utf8');
  const seed = opts.seed || JSON.parse(fs.readFileSync(path.join(__dirname,'dane-testowe.json'),'utf8'));
  const mock = fs.readFileSync(path.join(__dirname,'mock-claude.js'),'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport:{width:opts.width||1300, height:opts.height||900}});
  page.errors = [];
  page.on('pageerror', e=>{ page.errors.push(e.message); });
  page.on('console', m=>{ if(m.type()==='error') page.errors.push('console: '+m.text()); });
  await page.addInitScript(`window.__SEED = ${JSON.stringify(seed)};\n${mock}`);
  await page.route('https://fonts.googleapis.com/**', r=>r.abort());
  await page.route('https://fonts.gstatic.com/**', r=>r.abort());
  await page.route('http://app.local/', r=>r.fulfill({contentType:'text/html; charset=utf-8', body:html}));
  await page.goto('http://app.local/', {waitUntil:'commit'});
  await page.waitForTimeout(500);
  return {page, browser};
}
module.exports = { openApp };
