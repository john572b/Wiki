/**
 * Corpus de test synthétique et reproductible (aucun document confidentiel).
 */
import { deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  AlignmentType, Document, ExternalHyperlink, HeadingLevel, ImageRun, LevelFormat, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';

/** PNG RGB uni (encodeur minimal, sans dépendance). */
export function makePng(width: number, height: number, color: [number, number, number]): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      // Petit motif pour que deux images de couleurs différentes aient des hachages différents.
      raw[o] = color[0]; raw[o + 1] = color[1]; raw[o + 2] = (color[2] + ((x ^ y) & 1) * 8) & 255;
    }
  }
  const chunks: Buffer[] = [];
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    chunks.push(len, td, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunk('IHDR', ihdr);
  chunk('IDAT', deflateSync(raw));
  chunk('IEND', Buffer.alloc(0));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]));
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

export async function makeDocx(): Promise<Uint8Array> {
  const img1 = makePng(120, 60, [200, 30, 30]);
  const img2 = makePng(80, 80, [30, 30, 200]);
  const doc = new Document({
    title: 'Procédure VPN',
    styles: { paragraphStyles: [{ id: 'Code', name: 'Code', basedOn: 'Normal', run: { font: 'Courier New', size: 20 } }] },
    numbering: {
      config: [
        { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•' }, { level: 1, format: LevelFormat.BULLET, text: '◦' }] },
        { reference: 'numbers', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.' }] },
      ],
    },
    sections: [
      {
        children: [
          new Paragraph({ text: 'Configuration réseau', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun('Cliquez sur '), new TextRun({ text: 'Configuration', bold: true }), new TextRun(' puis '), new TextRun({ text: 'Réseau', italics: true }), new TextRun('.')] }),
          new Paragraph({ children: [new ImageRun({ type: 'png', data: img1, transformation: { width: 120, height: 60 }, altText: { title: 'Écran 1', description: 'Capture de configuration', name: 'ecran1' } })] }),
          new Paragraph({ text: 'Étapes', heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: 'Ouvrir le menu', numbering: { reference: 'numbers', level: 0 } }),
          new Paragraph({ text: 'Choisir le profil', numbering: { reference: 'numbers', level: 0 } }),
          new Paragraph({ text: 'Puce A', numbering: { reference: 'bullets', level: 0 } }),
          new Paragraph({ text: 'Sous-puce', numbering: { reference: 'bullets', level: 1 } }),
          new Paragraph({ text: 'Puce B', numbering: { reference: 'bullets', level: 0 } }),
          new Paragraph({ text: 'Attention : ne pas redémarrer pendant la mise à jour.' }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({ tableHeader: true, children: [new TableCell({ children: [new Paragraph('Paramètre')] }), new TableCell({ children: [new Paragraph('Valeur')] })] }),
              new TableRow({ children: [new TableCell({ children: [new Paragraph('Serveur')] }), new TableCell({ children: [new Paragraph('vpn.example.org')] })] }),
              new TableRow({ children: [new TableCell({ columnSpan: 2, children: [new Paragraph('Cellule fusionnée')] })] }),
            ],
          }),
          new Paragraph({ children: [new ImageRun({ type: 'png', data: img2, transformation: { width: 80, height: 80 }, altText: { title: 'Écran 2', description: 'Deuxième capture', name: 'ecran2' } })] }),
          new Paragraph({ style: 'Code', text: 'sudo systemctl restart openvpn' }),
          new Paragraph({ style: 'Code', text: 'journalctl -u openvpn -f' }),
          new Paragraph({ children: [new TextRun('Documentation : '), new ExternalHyperlink({ link: 'https://example.org/doc', children: [new TextRun({ text: 'site officiel', style: 'Hyperlink' })] })] }),
          new Paragraph({ alignment: AlignmentType.LEFT, text: 'Fin du document.' }),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

/** PDF texte : 2 pages, en-tête/pied répétés, titres par taille, liste, image entre deux paragraphes. */
export async function makeTextPdf(marker = 'ALPHA'): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Procédure ${marker}`);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const png = await pdf.embedPng(makePng(200, 100, [20, 160, 60]));
  for (let p = 1; p <= 2; p++) {
    const page = pdf.addPage([595, 842]);
    page.drawText('Société Exemple - Documentation interne', { x: 50, y: 810, size: 9, font });
    page.drawText(`Page ${p} / 2`, { x: 500, y: 30, size: 9, font });
    let y = 760;
    if (p === 1) {
      page.drawText(`Installation ${marker}`, { x: 50, y, size: 20, font: bold }); y -= 40;
      page.drawText('Prérequis', { x: 50, y, size: 14, font: bold }); y -= 24;
      page.drawText('Ce document décrit la procédure complète. Elle comporte plusieurs', { x: 50, y, size: 11, font }); y -= 15;
      page.drawText('étapes à suivre dans l\'ordre indiqué ci-dessous.', { x: 50, y, size: 11, font }); y -= 30;
      page.drawText('• Disposer d\'un compte administrateur', { x: 60, y, size: 11, font }); y -= 15;
      page.drawText('• Avoir installé le client', { x: 60, y, size: 11, font }); y -= 30;
      page.drawImage(png, { x: 50, y: y - 100, width: 200, height: 100 }); y -= 125;
      page.drawText('Étape suivante', { x: 50, y, size: 14, font: bold }); y -= 24;
      page.drawText('Après l\'image, continuez la configuration.', { x: 50, y, size: 11, font }); y -= 30;
      page.drawText('apt-get install client-vpn', { x: 50, y, size: 10, font: mono }); y -= 14;
      page.drawText('systemctl enable client-vpn', { x: 50, y, size: 10, font: mono });
    } else {
      page.drawText('Annexe', { x: 50, y, size: 14, font: bold }); y -= 24;
      page.drawText(`Texte de la seconde page ${marker}.`, { x: 50, y, size: 11, font });
    }
  }
  return pdf.save();
}

/** PDF scanné : une page contenant uniquement une image (fournie, ex. capture d'un texte rendu). */
export async function makeScannedPdf(pngData: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const png = await pdf.embedPng(pngData);
  const page = pdf.addPage([595, 842]);
  page.drawImage(png, { x: 0, y: 0, width: 595, height: 842 });
  return pdf.save();
}

/** PDF mixte : page 1 texte, page 2 scannée. */
export async function makeMixedPdf(pngData: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const p1 = pdf.addPage([595, 842]);
  p1.drawText('Page texte', { x: 50, y: 760, size: 18, font: bold });
  p1.drawText('Ce paragraphe est extrait directement.', { x: 50, y: 720, size: 11, font });
  const png = await pdf.embedPng(pngData);
  const p2 = pdf.addPage([595, 842]);
  p2.drawImage(png, { x: 0, y: 0, width: 595, height: 842 });
  return pdf.save();
}

export { rgb };
