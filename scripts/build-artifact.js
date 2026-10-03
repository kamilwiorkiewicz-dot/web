// Składa aplikację w jeden plik HTML (dist/kredyt-artifact.html) do publikacji jako artefakt Claude.
// Artefakt dostaje własny szkielet HTML, więc usuwamy doctype/html/head/body, manifest i service worker.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
let html = read('index.html');

html = html
  .replace(/<!-- build:head -->[\s\S]*?<!-- \/build:head -->\s*/, '')
  .replace(/<link rel="stylesheet" href="css\/styles\.css">/, () => `<style>\n${read('css/styles.css')}\n</style>`)
  .replace(/<script src="(js\/[\w-]+\.js)"><\/script>/g, (m, f) => `<script>\n${read(f)}\n</script>`)
  .replace('<script>', '<script>window.__KREDYT_ARTIFACT__ = true;</script>\n<script>')
  .replace(/<!DOCTYPE html>\s*/i, '')
  .replace(/<\/?html[^>]*>\s*/g, '')
  .replace(/<\/?head>\s*/g, '')
  .replace(/<\/?body>\s*/g, '');

// Tytuł musi być na początku pliku.
const title = html.match(/<title>[^<]*<\/title>\s*/)[0];
html = title + html.replace(title, '');

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/kredyt-artifact.html'), html);
console.log('dist/kredyt-artifact.html', (html.length / 1024).toFixed(1) + ' KB');
