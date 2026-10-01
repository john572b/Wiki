import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
await page.setContent('<html><body style="margin:0;background:#fff;font-family:Arial"><h1 style="font-size:40px">Titre OCR</h1><p style="font-size:24px">Bonjour le monde</p></body></html>');
writeFileSync('tests/fixtures/generated/capture.png', await page.screenshot({ type: 'png' }));
await browser.close();
console.log('png ok');
