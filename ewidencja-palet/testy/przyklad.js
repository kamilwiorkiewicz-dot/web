// Przykład: NODE_PATH=$(npm root -g) node testy/przyklad.js
const { openApp } = require('./uruchom-z-atrapa');
(async()=>{
  const {page, browser} = await openApp();
  console.log(await page.evaluate(()=>document.getElementById('sidebarBalance').textContent));
  await page.click('.nav-item[data-view="stats"]'); await page.waitForTimeout(200);
  console.log((await page.evaluate(()=>document.getElementById('main').innerText)).slice(0,500));
  console.log('błędy:', page.errors);
  await browser.close();
})();
