import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ ignoreHTTPSErrors: true }); // CA du proxy de la sandbox uniquement
const external = [];
page.on('request', (r) => { if (!r.url().startsWith('https://wiki.boi.lu/')) external.push(r.url()); });
await page.goto('https://wiki.boi.lu/');
await page.getByTestId('file-input').setInputFiles([
  { name: 'scan.pdf', mimeType: 'application/pdf', buffer: readFileSync('tests/fixtures/generated/scan.pdf') },
  { name: 'procedure-vpn.docx', mimeType: 'application/octet-stream', buffer: readFileSync('tests/fixtures/generated/proc.docx') },
]);
await page.getByTestId('convert').click();
await page.getByTestId('progress').filter({ hasText: /^2 \/ 2/ }).waitFor({ timeout: 180000 });
console.log('statuts:', await page.locator('tr[data-job-status]').evaluateAll((rows) => rows.map((r) => r.dataset.jobName + '=' + r.dataset.jobStatus)));
console.log('requêtes hors wiki.boi.lu:', external);
await browser.close();
