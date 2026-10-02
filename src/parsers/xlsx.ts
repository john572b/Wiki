import type { DocumentModel, TableCell, TableRow } from '../model/types';
import { emptyDocument } from '../model/types';
import { attr, desc, descAll, kids, openZip, readRels, readXml, relAttr } from './ooxml';

export const MAX_XLSX_CELLS = 50_000;

/** Classeur Excel → un titre et un tableau par feuille visible (valeurs affichées, fusions, en-tête). */
export async function parseXlsx(buffer: ArrayBuffer, opts: { sourceFilename: string }): Promise<DocumentModel> {
  const zip = await openZip(buffer);
  const doc = emptyDocument(opts.sourceFilename, 'xlsx');
  const wb = await readXml(zip, 'xl/workbook.xml');
  if (!wb) throw new Error('DOCX_NO_DOCUMENT');
  const rels = await readRels(zip, 'xl/workbook.xml');
  const shared = await sharedStrings(zip);
  const styles = await cellStyles(zip);
  let cellBudget = MAX_XLSX_CELLS;
  for (const sh of descAll(wb.documentElement, 'sheet')) {
    if (attr(sh, 'state') === 'hidden' || attr(sh, 'state') === 'veryHidden') continue;
    const name = attr(sh, 'name') ?? 'Feuille';
    const rel = rels.get(relAttr(sh) ?? '');
    if (!rel) continue;
    const sheet = await readXml(zip, rel.target);
    if (!sheet) continue;
    const grid = new Map<string, { value: string; bold: boolean }>();
    let maxR = 0, maxC = 0, minR = Infinity, minC = Infinity;
    for (const c of descAll(sheet.documentElement, 'c')) {
      if (cellBudget-- <= 0) break;
      const ref = attr(c, 'r');
      if (!ref) continue;
      const [r, col] = refToRC(ref);
      const value = cellValue(c, shared, styles);
      if (value === '') continue;
      const s = Number(attr(c, 's') ?? '0');
      grid.set(`${r}:${col}`, { value, bold: styles.bold[s] ?? false });
      maxR = Math.max(maxR, r); maxC = Math.max(maxC, col); minR = Math.min(minR, r); minC = Math.min(minC, col);
    }
    if (!grid.size) continue;
    // Fusions
    const merges = new Map<string, { rows: number; cols: number }>();
    const covered = new Set<string>();
    for (const m of descAll(sheet.documentElement, 'mergeCell')) {
      const [a, b] = (attr(m, 'ref') ?? '').split(':');
      if (!a || !b) continue;
      const [r1, c1] = refToRC(a), [r2, c2] = refToRC(b);
      merges.set(`${r1}:${c1}`, { rows: r2 - r1 + 1, cols: c2 - c1 + 1 });
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) covered.add(`${r}:${c}`);
      maxR = Math.max(maxR, r2); maxC = Math.max(maxC, c2);
    }
    const rows: TableRow[] = [];
    for (let r = minR; r <= maxR; r++) {
      const cells: TableCell[] = [];
      let any = false;
      for (let c = minC; c <= maxC; c++) {
        const key = `${r}:${c}`;
        if (covered.has(key)) continue;
        const cell = grid.get(key);
        const span = merges.get(key);
        if (cell) any = true;
        cells.push({
          blocks: cell ? [{ type: 'paragraph', inlines: [{ type: 'text', text: cell.value }] }] : [],
          header: false,
          colspan: span ? Math.min(span.cols, maxC - c + 1) : 1,
          rowspan: span ? span.rows : 1,
        });
      }
      if (any) rows.push({ cells });
    }
    // En-tête : première ligne en gras, ou première ligne entièrement textuelle suivie de données.
    if (rows.length > 1) {
      const firstKeys = Array.from({ length: maxC - minC + 1 }, (_, i) => grid.get(`${minR}:${minC + i}`)).filter(Boolean);
      const allBold = firstKeys.length > 0 && firstKeys.every((c) => c!.bold);
      const allText = firstKeys.length > 0 && firstKeys.every((c) => isNaN(Number(c!.value)));
      if (allBold || allText) rows[0].cells.forEach((c) => (c.header = true));
    }
    doc.blocks.push({ type: 'heading', level: 1, inlines: [{ type: 'text', text: name }] });
    doc.blocks.push({ type: 'table', rows });
  }
  if (cellBudget <= 0) doc.metadata.warnings.push({ code: 'XLSX_TRUNCATED', message: `Classeur tronqué à ${MAX_XLSX_CELLS} cellules.` });
  return doc;
}

async function sharedStrings(zip: import('jszip')): Promise<string[]> {
  const d = await readXml(zip, 'xl/sharedStrings.xml');
  if (!d) return [];
  return descAll(d.documentElement, 'si').map((si) => descAll(si, 't').filter((t) => t.parentElement?.localName !== 'rPh').map((t) => t.textContent ?? '').join(''));
}

interface Styles { bold: boolean[]; isDate: boolean[] }

async function cellStyles(zip: import('jszip')): Promise<Styles> {
  const d = await readXml(zip, 'xl/styles.xml');
  const res: Styles = { bold: [], isDate: [] };
  if (!d) return res;
  const fonts = kids(desc(d.documentElement, 'fonts'), 'font').map((f) => kids(f, 'b').some((b) => attr(b, 'val') !== '0' && attr(b, 'val') !== 'false'));
  const customDate = new Set<number>();
  for (const nf of descAll(desc(d.documentElement, 'numFmts'), 'numFmt')) {
    const code = (attr(nf, 'formatCode') ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '');
    if (/[dmy]/i.test(code) && !/^[#0.,% ]+$/.test(code)) customDate.add(Number(attr(nf, 'numFmtId')));
  }
  for (const xf of kids(desc(d.documentElement, 'cellXfs'), 'xf')) {
    const id = Number(attr(xf, 'numFmtId') ?? '0');
    res.bold.push(fonts[Number(attr(xf, 'fontId') ?? '0')] ?? false);
    res.isDate.push((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || customDate.has(id));
  }
  return res;
}

function cellValue(c: Element, shared: string[], styles: Styles): string {
  const t = attr(c, 't');
  const v = desc(c, 'v')?.textContent ?? '';
  if (t === 's') return (shared[Number(v)] ?? '').trim();
  if (t === 'inlineStr') return descAll(c, 't').map((x) => x.textContent ?? '').join('').trim();
  if (t === 'b') return v === '1' ? 'VRAI' : 'FAUX';
  if (t === 'str' || t === 'e') return v.trim();
  if (v === '') return '';
  const n = Number(v);
  if (!isNaN(n) && styles.isDate[Number(attr(c, 's') ?? '0')]) return excelDate(n);
  if (!isNaN(n)) return String(Math.round(n * 1e10) / 1e10);
  return v;
}

/** Numéro de série Excel → date ISO (avec l'heure si présente). */
export function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  const iso = d.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
}

/** « B12 » → [12, 2] */
export function refToRC(ref: string): [number, number] {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref);
  if (!m) return [0, 0];
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]), col];
}
