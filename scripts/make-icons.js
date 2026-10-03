// Generuje ikony PNG z icons/icon.svg (wymaga Playwright z Chromium).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '../icons/icon.svg'), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const size of [180, 192, 512]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(__dirname, `../icons/icon-${size}.png`), omitBackground: true });
  }
  await browser.close();
})();
