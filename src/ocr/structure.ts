import type { Block, Inline } from '../model/types';
import { mergeSplitHeadings, shortRunsToLists } from '../model/postprocess';

/** Structure neutre renvoyée par un moteur OCR (indépendante de Tesseract). */
export interface OcrLine { text: string; x0: number; y0: number; x1: number; y1: number; confidence: number }
export interface OcrParagraph { lines: OcrLine[] }
export interface OcrBlock { paragraphs: OcrParagraph[] }
export interface OcrPage { width: number; height: number; blocks: OcrBlock[]; meanConfidence: number }

/** Puce lue par l'OCR : vrais caractères de puce, ou glyphes que Tesseract substitue aux points (e, ¢, «, +…). */
const BULLET_RE = /^([•·▪■●○◦‣➢➤\-–—*+¢«°»]|[oe](?=\s[A-ZÀ-Ý0-9]))\s+(.+)$/;
const ORDERED_RE = /^(\d{1,3}[.)]|[a-z][.)]|[ivx]{1,5}[.)])\s+(.+)$/i;
/** Icône (téléphone, enveloppe…) lue comme un symbole isolé en début de ligne. */
const ICON_RE = /^[^\p{L}\p{N}\s("'[]{1,2}\s+(?=[\p{L}\p{N}(+])/u;
const TRAILING_SYMBOLS_RE = /(\s+[^\p{L}\p{N}\s.,;:!?)'"»%]{1,2})+$/u;
const PAGE_NUM_RE = /^(page\s*)?\d{1,4}\s*(\/|sur|of|de|von|-)\s*\d{1,4}\s*\S{0,2}$/i;

interface TLine { text: string; height: number; y0: number; y1: number; bullet: null | { ordered: boolean; text: string }; capsLike: boolean }

/** Convertit l'ensemble des régions OCR d'une page en blocs, avec une hauteur de corps commune. */
export function ocrPagesToBlocks(pages: OcrPage[]): Block[] {
  const all = pages.flatMap((p) => p.blocks.flatMap((b) => b.paragraphs.flatMap((pp) => pp.lines))).filter((l) => l.text.trim());
  const heights = all.map((l) => l.y1 - l.y0).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 1;
  const blocks = pages.flatMap((p) => regionToBlocks(p, median));
  assignHeadingLevels(blocks);
  return shortRunsToLists(mergeSplitHeadings(blocks));
}

/** Niveaux de titres cohérents sur toute la page : par taille décroissante, puis titres en majuscules. */
function assignHeadingLevels(blocks: Block[]): void {
  const sizes = [...new Set(blocks.filter((b) => b.type === 'heading' && b.level !== CAPS_KEY).map((b) => (b as { level: number }).level))].sort((a, b) => b - a);
  const capsLevel = Math.min(sizes.length + 1, 5);
  for (const b of blocks) if (b.type === 'heading') b.level = b.level === CAPS_KEY ? capsLevel : Math.min(sizes.indexOf(b.level) + 1, 4);
}

const CAPS_KEY = -1; // clé provisoire des titres en majuscules, remplacée par assignHeadingLevels

/** Page seule : équivalent de ocrPagesToBlocks([page]). */
export function ocrPageToBlocks(page: OcrPage): Block[] {
  return ocrPagesToBlocks([page]);
}

/**
 * Transforme une page (ou région) OCR en blocs par règles :
 * titres par hauteur de ligne ou majuscules, listes par puces, paragraphes par regroupement Tesseract.
 */
function regionToBlocks(page: OcrPage, bodyHeight?: number): Block[] {
  const allLines = page.blocks.flatMap((b) => b.paragraphs.flatMap((p) => p.lines)).filter((l) => l.text.trim());
  if (!allLines.length) return [];
  const heights = allLines.map((l) => l.y1 - l.y0).sort((a, b) => a - b);
  const median = bodyHeight ?? (heights[Math.floor(heights.length / 2)] || 1);
  const out: Block[] = [];
  let listBuf: { ordered: boolean; text: string }[] = [];
  const flushList = () => {
    let i = 0;
    while (i < listBuf.length) {
      const ordered = listBuf[i].ordered;
      const items: { blocks: Block[] }[] = [];
      while (i < listBuf.length && listBuf[i].ordered === ordered) items.push({ blocks: [{ type: 'paragraph', inlines: [textInline(listBuf[i++].text)] }] });
      out.push({ type: 'list', ordered, items });
    }
    listBuf = [];
  };
  const pushHeading = (text: string, sizeKey: number) => {
    flushList();
    out.push({ type: 'heading', level: sizeKey, inlines: [textInline(text)] });
  };
  let lastLine: TLine | undefined;

  for (const block of page.blocks) {
    for (const para of splitParagraphsByHeight(block.paragraphs)) {
      const lines: TLine[] = [];
      for (const raw of para.lines) {
        let t = raw.text.trim();
        if (!t || PAGE_NUM_RE.test(t)) continue;
        t = t.replace(TRAILING_SYMBOLS_RE, '');
        let bullet: TLine['bullet'] = null;
        // Puce ou icône en tête de ligne (parfois les deux : « + —Texte »).
        for (let pass = 0; pass < 2; pass++) {
          const b = BULLET_RE.exec(t);
          const o = b ? null : ORDERED_RE.exec(t);
          if (b) { bullet = bullet ?? { ordered: false, text: b[2] }; t = b[2]; }
          else if (o) { bullet = bullet ?? { ordered: true, text: o[2] }; t = o[2]; }
          else { const stripped = t.replace(ICON_RE, ''); if (stripped === t) break; t = stripped; }
        }
        if (bullet) bullet.text = t;
        if (!t) continue;
        lines.push({ text: t, height: raw.y1 - raw.y0, y0: raw.y0, y1: raw.y1, bullet, capsLike: mostlyUpper(t) });
      }
      if (!lines.length) continue;
      // Titres détectés ligne par ligne : hauteur nettement supérieure au corps, ou majuscules courtes.
      let seg: TLine[] = [];
      const flushSeg = () => {
        if (!seg.length) return;
        if (seg.some((l) => l.bullet)) {
          seg.forEach((l, si) => {
            const gap = si > 0 ? l.y0 - seg[si - 1].y1 : Infinity;
            if (l.bullet) listBuf.push({ ordered: l.bullet.ordered, text: l.bullet.text });
            else if (listBuf.length && gap <= median * 0.9) listBuf[listBuf.length - 1].text = joinLines([listBuf[listBuf.length - 1].text, l.text]);
            else { flushList(); out.push({ type: 'paragraph', inlines: [textInline(l.text)] }); }
          });
        } else {
          flushList();
          // Un grand espace vertical ou un passage majuscules → minuscules sépare deux paragraphes.
          let cur: TLine[] = [];
          for (const l of seg) {
            const p = cur[cur.length - 1];
            if (p && (l.y0 - p.y1 > median * 1.3 || (p.capsLike && !l.capsLike && p.text.length > 12))) {
              out.push({ type: 'paragraph', inlines: [textInline(joinLines(cur.map((x) => x.text)))] });
              cur = [];
            }
            cur.push(l);
          }
          if (cur.length) out.push({ type: 'paragraph', inlines: [textInline(joinLines(cur.map((x) => x.text)))] });
        }
        seg = [];
      };
      for (let li = 0; li < lines.length; li++) {
        const l = lines[li];
        const prev = lines[li - 1] ?? lastLine;
        const next = lines[li + 1];
        const gapBefore = prev ? l.y0 - prev.y1 : Infinity;
        const gapAfter = next ? next.y0 - l.y1 : Infinity;
        const isSize = l.height >= median * 1.35 && l.text.length < 120 && !l.bullet;
        // Titre en majuscules : isolé au-dessus, suivi de près par du contenu, et pas la suite d'une ligne en majuscules.
        const isCaps = isAllCaps(l.text) && gapBefore >= median * 0.8 && (gapAfter <= median * 3.5 || gapBefore === Infinity) && !(prev && prev.capsLike && gapBefore < median * 0.8);
        if (isSize) { flushSeg(); pushHeading(l.text, Math.round(l.height / median / 0.15) * 0.15); }
        else if (isCaps) { flushSeg(); pushHeading(l.text, CAPS_KEY); }
        else seg.push(l);
      }
      flushSeg();
      lastLine = lines[lines.length - 1];
    }
  }
  flushList();
  return out; // les niveaux (clés de taille ou CAPS_KEY) sont attribués par assignHeadingLevels
}

function mostlyUpper(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, '');
  return letters.length >= 3 && (letters.replace(/[^\p{Lu}]/gu, '').length / letters.length) >= 0.8;
}

function isAllCaps(text: string): boolean {
  return text.length >= 3 && text.length <= 40 && /^[A-ZÀ-Ý0-9&'’\-\s.]+$/.test(text) && /[A-ZÀ-Ý]{3}/.test(text) && !/[.:;,]$/.test(text);
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
