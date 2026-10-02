import type { DocumentModel, TableRow } from '../model/types';
import { emptyDocument } from '../model/types';

export const MAX_CSV_ROWS = 5000;

/** Détecte le séparateur le plus fréquent sur la première ligne (hors guillemets). */
export function detectDelimiter(text: string, hint?: string): string {
  if (hint) return hint;
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  let best = ',', bestCount = -1;
  for (const d of [';', ',', '\t', '|']) {
    let count = 0, quoted = false;
    for (const ch of first) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count++;
    }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

/** Analyse CSV (RFC 4180) : guillemets, guillemets doublés, retours à la ligne dans les champs. */
export function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function parseCsv(text: string, opts: { sourceFilename: string; tab?: boolean }): DocumentModel {
  const doc = emptyDocument(opts.sourceFilename, 'csv');
  let rows = parseCsvRows(text, detectDelimiter(text, opts.tab ? '\t' : undefined));
  if (rows.length > MAX_CSV_ROWS) {
    doc.metadata.warnings.push({ code: 'CSV_TRUNCATED', message: `Fichier tronqué à ${MAX_CSV_ROWS} lignes sur ${rows.length}.` });
    rows = rows.slice(0, MAX_CSV_ROWS);
  }
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const tableRows: TableRow[] = rows.map((r, ri) => ({
    cells: Array.from({ length: cols }, (_, ci) => ({
      blocks: (r[ci] ?? '').trim() ? [{ type: 'paragraph' as const, inlines: [{ type: 'text' as const, text: (r[ci] ?? '').trim() }] }] : [],
      header: ri === 0 && rows.length > 1,
      colspan: 1,
      rowspan: 1,
    })),
  }));
  if (tableRows.length) doc.blocks = [{ type: 'table', rows: tableRows }];
  return doc;
}
