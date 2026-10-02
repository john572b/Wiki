import type { Block, DocumentModel, Inline, ListBlock } from '../model/types';
import { emptyDocument } from '../model/types';

const BULLET_RE = /^(\s*)([-*•·▪+–])\s+(.+)$/;
const ORDERED_RE = /^(\s*)(\d{1,3}|[a-z])[.)]\s+(.+)$/i;

/**
 * Texte brut → DocumentModel par règles simples :
 * - titres soulignés (=== ou ---) ou lignes courtes en majuscules isolées ;
 * - listes à puces (-, *, •) ou numérotées (1. / a)), imbriquées selon l'indentation ;
 * - blocs indentés de 4 espaces ou d'une tabulation = code ;
 * - le reste = paragraphes (lignes jointes).
 */
export function parseText(text: string, opts: { sourceFilename: string }): DocumentModel {
  const doc = emptyDocument(opts.sourceFilename, 'text');
  const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const isBlank = (l: string | undefined) => l === undefined || l.trim() === '';
  while (i < lines.length) {
    if (isBlank(lines[i])) { i++; continue; }
    const line = lines[i];
    const next = lines[i + 1];
    // Titre souligné
    if (next !== undefined && /^\s*(=+|-+)\s*$/.test(next) && next.trim().length >= 3 && line.trim().length <= 120 && !BULLET_RE.test(line)) {
      blocks.push({ type: 'heading', level: next.trim()[0] === '=' ? 1 : 2, inlines: [{ type: 'text', text: line.trim() }] });
      i += 2;
      continue;
    }
    // Code indenté
    if (/^ {4}/.test(line) && !BULLET_RE.test(line) && !ORDERED_RE.test(line)) {
      const code: string[] = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]) || (isBlank(lines[i]) && /^ {4}/.test(lines[i + 1] ?? '')))) code.push(lines[i++].slice(4));
      blocks.push({ type: 'code', text: code.join('\n').replace(/\s+$/, '') });
      continue;
    }
    // Liste
    if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
      const items: { indent: number; ordered: boolean; text: string }[] = [];
      while (i < lines.length && !isBlank(lines[i])) {
        const b = BULLET_RE.exec(lines[i]);
        const o = b ? null : ORDERED_RE.exec(lines[i]);
        if (b || o) {
          const m = (b ?? o)!;
          items.push({ indent: m[1].length, ordered: !!o, text: m[3].trim() });
        } else if (items.length) {
          items[items.length - 1].text += ' ' + lines[i].trim();
        }
        i++;
      }
      blocks.push(...buildLists(items));
      continue;
    }
    // Titre en majuscules isolé (ligne seule entre deux lignes vides)
    if (isBlank(lines[i - 1]) && isBlank(next) && line.trim().length <= 60 && /^[A-ZÀ-Ý0-9 &'’\-/]+$/.test(line.trim()) && /[A-ZÀ-Ý]{3}/.test(line)) {
      blocks.push({ type: 'heading', level: 2, inlines: [{ type: 'text', text: line.trim() }] });
      i++;
      continue;
    }
    // Paragraphe
    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && !BULLET_RE.test(lines[i]) && !ORDERED_RE.test(lines[i]) && !/^\s*(=+|-+)\s*$/.test(lines[i + 1] ?? 'x')) {
      para.push(lines[i++].trim());
    }
    if (!para.length) { para.push(lines[i++].trim()); }
    // Lignes courtes (adresse, « clé : valeur ») : on garde les retours à la ligne.
    if (para.length > 1 && para.every((l) => l.length <= 50)) {
      const inl: Inline[] = [];
      para.forEach((l, k) => { if (k) inl.push({ type: 'br' }); inl.push({ type: 'text', text: l }); });
      blocks.push({ type: 'paragraph', inlines: inl });
    } else {
      blocks.push({ type: 'paragraph', inlines: [{ type: 'text', text: para.join(' ') }] });
    }
  }
  doc.blocks = blocks;
  return doc;
}

function buildLists(items: { indent: number; ordered: boolean; text: string }[]): Block[] {
  const root: ListBlock[] = [];
  const stack: { indent: number; list: ListBlock }[] = [];
  for (const it of items) {
    while (stack.length && stack[stack.length - 1].indent > it.indent) stack.pop();
    let cur = stack[stack.length - 1];
    if (!cur || cur.indent < it.indent) {
      const list: ListBlock = { type: 'list', ordered: it.ordered, items: [] };
      if (cur) {
        if (!cur.list.items.length) cur.list.items.push({ blocks: [] });
        cur.list.items[cur.list.items.length - 1].blocks.push(list);
      } else root.push(list);
      stack.push({ indent: it.indent, list });
      cur = stack[stack.length - 1];
    }
    cur.list.items.push({ blocks: [{ type: 'paragraph', inlines: [{ type: 'text', text: it.text }] }] });
  }
  return root;
}
