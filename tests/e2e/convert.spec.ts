import { expect, test, type Page } from '@playwright/test';
import { makeDocx, makeMixedPdf, makeScannedPdf, makeTextPdf } from '../fixtures/generate';

const ORIGIN = 'http://127.0.0.1:4173';

/** Rend un texte dans le navigateur et le capture en PNG : sert d'image « scannée » / capture d'écran. */
async function renderTextPng(page: Page, html: string, width = 1190, height = 1684): Promise<Buffer> {
  await page.setViewportSize({ width, height });
  await page.setContent(`<html><body style="margin:0;background:#fff;font-family:Arial,Helvetica,sans-serif;color:#000">${html}</body></html>`);
  return page.screenshot({ type: 'png', fullPage: false });
}

async function uploadAndConvert(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[], formats = ['mediawiki', 'confluence'], langs?: string[]) {
  await page.goto('/');
  if (langs) {
    await page.locator('details.options summary').click();
    for (const box of await page.locator('.lang-group input[type=checkbox]').all()) {
      const l = (await box.getAttribute('value')) ?? '';
      if (langs.includes(l)) await box.check(); else await box.uncheck();
    }
  }
  for (const box of await page.locator('.formats input[type=checkbox]').all()) {
    const f = (await box.getAttribute('value')) ?? '';
    if (await box.isEnabled()) {
      if (formats.includes(f)) await box.check(); else await box.uncheck();
    }
  }
  await page.getByTestId('file-input').setInputFiles(files);
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('progress')).toHaveText(new RegExp(`^${files.length} / ${files.length} terminé`), { timeout: 170_000 });
}

async function readSource(page: Page, fileName: string, formatLabel: string): Promise<string> {
  const card = page.locator(`[data-result-name="${fileName}"]`);
  const row = card.locator('.fmt', { hasText: formatLabel }).first();
  await row.getByRole('button', { name: 'Prévisualiser' }).click();
  await page.getByRole('button', { name: 'Code source' }).click();
  const src = await page.locator('.preview textarea').inputValue();
  await page.getByRole('button', { name: 'Fermer' }).click();
  return src;
}

test.describe('Wiki Converter', () => {
  test('aucune requête réseau hors de l’origine, même pendant l’OCR', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (r) => { if (!r.url().startsWith(ORIGIN)) external.push(r.url()); });
    const shot = await renderTextPng(page, '<h1 style="font-size:40px">Titre OCR</h1><p style="font-size:24px">Bonjour le monde</p>', 800, 400);
    await uploadAndConvert(page, [{ name: 'capture.png', mimeType: 'image/png', buffer: shot }]);
    expect(external).toEqual([]);
    const row = page.locator('tr[data-job-name="capture.png"]');
    await expect(row).toHaveAttribute('data-job-status', 'done');
    const mw = await readSource(page, 'capture.png', 'MediaWiki');
    expect(mw).toContain('[[File:capture-image-001.png|thumb');
    expect(mw.toLowerCase()).toContain('bonjour le monde');
  });

  test('DOCX : structure, listes, tableau, images dans l’ordre, code, lien', async ({ page }) => {
    const docx = Buffer.from(await makeDocx());
    await uploadAndConvert(page, [{ name: 'procedure-vpn.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx }]);
    const mw = await readSource(page, 'procedure-vpn.docx', 'MediaWiki');
    expect(mw).toContain('== Configuration réseau ==');
    expect(mw).toContain("Cliquez sur '''Configuration''' puis ''Réseau''.");
    expect(mw).toContain('[[File:procedure-vpn-image-001.png|thumb|Capture de configuration]]');
    expect(mw).toContain('=== Étapes ===');
    expect(mw).toContain('# Ouvrir le menu\n# Choisir le profil');
    expect(mw).toContain('* Puce A\n** Sous-puce\n* Puce B');
    expect(mw).toContain("'''Attention'''");
    expect(mw).toContain('ne pas redémarrer pendant la mise à jour.');
    expect(mw).toContain('{| class="wikitable"\n|-\n! Paramètre\n! Valeur\n|-\n| Serveur\n| vpn.example.org\n|-\n|colspan="2" | Cellule fusionnée\n|}');
    expect(mw).toContain('[[File:procedure-vpn-image-002.png|thumb|Deuxième capture]]');
    expect(mw).toContain('<syntaxhighlight>\nsudo systemctl restart openvpn\njournalctl -u openvpn -f\n</syntaxhighlight>');
    expect(mw).toContain('[https://example.org/doc site officiel]');
    // L'ordre image 1 → tableau → image 2 est conservé.
    expect(mw.indexOf('image-001')).toBeLessThan(mw.indexOf('wikitable'));
    expect(mw.indexOf('wikitable')).toBeLessThan(mw.indexOf('image-002'));
    const cf = await readSource(page, 'procedure-vpn.docx', 'Confluence');
    expect(cf).toContain('<h1>Configuration réseau</h1>');
    expect(cf).toContain('<ri:attachment ri:filename="procedure-vpn-image-001.png" />');
    expect(cf).toContain('<ac:structured-macro ac:name="warning">');
    expect(cf).toContain('<ac:structured-macro ac:name="code">');
    expect(cf).toContain('<th><p>Paramètre</p></th>');
  });

  test('DOCX : les six formats de sortie', async ({ page }) => {
    const docx = Buffer.from(await makeDocx());
    const all = ['mediawiki', 'confluence', 'confluence-wiki', 'dokuwiki', 'markdown', 'bookstack'];
    await uploadAndConvert(page, [{ name: 'procedure-vpn.docx', mimeType: 'application/octet-stream', buffer: docx }], all);
    const card = page.locator('[data-result-name="procedure-vpn.docx"]');
    await expect(card.locator('.fmt', { hasText: '✓' })).toHaveCount(all.length);
    expect(await readSource(page, 'procedure-vpn.docx', 'DokuWiki')).toContain('====== Configuration réseau ======');
    expect(await readSource(page, 'procedure-vpn.docx', 'Markdown')).toContain('# Configuration réseau');
    expect(await readSource(page, 'procedure-vpn.docx', 'BookStack')).toContain('<h1>Configuration réseau</h1>');
    expect(await readSource(page, 'procedure-vpn.docx', 'Confluence wiki markup')).toContain('h1. Configuration réseau');
  });

  test('PDF texte : titres, listes, image positionnée, en-têtes/pieds supprimés, code', async ({ page }) => {
    const pdf = Buffer.from(await makeTextPdf('ALPHA'));
    await uploadAndConvert(page, [{ name: 'install-alpha.pdf', mimeType: 'application/pdf', buffer: pdf }], ['mediawiki']);
    const mw = await readSource(page, 'install-alpha.pdf', 'MediaWiki');
    expect(mw).toContain('== Prérequis ==');
    expect(mw).toContain('== Étape suivante ==');
    expect(mw).toContain('== Annexe ==');
    expect(mw).toContain("* Disposer d'un compte administrateur\n* Avoir installé le client");
    expect(mw).toContain('[[File:install-alpha-image-001.png|thumb');
    expect(mw).not.toContain('Documentation interne');
    expect(mw).not.toMatch(/Page \d \/ 2/);
    expect(mw).toContain('apt-get install client-vpn\nsystemctl enable client-vpn');
    expect(mw.indexOf('Avoir installé')).toBeLessThan(mw.indexOf('image-001'));
    expect(mw.indexOf('image-001')).toBeLessThan(mw.indexOf('Étape suivante'));
    expect(mw).toContain('Ce document décrit la procédure complète. Elle comporte plusieurs étapes');
  });

  test('PDF scanné et mixte : OCR local', async ({ page }) => {
    const shot = await renderTextPng(page, '<div style="padding:80px"><h1 style="font-size:48px">Rapport scanné</h1><p style="font-size:28px;line-height:1.5">Ceci est une page numérisée. Le texte est reconnu par OCR local.</p><p style="font-size:28px">• Premier point<br>• Second point</p></div>');
    const scanned = Buffer.from(await makeScannedPdf(shot));
    const mixed = Buffer.from(await makeMixedPdf(shot));
    await uploadAndConvert(page, [
      { name: 'scan.pdf', mimeType: 'application/pdf', buffer: scanned },
      { name: 'mixte.pdf', mimeType: 'application/pdf', buffer: mixed },
    ], ['mediawiki'], ['fra', 'eng']);
    const scan = await readSource(page, 'scan.pdf', 'MediaWiki');
    expect(scan.toLowerCase()).toContain('page numérisée');
    expect(scan).toMatch(/==\s*Rapport scanné\s*==/);
    expect(scan).toContain('* Premier point');
    const mix = await readSource(page, 'mixte.pdf', 'MediaWiki');
    expect(mix).toContain('Ce paragraphe est extrait directement.');
    expect(mix.toLowerCase()).toContain('reconnu par ocr local');
    await expect(page.locator('tr[data-job-name="mixte.pdf"] td').nth(2)).toHaveText('✓');
  });

  test('lot de 6 fichiers en parallèle : isolation et exports distincts', async ({ page }) => {
    const files = [];
    for (const m of ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA']) {
      files.push({ name: `doc-${m.toLowerCase()}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(await makeTextPdf(m)) });
    }
    files.push({ name: 'procedure.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(await makeDocx()) });
    files.push({ name: 'procedure.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(await makeDocx()) });
    await uploadAndConvert(page, files.slice(0, 5));
    for (const m of ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA']) {
      const src = await readSource(page, `doc-${m.toLowerCase()}.pdf`, 'MediaWiki');
      expect(src).toContain(`Texte de la seconde page ${m}.`);
      for (const other of ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA'].filter((o) => o !== m)) expect(src).not.toContain(other);
    }
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Tout télécharger (ZIP)' }).click()]);
    expect(download.suggestedFilename()).toBe('export.zip');
  });

  test('fichiers refusés : DOC, extension inconnue, contenu incohérent', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('file-input').setInputFiles([
      { name: 'ancien.doc', mimeType: 'application/msword', buffer: Buffer.from('x'.repeat(100)) },
      { name: 'script.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') },
      { name: 'faux.pdf', mimeType: 'application/pdf', buffer: Buffer.from('ceci n’est pas un pdf') },
    ]);
    await expect(page.locator('.filelist li.rejected')).toHaveCount(2);
    await page.getByTestId('convert').click();
    await expect(page.locator('tr[data-job-name="faux.pdf"]')).toHaveAttribute('data-job-status', 'error');
    await expect(page.locator('tr[data-job-name="faux.pdf"] .err')).toContainText('ne correspond pas');
  });
});
