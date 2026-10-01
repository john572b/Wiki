import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, ignoreHTTPSErrors: true });
await page.goto('https://wiki.boi.lu/');
await page.screenshot({ path: 'tests/debug/prod-1-accueil.png' });
await page.getByTestId('file-input').setInputFiles([
  { name: 'procedure-vpn.docx', mimeType: 'application/octet-stream', buffer: readFileSync('tests/fixtures/generated/proc.docx') },
  { name: 'installation.pdf', mimeType: 'application/pdf', buffer: readFileSync('tests/fixtures/generated/text.pdf') },
  { name: 'scan.pdf', mimeType: 'application/pdf', buffer: readFileSync('tests/fixtures/generated/scan.pdf') },
  { name: 'capture.png', mimeType: 'image/png', buffer: readFileSync('tests/fixtures/generated/capture.png') },
]);
await page.screenshot({ path: 'tests/debug/prod-2-selection.png' });
await page.getByTestId('convert').click();
await page.waitForTimeout(400);
await page.screenshot({ path: 'tests/debug/prod-3-traitement.png' });
await page.getByTestId('progress').filter({ hasText: /^4 \/ 4/ }).waitFor({ timeout: 120000 });
await page.screenshot({ path: 'tests/debug/prod-4-resultats.png', fullPage: true });
await page.locator('[data-result-name="procedure-vpn.docx"] .fmt', { hasText: 'MediaWiki' }).getByRole('button', { name: 'Prévisualiser' }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: 'tests/debug/prod-5-apercu-mediawiki.png' });
await page.getByRole('button', { name: 'Fermer' }).click();
await page.locator('[data-result-name="procedure-vpn.docx"] .fmt', { hasText: 'Confluence' }).getByRole('button', { name: 'Prévisualiser' }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: 'tests/debug/prod-6-apercu-confluence.png' });
await page.getByRole('button', { name: 'Code source' }).click();
await page.screenshot({ path: 'tests/debug/prod-7-source-confluence.png' });
await browser.close();
console.log('shots ok');
