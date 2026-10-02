/**
 * Procédure simulée « Configuration du VPN », générée à l'identique dans chaque format d'entrée.
 * Contenu : titre, introduction, prérequis (puces), étapes (numérotées, avec une sous-puce), capture d'écran,
 * tableau de paramètres, commande, avertissement, lien. Aucun document réel n'est utilisé.
 */
import JSZip from 'jszip';
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib';
import {
  Document, ExternalHyperlink, HeadingLevel, ImageRun, LevelFormat, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';
import PptxGenJS from 'pptxgenjs';
import ExcelJS from 'exceljs';
import { makePng } from './generate.ts';

export const P = {
  title: 'Configuration du VPN',
  intro: "Cette procédure explique comment configurer le client VPN de l'entreprise.",
  prereqTitle: 'Prérequis',
  prereqs: ['Un compte administrateur', 'Le client VPN installé'],
  stepsTitle: 'Étapes',
  steps: ['Ouvrir le client VPN', "Saisir l'adresse du serveur", 'Valider la connexion'],
  subStep: 'Serveur principal : vpn.exemple.lu',
  imageAlt: 'Écran de connexion',
  paramsTitle: 'Paramètres',
  table: [['Paramètre', 'Valeur'], ['Serveur', 'vpn.exemple.lu'], ['Port', '1194']],
  codeTitle: 'Commandes',
  code: 'sudo systemctl restart openvpn',
  warning: 'Attention : ne pas redémarrer le poste pendant la connexion.',
  linkLabel: 'intranet',
  linkHref: 'https://intranet.exemple.lu/vpn',
};

export const SCREEN_PNG = makePng(160, 80, [30, 120, 200]);
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

export function procHtml(withImage = true): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${P.title}</title></head><body>
<h1>${P.title}</h1>
<p>${P.intro}</p>
<h2>${P.prereqTitle}</h2>
<ul>${P.prereqs.map((p) => `<li>${p}</li>`).join('')}</ul>
<h2>${P.stepsTitle}</h2>
<ol><li>${P.steps[0]}</li><li>${P.steps[1]}<ul><li>${P.subStep}</li></ul></li><li>${P.steps[2]}</li></ol>
${withImage ? `<p><img src="data:image/png;base64,${b64(SCREEN_PNG)}" alt="${P.imageAlt}"></p>` : ''}
<h2>${P.paramsTitle}</h2>
<table><thead><tr><th>${P.table[0][0]}</th><th>${P.table[0][1]}</th></tr></thead><tbody>
${P.table.slice(1).map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}
</tbody></table>
<h2>${P.codeTitle}</h2>
<pre><code class="language-bash">${P.code}</code></pre>
<p><strong>Attention :</strong> ${P.warning.replace('Attention : ', '')}</p>
<p>Documentation : <a href="${P.linkHref}">${P.linkLabel}</a></p>
</body></html>`;
}

export function procMarkdown(): string {
  return `# ${P.title}

${P.intro}

## ${P.prereqTitle}

${P.prereqs.map((p) => `- ${p}`).join('\n')}

## ${P.stepsTitle}

1. ${P.steps[0]}
2. ${P.steps[1]}
   - ${P.subStep}
3. ${P.steps[2]}

![${P.imageAlt}](data:image/png;base64,${b64(SCREEN_PNG)})

## ${P.paramsTitle}

| ${P.table[0][0]} | ${P.table[0][1]} |
| --- | --- |
${P.table.slice(1).map((r) => `| ${r[0]} | ${r[1]} |`).join('\n')}

## ${P.codeTitle}

\`\`\`bash
${P.code}
\`\`\`

${P.warning}

Documentation : [${P.linkLabel}](${P.linkHref})
`;
}

export function procText(): string {
  const u = (t: string, c: string) => `${t}\n${c.repeat(t.length)}`;
  return `${u(P.title, '=')}

${P.intro}

${u(P.prereqTitle, '-')}

${P.prereqs.map((p) => `- ${p}`).join('\n')}

${u(P.stepsTitle, '-')}

1. ${P.steps[0]}
2. ${P.steps[1]}
   - ${P.subStep}
3. ${P.steps[2]}

${u(P.paramsTitle, '-')}

Serveur : vpn.exemple.lu
Port : 1194

${u(P.codeTitle, '-')}

    ${P.code}

${P.warning}

Documentation : ${P.linkHref}
`;
}

export function procCsv(): string {
  return P.table.map((r) => r.map((c) => (/[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(';')).join('\r\n') + '\r\n';
}

export async function procDocx(): Promise<Uint8Array> {
  const doc = new Document({
    styles: { paragraphStyles: [{ id: 'Code', name: 'Code', basedOn: 'Normal', run: { font: 'Courier New' } }] },
    numbering: {
      config: [
        { reference: 'bul', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•' }, { level: 1, format: LevelFormat.BULLET, text: '◦' }] },
        { reference: 'num', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.' }, { level: 1, format: LevelFormat.BULLET, text: '◦' }] },
      ],
    },
    sections: [{
      children: [
        new Paragraph({ text: P.title, heading: HeadingLevel.HEADING_1 }),
        new Paragraph(P.intro),
        new Paragraph({ text: P.prereqTitle, heading: HeadingLevel.HEADING_2 }),
        ...P.prereqs.map((t) => new Paragraph({ text: t, numbering: { reference: 'bul', level: 0 } })),
        new Paragraph({ text: P.stepsTitle, heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ text: P.steps[0], numbering: { reference: 'num', level: 0 } }),
        new Paragraph({ text: P.steps[1], numbering: { reference: 'num', level: 0 } }),
        new Paragraph({ text: P.subStep, numbering: { reference: 'num', level: 1 } }),
        new Paragraph({ text: P.steps[2], numbering: { reference: 'num', level: 0 } }),
        new Paragraph({ children: [new ImageRun({ type: 'png', data: SCREEN_PNG, transformation: { width: 160, height: 80 }, altText: { title: P.imageAlt, description: P.imageAlt, name: 'ecran' } })] }),
        new Paragraph({ text: P.paramsTitle, heading: HeadingLevel.HEADING_2 }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: P.table.map((r, i) => new TableRow({ tableHeader: i === 0, children: r.map((c) => new TableCell({ children: [new Paragraph(c)] })) })),
        }),
        new Paragraph({ text: P.codeTitle, heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ style: 'Code', text: P.code }),
        new Paragraph({ children: [new TextRun({ text: 'Attention :', bold: true }), new TextRun(P.warning.replace('Attention :', ''))] }),
        new Paragraph({ children: [new TextRun('Documentation : '), new ExternalHyperlink({ link: P.linkHref, children: [new TextRun({ text: P.linkLabel, style: 'Hyperlink' })] })] }),
      ],
    }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

export async function procOdt(): Promise<Uint8Array> {
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&apos;');
  const p = (t: string, style = '') => `<text:p${style ? ` text:style-name="${style}"` : ''}>${esc(t)}</text:p>`;
  const li = (inner: string) => `<text:list-item>${inner}</text:list-item>`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS} office:version="1.3">
<office:automatic-styles>
<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="Pcode" style:family="paragraph" style:parent-style-name="Preformatted_20_Text"><style:text-properties style:font-name="Liberation Mono" fo:font-family="'Liberation Mono'"/></style:style>
<text:list-style style:name="LNum"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."/><text:list-level-style-bullet text:level="2" text:bullet-char="•"/></text:list-style>
<text:list-style style:name="LBul"><text:list-level-style-bullet text:level="1" text:bullet-char="•"/></text:list-style>
</office:automatic-styles>
<office:body><office:text>
<text:h text:outline-level="1">${esc(P.title)}</text:h>
${p(P.intro)}
<text:h text:outline-level="2">${esc(P.prereqTitle)}</text:h>
<text:list text:style-name="LBul">${P.prereqs.map((t) => li(p(t))).join('')}</text:list>
<text:h text:outline-level="2">${esc(P.stepsTitle)}</text:h>
<text:list text:style-name="LNum">${li(p(P.steps[0]))}${li(p(P.steps[1]) + `<text:list>${li(p(P.subStep))}</text:list>`)}${li(p(P.steps[2]))}</text:list>
<text:p><draw:frame draw:name="ecran" text:anchor-type="as-char" svg:width="4cm" svg:height="2cm"><draw:image xlink:href="Pictures/ecran.png" xlink:type="simple"/><svg:title>${esc(P.imageAlt)}</svg:title></draw:frame></text:p>
<text:h text:outline-level="2">${esc(P.paramsTitle)}</text:h>
<table:table table:name="Parametres"><table:table-column table:number-columns-repeated="2"/>
<table:table-header-rows><table:table-row>${P.table[0].map((c) => `<table:table-cell office:value-type="string">${p(c)}</table:table-cell>`).join('')}</table:table-row></table:table-header-rows>
${P.table.slice(1).map((r) => `<table:table-row>${r.map((c) => `<table:table-cell office:value-type="string">${p(c)}</table:table-cell>`).join('')}</table:table-row>`).join('')}
</table:table>
<text:h text:outline-level="2">${esc(P.codeTitle)}</text:h>
${p(P.code, 'Pcode')}
<text:p><text:span text:style-name="T1">Attention :</text:span>${esc(P.warning.replace('Attention :', ''))}</text:p>
<text:p>Documentation : <text:a xlink:type="simple" xlink:href="${P.linkHref}">${P.linkLabel}</text:a></text:p>
</office:text></office:body></office:document-content>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS} office:version="1.3"><office:styles><style:style style:name="Preformatted_20_Text" style:display-name="Preformatted Text" style:family="paragraph"><style:text-properties style:font-name="Liberation Mono"/></style:style></office:styles></office:document-styles>`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="Pictures/ecran.png" manifest:media-type="image/png"/></manifest:manifest>`;
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.file('META-INF/manifest.xml', manifest);
  zip.file('content.xml', content);
  zip.file('styles.xml', styles);
  zip.file('Pictures/ecran.png', SCREEN_PNG);
  return zip.generateAsync({ type: 'uint8array' });
}

export async function procPptx(): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.defineSlideMaster({
    title: 'PROC',
    objects: [
      { placeholder: { options: { name: 'title', type: 'title', x: 0.5, y: 0.3, w: 9, h: 0.8 }, text: '' } },
      { placeholder: { options: { name: 'body', type: 'body', x: 0.5, y: 1.3, w: 9, h: 2.5 }, text: '' } },
    ],
  });
  let s = pptx.addSlide({ masterName: 'PROC' });
  s.addText(P.title, { placeholder: 'title' });
  s.addText(P.intro, { x: 0.5, y: 1.3, w: 9, h: 1, fontSize: 18 });
  s = pptx.addSlide({ masterName: 'PROC' });
  s.addText(P.prereqTitle, { placeholder: 'title' });
  s.addText(P.prereqs.map((t) => ({ text: t, options: { bullet: true } })), { placeholder: 'body' });
  s = pptx.addSlide({ masterName: 'PROC' });
  s.addText(P.stepsTitle, { placeholder: 'title' });
  s.addText([
    { text: P.steps[0], options: { bullet: { type: 'number' } } },
    { text: P.steps[1], options: { bullet: { type: 'number' } } },
    { text: P.subStep, options: { bullet: true, indentLevel: 1 } },
    { text: P.steps[2], options: { bullet: { type: 'number' } } },
  ], { placeholder: 'body' });
  s.addImage({ data: `image/png;base64,${b64(SCREEN_PNG)}`, x: 0.5, y: 4.0, w: 2, h: 1, altText: P.imageAlt });
  s = pptx.addSlide({ masterName: 'PROC' });
  s.addText(P.paramsTitle, { placeholder: 'title' });
  s.addTable(P.table.map((r, i) => r.map((c) => ({ text: c, options: { bold: i === 0 } }))), { x: 0.5, y: 1.3, w: 6 });
  s = pptx.addSlide({ masterName: 'PROC' });
  s.addText(P.codeTitle, { placeholder: 'title' });
  s.addText(P.code, { x: 0.5, y: 1.3, w: 9, h: 0.6, fontFace: 'Courier New', fontSize: 14 });
  s.addText(P.warning, { x: 0.5, y: 2.2, w: 9, h: 0.6, fontSize: 14 });
  s.addText([{ text: 'Documentation : ' }, { text: P.linkLabel, options: { hyperlink: { url: P.linkHref } } }], { x: 0.5, y: 3.0, w: 9, h: 0.6, fontSize: 14 });
  const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  return new Uint8Array(out);
}

export async function procXlsx(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(P.paramsTitle);
  P.table.forEach((r, i) => {
    const row = ws.addRow(r);
    if (i === 0) row.font = { bold: true };
  });
  ws.addRow(['Mise à jour', new Date(Date.UTC(2026, 0, 15))]);
  ws.getCell('B4').numFmt = 'dd/mm/yyyy';
  ws.addRow(['Remarque fusionnée']);
  ws.mergeCells('A5:B5');
  const hidden = wb.addWorksheet('Brouillon');
  hidden.state = 'hidden';
  hidden.addRow(['ne doit pas apparaître']);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** PDF « texte » : titres en gras plus grands, puces, numéros, capture, tableau tracé, code en Courier, lien cliquable. */
export async function procPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const img = await pdf.embedPng(SCREEN_PNG);
  const page = pdf.addPage([595, 842]);
  let y = 780;
  const line = (t: string, f = font, size = 11, x = 50, gap = 16) => { page.drawText(t, { x, y, size, font: f }); y -= gap; };
  line(P.title, bold, 20, 50, 34);
  line(P.intro, font, 11, 50, 28);
  line(P.prereqTitle, bold, 14, 50, 22);
  P.prereqs.forEach((t) => line(`• ${t}`, font, 11, 60));
  y -= 12;
  line(P.stepsTitle, bold, 14, 50, 22);
  line(`1. ${P.steps[0]}`, font, 11, 60);
  line(`2. ${P.steps[1]}`, font, 11, 60);
  line(`• ${P.subStep}`, font, 11, 80);
  line(`3. ${P.steps[2]}`, font, 11, 60, 20);
  page.drawImage(img, { x: 50, y: y - 80, width: 160, height: 80 });
  y -= 104;
  line(P.paramsTitle, bold, 14, 50, 22);
  const top = y + 12;
  P.table.forEach((r, i) => { page.drawText(r[0], { x: 56, y, size: 11, font: i === 0 ? bold : font }); page.drawText(r[1], { x: 206, y, size: 11, font: i === 0 ? bold : font }); y -= 18; });
  for (let k = 0; k <= P.table.length; k++) page.drawLine({ start: { x: 50, y: top - k * 18 }, end: { x: 350, y: top - k * 18 }, thickness: 0.5, color: rgb(0, 0, 0) });
  for (const x of [50, 200, 350]) page.drawLine({ start: { x, y: top }, end: { x, y: top - P.table.length * 18 }, thickness: 0.5, color: rgb(0, 0, 0) });
  y -= 14;
  line(P.codeTitle, bold, 14, 50, 22);
  line(P.code, mono, 10, 50, 26);
  line(P.warning, font, 11, 50, 22);
  const label = 'Documentation : ';
  page.drawText(label + P.linkHref, { x: 50, y, size: 11, font });
  const lx = 50 + font.widthOfTextAtSize(label, 11);
  const annot = pdf.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [lx, y - 2, lx + font.widthOfTextAtSize(P.linkHref, 11), y + 11], Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFString.of(P.linkHref) },
  });
  page.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(annot)]));
  return pdf.save();
}

/** PDF scanné à partir d'une capture PNG d'une page. */
export async function scannedPdfFrom(png: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(png);
  const page = pdf.addPage([595, 842]);
  page.drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
  return pdf.save();
}
