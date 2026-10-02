import type { AdmonitionKind, Block, DocumentModel, Inline, ParagraphBlock } from './types';
import { inlinesToPlainText } from './types';

/** Mots-clés déclenchant une admonition (déterministe, configurable). */
export const ADMONITION_KEYWORDS: Record<string, AdmonitionKind> = {
  attention: 'warning',
  avertissement: 'warning',
  warning: 'warning',
  caution: 'warning',
  achtung: 'warning',
  warnung: 'warning',
  important: 'warning',
  note: 'note',
  remarque: 'note',
  hinweis: 'note',
  nb: 'note',
  info: 'info',
  information: 'info',
  astuce: 'tip',
  conseil: 'tip',
  tip: 'tip',
  tipp: 'tip',
};

export interface NormalizeOptions {
  promoteFirstHeadingToTitle?: boolean;
  detectAdmonitions?: boolean;
  /** Base des noms d'images : « Procédure VPN » → « Procédure VPN-1.png ». Défaut : « image ». */
  imageBaseName?: string;
}

/** Nom de base sûr pour les fichiers image, dérivé du nom du document (accents et espaces conservés). */
export function imageBaseNameFrom(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|#[\]{}\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return base || 'document';
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/g;

/** Transforme les adresses web écrites en clair dans le texte en vrais liens (hors code et liens existants). */
export function autolink(inlines: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const i of inlines) {
    if (i.type !== 'text' || i.code || !i.text || !/https?:\/\//.test(i.text)) { out.push(i); continue; }
    let last = 0;
    for (const m of i.text.matchAll(URL_RE)) {
      const start = m.index ?? 0;
      if (start > last) out.push({ ...i, text: i.text.slice(last, start) });
      out.push({ type: 'link', href: m[0], children: [{ ...i, text: m[0] }] });
      last = start + m[0].length;
    }
    if (last < i.text.length) out.push({ ...i, text: i.text.slice(last) });
  }
  return out;
}

/** Fusionne les inlines adjacents ayant les mêmes attributs et nettoie les espaces. */
export function mergeInlines(inlines: Inline[], insideLink = false): Inline[] {
  const out: Inline[] = [];
  for (const raw of insideLink ? inlines : autolink(inlines)) {
    const i: Inline = { ...raw };
    if (i.type === 'link') i.children = mergeInlines((i.children ?? []).map((c) => (c.type === 'text' ? { ...c, underline: false } : c)), true);
    if (i.type === 'text') {
      if (!i.text) continue;
      i.text = i.text.replace(/[ \t ]+/g, ' ');
    }
    const prev = out[out.length - 1];
    if (prev && prev.type === 'text' && i.type === 'text' && sameAttrs(prev, i)) {
      prev.text = (prev.text ?? '') + (i.text ?? '');
    } else {
      out.push(i);
    }
  }
  // trim des extrémités
  if (out.length) {
    const first = out[0];
    if (first.type === 'text') first.text = first.text!.replace(/^\s+/, '');
    const last = out[out.length - 1];
    if (last.type === 'text') last.text = last.text!.replace(/\s+$/, '');
  }
  return out.filter((i) => i.type !== 'text' || i.text !== '');
}

function sameAttrs(a: Inline, b: Inline): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline && !!a.strike === !!b.strike && !!a.code === !!b.code;
}

function normalizeBlocks(blocks: Block[], opts: NormalizeOptions): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading': {
        const inl = mergeInlines(b.inlines);
        if (!inlinesToPlainText(inl).trim()) continue;
        out.push({ ...b, inlines: inl });
        break;
      }
      case 'paragraph': {
        const inl = mergeInlines(b.inlines);
        if (!inlinesToPlainText(inl).trim()) continue;
        const adm = opts.detectAdmonitions !== false ? detectAdmonition({ ...b, inlines: inl }) : null;
        out.push(adm ?? { ...b, inlines: inl });
        break;
      }
      case 'list': {
        const items = b.items.map((it) => ({ blocks: normalizeBlocks(it.blocks, opts) })).filter((it) => it.blocks.length);
        if (items.length) out.push({ ...b, items });
        break;
      }
      case 'table': {
        // Le gras est implicite dans une cellule d'en-tête : on ne le répète pas.
        const unbold = (bs: Block[]): Block[] => bs.map((x) => (x.type === 'paragraph' ? { ...x, inlines: x.inlines.map((i) => (i.type === 'text' ? { ...i, bold: false } : i)) } : x));
        const rows = b.rows.map((r) => ({ cells: r.cells.map((c) => ({ ...c, blocks: normalizeBlocks(c.header ? unbold(c.blocks) : c.blocks, { ...opts, detectAdmonitions: false }) })) }));
        if (rows.length && rows.some((r) => r.cells.length)) out.push({ ...b, rows, caption: b.caption ? mergeInlines(b.caption) : undefined });
        break;
      }
      case 'admonition':
      case 'quote': {
        const inner = normalizeBlocks(b.blocks, { ...opts, detectAdmonitions: false });
        if (inner.length) out.push({ ...b, blocks: inner });
        break;
      }
      case 'code': {
        if (b.text.trim()) out.push({ ...b, text: b.text.replace(/\s+$/, '') });
        break;
      }
      default:
        out.push(b);
    }
  }
  return out;
}

const ADM_RE = /^\s*([A-Za-zÀ-ÿ]{2,16})\s*[:：!]\s*(.*)$/s;

function detectAdmonition(p: ParagraphBlock): Block | null {
  const plain = inlinesToPlainText(p.inlines);
  const m = ADM_RE.exec(plain);
  if (!m) return null;
  const kind = ADMONITION_KEYWORDS[m[1].toLowerCase()];
  if (!kind) return null;
  const body = m[2].trim();
  if (!body) return null;
  // Reconstruit les inlines sans le mot-clé : on retire les premiers caractères.
  const prefixLen = plain.length - plain.slice(m.index + m[0].length - m[2].length).length;
  const inlines = dropLeadingChars(p.inlines, prefixLen);
  return { type: 'admonition', kind, title: m[1], blocks: [{ type: 'paragraph', inlines: mergeInlines(inlines) }] };
}

function dropLeadingChars(inlines: Inline[], n: number): Inline[] {
  const out: Inline[] = [];
  let remaining = n;
  for (const i of inlines) {
    if (remaining <= 0) { out.push(i); continue; }
    if (i.type === 'text') {
      const t = i.text ?? '';
      if (t.length <= remaining) { remaining -= t.length; continue; }
      out.push({ ...i, text: t.slice(remaining) });
      remaining = 0;
    } else if (i.type === 'link') {
      const t = inlinesToPlainText(i.children ?? []);
      if (t.length <= remaining) { remaining -= t.length; continue; }
      out.push({ ...i, children: dropLeadingChars(i.children ?? [], remaining) });
      remaining = 0;
    } else {
      remaining -= 1;
    }
  }
  return out;
}

/** Rend les niveaux de titres contigus (1,3,4 → 1,2,3). */
function relevelHeadings(blocks: Block[]): void {
  const levels = new Set<number>();
  const visit = (bs: Block[]) => {
    for (const b of bs) {
      if (b.type === 'heading') levels.add(b.level);
      else if (b.type === 'list') b.items.forEach((it) => visit(it.blocks));
      else if (b.type === 'admonition' || b.type === 'quote') visit(b.blocks);
    }
  };
  visit(blocks);
  const sorted = [...levels].sort((a, b) => a - b);
  const map = new Map<number, number>();
  sorted.forEach((l, idx) => map.set(l, Math.min(idx + 1, 6)));
  const apply = (bs: Block[]) => {
    for (const b of bs) {
      if (b.type === 'heading') b.level = map.get(b.level) ?? b.level;
      else if (b.type === 'list') b.items.forEach((it) => apply(it.blocks));
      else if (b.type === 'admonition' || b.type === 'quote') apply(b.blocks);
    }
  };
  apply(blocks);
}

export function normalizeDocument(doc: DocumentModel, opts: NormalizeOptions = {}): DocumentModel {
  let blocks = normalizeBlocks(doc.blocks, opts);
  relevelHeadings(blocks);
  let title = doc.metadata.title;
  if (!title && blocks.length && blocks[0].type === 'heading' && blocks[0].level === 1) {
    // Le premier titre sert de titre de document ; il est retiré du contenu seulement si demandé.
    title = inlinesToPlainText(blocks[0].inlines).trim();
    if (opts.promoteFirstHeadingToTitle === true && blocks.filter((b) => b.type === 'heading' && b.level === 1).length === 1) {
      blocks = blocks.slice(1);
      relevelHeadings(blocks);
    }
  }
  // Images : ne garder que celles référencées, renommer dans l'ordre d'apparition.
  const order: string[] = [];
  const collect = (bs: Block[]) => {
    for (const b of bs) {
      if (b.type === 'image' && !order.includes(b.imageId)) order.push(b.imageId);
      else if (b.type === 'list') b.items.forEach((it) => collect(it.blocks));
      else if (b.type === 'table') b.rows.forEach((r) => r.cells.forEach((c) => collect(c.blocks)));
      else if (b.type === 'admonition' || b.type === 'quote') collect(b.blocks);
    }
  };
  collect(blocks);
  const byId = new Map(doc.images.map((im) => [im.id, im]));
  const images = order
    .map((id) => byId.get(id))
    .filter((im): im is NonNullable<typeof im> => !!im)
    .map((im, idx) => ({ ...im, filename: `${opts.imageBaseName ?? 'image'}-${idx + 1}.${extFor(im.mime)}` }));
  return { ...doc, metadata: { ...doc.metadata, title: title || null }, blocks, images };
}

export function extFor(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/bmp': return 'bmp';
    case 'image/tiff': return 'tif';
    default: return 'png';
  }
}
