/**
 * Matrice de conformité : la même procédure simulée, fournie dans chaque format d'entrée,
 * est convertie vers les six formats de sortie. Chaque élément attendu est vérifié avec la syntaxe du wiki cible.
 */
import { expect, test, type Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as G from '../fixtures/procedure.ts';

const OUTPUTS = ['mediawiki', 'confluence', 'confluence-wiki', 'dokuwiki', 'markdown', 'bookstack'] as const;
type Out = (typeof OUTPUTS)[number];
type Feature = 'heading' | 'bulletList' | 'orderedList' | 'nestedList' | 'table' | 'tableText' | 'code' | 'warning' | 'link' | 'image' | 'imageOrder' | 'ocrText' | 'sheet';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LINK = esc(G.P.linkHref);

/** Expressions attendues par format de sortie et par élément. `base` = nom de base des images. */
const CHECKS: Record<Out, Partial<Record<Feature, (base: string) => RegExp[]>>> = {
  mediawiki: {
    heading: () => [/^=+ ?Prérequis ?=+$/m, /^=+ ?Étapes ?=+$/m],
    bulletList: () => [/^\* ?Un compte administrateur$/m],
    orderedList: () => [/^# ?Ouvrir le client VPN$/m, /^# ?Valider la connexion$/m],
    nestedList: () => [/^#\* ?Serveur principal : vpn\.exemple\.lu$/m],
    table: () => [/\{\| class="wikitable"/, /^! ?Paramètre$/m, /^\| ?vpn\.exemple\.lu$/m],
    tableText: () => [/vpn\.exemple\.lu/, /1194/],
    code: () => [/<(syntaxhighlight|pre)[^>]*>\nsudo systemctl restart openvpn\n<\/(syntaxhighlight|pre)>/],
    warning: () => [/wc-warning[\s\S]*ne pas redémarrer le poste/],
    link: () => [new RegExp(`\\[${LINK}[ \\]]|(^|\\s)${LINK}(\\s|$)`, 'm')],
    image: (b) => [new RegExp(`\\[\\[File:${esc(b)}-1\\.png\\|thumb`)],
    sheet: () => [/^=+ ?Paramètres ?=+$/m, /\{\| class="wikitable"/],
  },
  confluence: {
    heading: () => [/<h\d>Prérequis<\/h\d>/, /<h\d>Étapes<\/h\d>/],
    bulletList: () => [/<ul>\s*<li>Un compte administrateur<\/li>/],
    orderedList: () => [/<ol>\s*<li>Ouvrir le client VPN<\/li>/],
    nestedList: () => [/<li>Saisir l'adresse du serveur<ul>\s*<li>Serveur principal : vpn\.exemple\.lu<\/li>/],
    table: () => [/<th><p>Paramètre<\/p><\/th>/, /<td><p>vpn\.exemple\.lu<\/p><\/td>/],
    tableText: () => [/vpn\.exemple\.lu/, /1194/],
    code: () => [/ac:name="code">[\s\S]*?<!\[CDATA\[sudo systemctl restart openvpn\]\]>/],
    warning: () => [/ac:name="warning">[\s\S]*?ne pas redémarrer le poste/],
    link: () => [new RegExp(`<a href="${LINK}">`)],
    image: (b) => [new RegExp(`<ri:attachment ri:filename="${esc(b)}-1\\.png" />`)],
    sheet: () => [/<h\d>Paramètres<\/h\d>/, /<table>/],
  },
  'confluence-wiki': {
    heading: () => [/^h\d\. Prérequis$/m, /^h\d\. Étapes$/m],
    bulletList: () => [/^\* Un compte administrateur$/m],
    orderedList: () => [/^# Ouvrir le client VPN$/m],
    nestedList: () => [/^#\* Serveur principal : vpn\.exemple\.lu$/m],
    table: () => [/^\|\|Paramètre\|\|Valeur\|\|$/m, /^\|Serveur\|vpn\.exemple\.lu\|$/m],
    tableText: () => [/vpn\.exemple\.lu/, /1194/],
    code: () => [/\{code[^}]*\}\nsudo systemctl restart openvpn\n\{code\}/],
    warning: () => [/\{warning[^}]*\}\n[^{]*ne pas redémarrer le poste[\s\S]*?\n\{warning\}/],
    link: () => [new RegExp(`\\[(?:[^|\\]]+\\|)?${LINK}\\]`)],
    image: (b) => [new RegExp(`^!${esc(b)}-1\\.png(\\|[^!]*)?!`, 'm')],
    sheet: () => [/^h\d\. Paramètres$/m, /^\|\|/m],
  },
  dokuwiki: {
    heading: () => [/^=+ Prérequis =+$/m, /^=+ Étapes =+$/m],
    bulletList: () => [/^ {2}\* Un compte administrateur$/m],
    orderedList: () => [/^ {2}- Ouvrir le client VPN$/m],
    nestedList: () => [/^ {4}\* Serveur principal : vpn\.exemple\.lu$/m],
    table: () => [/^\^ Paramètre \^ Valeur \^$/m, /^\| Serveur \| vpn\.exemple\.lu \|$/m],
    tableText: () => [/vpn\.exemple\.lu/, /1194/],
    code: () => [/<code[^>]*>\nsudo systemctl restart openvpn\n<\/code>/],
    warning: () => [/^> \*\*Attention\*\* ne pas redémarrer le poste/m],
    link: () => [new RegExp(`\\[\\[${LINK}\\|`)],
    image: (b) => [new RegExp(`\\{\\{:${esc(b)}-1\\.png`)],
    sheet: () => [/^=+ Paramètres =+$/m, /^\^ /m],
  },
  markdown: {
    heading: () => [/^#+ Prérequis$/m, /^#+ Étapes$/m],
    bulletList: () => [/^- Un compte administrateur$/m],
    orderedList: () => [/^1\. Ouvrir le client VPN$/m, /^3\. Valider la connexion$/m],
    nestedList: () => [/^ {4}- Serveur principal : vpn\.exemple\.lu$/m],
    table: () => [/^\| Paramètre \| Valeur \|$/m, /^\| --- \| --- \|$/m, /^\| Serveur \| vpn\.exemple\.lu \|$/m],
    tableText: () => [/vpn\.exemple\.lu/, /1194/],
    code: () => [/```[a-z]*\nsudo systemctl restart openvpn\n```/],
    warning: () => [/^> \[!WARNING\]\n> ne pas redémarrer le poste/m],
    link: () => [new RegExp(`\\]\\(${LINK}\\)`)],
    image: (b) => [new RegExp(`!\\[[^\\]]*\\]\\(images/${esc(encodeURI(b))}-1\\.png\\)`)],
    sheet: () => [/^#+ Paramètres$/m, /^\| --- /m],
  },
  bookstack: {
    heading: () => [/<h\d>Prérequis<\/h\d>/, /<h\d>Étapes<\/h\d>/],
    bulletList: () => [/<ul><li>Un compte administrateur<\/li>/],
    orderedList: () => [/<ol><li>Ouvrir le client VPN/],
    nestedList: () => [/<li>Saisir l'adresse du serveur<ul><li>Serveur principal : vpn\.exemple\.lu<\/li><\/ul><\/li>/],
    table: () => [/<th>Paramètre<\/th>/, /<td>vpn\.exemple\.lu<\/td>/],
    tableText: () => [/vpn\.exemple\.lu/, /1194/],
    code: () => [/<pre><code[^>]*>sudo systemctl restart openvpn<\/code><\/pre>/],
    warning: () => [/class="callout warning"[^>]*>[\s\S]*?ne pas redémarrer le poste/],
    link: () => [new RegExp(`<a href="${LINK}">`)],
    image: (b) => [new RegExp(`<img src="images/${esc(b)}-1\\.png"`)],
    sheet: () => [/<h\d>Paramètres<\/h\d>/, /<table>/],
  },
};

/** Ordre attendu dans la sortie : étapes, puis capture, puis section Paramètres. */
function orderOk(text: string, base: string): boolean {
  const a = text.indexOf('Valider la connexion');
  const b = text.indexOf(`${base}-1.png`);
  const c = text.search(/Paramètres/);
  return a >= 0 && b > a && c > b;
}

const STRUCTURED: Feature[] = ['heading', 'bulletList', 'orderedList', 'nestedList', 'table', 'code', 'warning', 'link', 'image', 'imageOrder'];

interface Input { file: string; mime: string; data: () => Promise<Uint8Array | string>; features: Feature[]; images: number }

async function renderPng(page: Page): Promise<Uint8Array> {
  await page.setViewportSize({ width: 1190, height: 1684 });
  await page.setContent(G.procHtml().replace('<head>', '<head><style>body{font-family:Arial,Helvetica,sans-serif;font-size:22px;margin:70px;color:#000}h1{font-size:44px}h2{font-size:32px}img{width:320px}</style>'));
  return new Uint8Array(await page.screenshot({ type: 'png' }));
}

test('matrice : 11 formats d’entrée × 6 formats de sortie', async ({ page }) => {
  test.setTimeout(240_000);
  const png = await renderPng(page);
  const inputs: Input[] = [
    { file: 'proc-docx.docx', mime: 'application/octet-stream', data: G.procDocx, features: STRUCTURED, images: 1 },
    { file: 'proc-odt.odt', mime: 'application/octet-stream', data: G.procOdt, features: STRUCTURED, images: 1 },
    { file: 'proc-pptx.pptx', mime: 'application/octet-stream', data: G.procPptx, features: STRUCTURED, images: 1 },
    { file: 'proc-html.html', mime: 'text/html', data: async () => G.procHtml(), features: STRUCTURED, images: 1 },
    { file: 'proc-md.md', mime: 'text/markdown', data: async () => G.procMarkdown(), features: STRUCTURED, images: 1 },
    { file: 'proc-pdf.pdf', mime: 'application/pdf', data: G.procPdf, features: STRUCTURED, images: 1 },
    { file: 'proc-txt.txt', mime: 'text/plain', data: async () => G.procText(), features: ['heading', 'bulletList', 'orderedList', 'nestedList', 'tableText', 'code', 'warning', 'link'], images: 0 },
    { file: 'proc-xlsx.xlsx', mime: 'application/octet-stream', data: G.procXlsx, features: ['sheet', 'table'], images: 0 },
    { file: 'proc-csv.csv', mime: 'text/csv', data: async () => G.procCsv(), features: ['table'], images: 0 },
    { file: 'proc-scan.pdf', mime: 'application/pdf', data: () => G.scannedPdfFrom(png), features: ['ocrText'], images: 0 },
    { file: 'proc-capture.png', mime: 'image/png', data: async () => png, features: ['ocrText', 'image'], images: 1 },
  ];
  const files = [];
  for (const i of inputs) {
    const d = await i.data();
    files.push({ name: i.file, mimeType: i.mime, buffer: Buffer.from(typeof d === 'string' ? d : d) });
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#e2e');
  await page.locator('details.options summary').click();
  for (const box of await page.locator('.lang-group input[type=checkbox]').all()) {
    const l = (await box.getAttribute('value')) ?? '';
    if (['fra', 'eng'].includes(l)) await box.check(); else await box.uncheck();
  }
  for (const box of await page.locator('.formats input[type=checkbox]').all()) await box.check();
  await page.getByTestId('file-input').setInputFiles(files);
  await page.getByTestId('convert').click();
  await page.waitForFunction(
    (n) => {
      const d = (window as unknown as { __wcDump?: () => { status: string }[] }).__wcDump?.() ?? [];
      return d.length === n && d.every((j) => j.status === 'done' || j.status === 'error');
    },
    inputs.length,
    { timeout: 200_000, polling: 500 },
  );

  type Dump = { name: string; kind: string; status: string; error: string | null; warnings: string[]; images: { name: string; mime: string; bytes: number }[]; outputs: Record<string, string>; previews: Record<string, string> }[];
  const dump = (await page.evaluate(() => (window as unknown as { __wcDump: () => unknown }).__wcDump())) as Dump;
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/matrix-outputs.json', JSON.stringify(dump, null, 1));

  const failures: string[] = [];
  const table: string[] = [];
  for (const input of inputs) {
    const job = dump.find((j) => j.name === input.file);
    if (!job || job.status !== 'done') { failures.push(`${input.file} : statut ${job?.status} ${job?.error ?? ''}`); continue; }
    const base = input.file.replace(/\.[^.]+$/, '');
    if (job.images.length !== input.images) failures.push(`${input.file} : ${job.images.length} image(s) au lieu de ${input.images}`);
    for (const im of job.images) if (im.bytes < 100) failures.push(`${input.file} : image ${im.name} vide`);
    const row: string[] = [];
    for (const out of OUTPUTS) {
      const text = job.outputs[out];
      let ok = true;
      if (!text) { failures.push(`${input.file} → ${out} : sortie absente`); row.push('✗'); continue; }
      if (/undefined|\[object |\u0001|\u0002/.test(text)) { failures.push(`${input.file} → ${out} : artefact interne dans la sortie`); ok = false; }
      if (/<script/i.test(job.previews[out])) { failures.push(`${input.file} → ${out} : script dans l'aperçu`); ok = false; }
      for (const f of input.features) {
        if (f === 'imageOrder') {
          if (!orderOk(text, base)) { failures.push(`${input.file} → ${out} : ordre étapes / capture / paramètres non conservé`); ok = false; }
          continue;
        }
        if (f === 'ocrText') {
          for (const t of ['Configuration du VPN', 'Ouvrir le client VPN', 'vpn.exemple.lu']) {
            if (!text.includes(t)) { failures.push(`${input.file} → ${out} : texte OCR « ${t} » absent`); ok = false; }
          }
          continue;
        }
        for (const re of CHECKS[out][f]?.(base) ?? []) {
          if (!re.test(text)) { failures.push(`${input.file} → ${out} : ${f} attendu ${re}`); ok = false; }
        }
      }
      if (input.features.includes('link') && /\[\[https?:[^|\]]*\|Documentation/.test(job.outputs.dokuwiki ?? '')) { failures.push(`${input.file} → ${out} : le libellé du lien englobe le texte voisin`); ok = false; }
      if (out === 'confluence') {
        const wellFormed = await page.evaluate((x) => {
          const d = new DOMParser().parseFromString(`<root xmlns:ac="urn:ac" xmlns:ri="urn:ri">${x}</root>`, 'application/xml');
          return d.getElementsByTagName('parsererror').length === 0;
        }, text);
        if (!wellFormed) { failures.push(`${input.file} → confluence : XML mal formé`); ok = false; }
      }
      row.push(ok ? '✓' : '✗');
    }
    table.push(`${input.file.padEnd(18)} ${row.join('  ')}`);
  }
  // Isolation : aucune sortie ne contient le nom d'image d'un autre document.
  for (const job of dump) {
    for (const other of dump) {
      if (other === job || !other.images.length) continue;
      const otherBase = other.name.replace(/\.[^.]+$/, '');
      for (const out of OUTPUTS) if ((job.outputs[out] ?? '').includes(`${otherBase}-1.png`)) failures.push(`${job.name} → ${out} : référence une image de ${other.name}`);
    }
  }
  console.log(`\n${''.padEnd(18)} ${OUTPUTS.map((o) => o.slice(0, 2)).join(' ')}\n${table.join('\n')}\n`);
  expect(failures, failures.join('\n')).toEqual([]);
});
