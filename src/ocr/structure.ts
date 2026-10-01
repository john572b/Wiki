import type { Block, Inline } from '../model/types';

/** Structure neutre renvoyée par un moteur OCR (indépendante de Tesseract). */
export interface OcrLine { text: string; x0: number; y0: number; x1: number; y1: number; confidence: number }
export interface OcrParagraph { lines: OcrLine[] }
export interface OcrBlock { paragraphs: OcrParagraph[] }
export interface OcrPage { width: number; height: number; blocks: OcrBlock[]; meanConfidence: number }

const BULLET_RE = /^([•·▪■●○◦‣➢➤\-–—*+]|[o]\s)\s*(.+)$/;
const ORDERED_RE = /^(\d{1,3}[.)]|[a-z][.)]|[ivx]{1,5}[.)])\s+(.+)$/i;

/**
 * Transforme une page OCR en blocs du DocumentModel par règles :
 * titres par hauteur de ligne, listes par puces, paragraphes par regroupement Tesseract.
 */
export function ocrPageToBlocks(page: OcrPage): Block[] {
  const allLines = page.blocks.flatMap((b) => b.paragraphs.flatMap((p) => p.lines)).filter((l) => l.text.trim());
  if (!allLines.length) return [];
  const heights = allLines.map((l) => l.y1 - l.y0).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 1;
  const headingSizes = new Set<number>();
  const out: Block[] = [];
  let listBuf: { ordered: boolean; text: string }[] = [];
  const flushList = () => {
    if (!listBuf.length) return;
    let i = 0;
    while (i < listBuf.length) {
      const ordered = listBuf[i].ordered;
      const items: { blocks: Block[] }[] = [];
      while (i < listBuf.length && listBuf[i].ordered === ordered) {
        items.push({ blocks: [{ type: 'paragraph', inlines: [{ type: 'text', text: listBuf[i].text }] }] });
        i++;
      }
      out.push({ type: 'list', ordered, items });
    }
    listBuf = [];
  };
  for (const block of page.blocks) {
    for (const para of splitParagraphsByHeight(block.paragraphs)) {
      const lines = para.lines.filter((l) => l.text.trim());
      if (!lines.length) continue;
      const avgH = lines.reduce((s, l) => s + (l.y1 - l.y0), 0) / lines.length;
      const text = joinLines(lines.map((l) => l.text.trim()));
      if (lines.length <= 2 && avgH >= median * 1.35 && text.length < 120) {
        flushList();
        const size = Math.round(avgH / median / 0.15) * 0.15;
        headingSizes.add(size);
        out.push({ type: 'heading', level: size, inlines: [{ type: 'text', text }] });
        continue;
      }
      // Listes : une ligne commençant par une puce ouvre un item ; les lignes suivantes sans puce le continuent.
      const segments: { item: { ordered: boolean; text: string } | null; lines: string[] }[] = [];
      for (const l of lines) {
        const t = l.text.trim();
        const b = BULLET_RE.exec(t);
        const o = b ? null : ORDERED_RE.exec(t);
        if (b || o) segments.push({ item: { ordered: !!o, text: (b ?? o)![2] }, lines: [] });
        else if (segments.length && segments[segments.length - 1].item) segments[segments.length - 1].lines.push(t);
        else if (segments.length && !segments[segments.length - 1].item) segments[segments.length - 1].lines.push(t);
        else segments.push({ item: null, lines: [t] });
      }
      if (segments.some((s) => s.item)) {
        for (const s of segments) {
          if (s.item) listBuf.push({ ordered: s.item.ordered, text: joinLines([s.item.text, ...s.lines]) });
          else {
            flushList();
            out.push({ type: 'paragraph', inlines: [{ type: 'text', text: joinLines(s.lines) }] });
          }
        }
        continue;
      }
      flushList();
      out.push({ type: 'paragraph', inlines: [{ type: 'text', text }] });
    }
  }
  flushList();
  // Niveaux de titre : plus la ligne est haute, plus le niveau est petit.
  const sizes = [...headingSizes].sort((a, b) => b - a);
  for (const b of out) if (b.type === 'heading') b.level = Math.min(sizes.indexOf(b.level) + 1, 4);
  return out;
}

/** Tesseract regroupe parfois un titre et son paragraphe : on sépare les lignes dont la hauteur diffère nettement. */
function splitParagraphsByHeight(paragraphs: OcrParagraph[]): OcrParagraph[] {
  const out: OcrParagraph[] = [];
  for (const p of paragraphs) {
    let cur: OcrLine[] = [];
    for (const l of p.lines) {
      const h = l.y1 - l.y0;
      if (cur.length) {
        const ph = cur[cur.length - 1].y1 - cur[cur.length - 1].y0;
        if (h > 0 && ph > 0 && (h / ph > 1.3 || ph / h > 1.3)) {
          out.push({ lines: cur });
          cur = [];
        }
      }
      cur.push(l);
    }
    if (cur.length) out.push({ lines: cur });
  }
  return out;
}

/** Joint des lignes en gérant les césures. */
export function joinLines(lines: string[]): string {
  let s = '';
  for (const l of lines) {
    if (!s) { s = l; continue; }
    if (/[A-Za-zÀ-ÿ]-$/.test(s) && /^[a-zà-ÿ]/.test(l)) s = s.slice(0, -1) + l;
    else s += ' ' + l;
  }
  return s.replace(/\s+/g, ' ').trim();
}

export const textInline = (t: string): Inline => ({ type: 'text', text: t });
