import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const [,, file, kind] = process.argv;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
page.on('console', (m) => console.log('[console]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure()?.errorText));
await page.goto('http://127.0.0.1:5173/tests/debug/debug2.html');
await page.waitForFunction(() => window.ready);
const b64 = readFileSync(file).toString('base64');
const t0 = Date.now();
try {
  const out = await page.evaluate(([b, k, n]) => window.run(b), [b64, kind, file.split('/').pop()]);
  console.log(out.slice(0, 6000));
} catch (e) { console.log('[error]', e.message); }
console.log('ms', Date.now() - t0);
await browser.close();
