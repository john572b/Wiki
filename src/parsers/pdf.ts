import * as pdfjs from 'pdfjs-dist';
import type { PDFPageProxy, TextItem } from 'pdfjs-dist/types/src/display/api';
import pdfWorkerUrl from '../pdf.worker.ts?worker&url';
import type { Block, DocumentModel, DocWarning, ImageAsset, Inline, ListBlock } from '../model/types';
import type { OcrEngine } from '../ocr/engine';
import { ocrDocumentToBlocks, joinLines, type OcrPage } from '../ocr/structure';
import { shortRunsToLists } from '../model/postprocess';
import { recognizeWithLayout } from '../ocr/layout';
import { sha256Hex } from '../util/hash';
import { canvasToPng, makeCanvas } from '../util/image';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface PdfParseOptions {
  sourceFilename: string;
  ocr: OcrEngine | null;
  langs: string[];
  maxPages: number;
  /** Conserver l'image de page entière des pages scannées comme image du document. */
  includePageScans?: boolean;
  /** Ignorer les images répétées sur plusieurs pages (logos d'en-tête). */
  dropRepeatedImages?: boolean;
  onStage?: (stage: 'extract' | 'ocr', page: number, total: number) => void;
  /** Développement : reçoit les lignes extraites (après nettoyage) pour ajuster les heuristiques. */
  onDebugLines?: (lines: { page: number; text: string; size: number; bold: boolean; mono: boolean; x0: number; x1: number; top: number; bottom: number }[]) => void;
}

interface Item {
  str: string;
  x: number;
  y: number; // baseline, repère haut-bas (0 = haut de page)
  w: number;
  size: number;
  bold: boolean;
  mono: boolean;
  href?: string;
}

interface Line {
  items: Item[];
  text: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  size: number;
  bold: boolean;
  mono: boolean;
  page: number;
  /** Titre en lettres espacées (« C O N T A C T »), déjà recompacté. */
  spacedCaps: boolean;
}

interface PageImage {
  asset: ImageAsset;
  top: number;
  bottom: number;
  left: number;
  right: number;
  area: number;
}

interface PageData {
  index: number;
  width: number;
  height: number;
  lines: Line[];
  images: PageImage[];
  scanned: boolean;
  ocrBlocks: Block[] | null;
  ocrRegions: OcrPage[] | null;
  textChars: number;
}

const BULLET_RE = /^([•·▪■●○◦‣➢➤\-–—*]|o)\s+(.+)$/;
const ORDERED_RE = /^((?:\d{1,3}[.)])|(?:[a-z][.)])|(?:[ivx]{1,5}[.)]))\s+(.+)$/i;
const PAGE_NUM_RE = /^(page\s*)?\d{1,4}(\s*(\/|sur|of|de|von|-)\s*\d{1,4})?$/i;

export async function parsePdf(buffer: ArrayBuffer, opts: PdfParseOptions): Promise<DocumentModel> {
  const warnings: DocWarning[] = [];
  let pdf: pdfjs.PDFDocumentProxy;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
  });
  try {
    pdf = await loadingTask.promise;
  } catch (e) {
    const name = (e as { name?: string })?.name ?? '';
    if (name === 'PasswordException') throw new Error('PDF_ENCRYPTED');
    throw new Error('PDF_INVALID');
  }
  try {
    if (pdf.numPages > opts.maxPages) throw new Error('TOO_MANY_PAGES');
    let title: string | null = null;
    try {
      const meta = await pdf.getMetadata();
      const t = (meta.info as { Title?: string })?.Title;
      if (t && t.trim() && !/\.(pdf|docx?|odt)$/i.test(t.trim())) title = t.trim();
    } catch { /* métadonnées absentes */ }

    const pages: PageData[] = [];
    const imageHashes = new Map<string, Set<number>>();
    for (let i = 1; i <= pdf.numPages; i++) {
      opts.onStage?.('extract', i, pdf.numPages);
      const page = await pdf.getPage(i);
      const pd = await extractPage(page, i);
      for (const im of pd.images) {
        if (!imageHashes.has(im.asset.sha256)) imageHashes.set(im.asset.sha256, new Set());
        imageHashes.get(im.asset.sha256)!.add(i);
      }
      pd.scanned = isScanned(pd);
      if (pd.scanned && opts.ocr) {
        opts.onStage?.('ocr', i, pdf.numPages);
        pd.ocrRegions = await ocrPage(page, opts.ocr);
      } else if (pd.scanned) {
        warnings.push({ code: 'OCR_DISABLED', message: `Page ${i} sans texte exploitable : OCR désactivé, texte non extrait.`, location: `page ${i}` });
      }
      pages.push(pd);
      page.cleanup();
    }

    const ocrDone = pages.filter((p) => p.ocrRegions);
    ocrDocumentToBlocks(ocrDone.map((p) => p.ocrRegions!)).forEach((blocks, k) => (ocrDone[k].ocrBlocks = blocks));

    // Images décoratives répétées (logos d'en-tête) : présentes sur ≥ 3 pages ou sur ≥ 50 % des pages (≥ 2).
    const decorative = new Set<string>();
    if (opts.dropRepeatedImages) {
      for (const [hash, set] of imageHashes) {
        if (set.size >= 3 || (pdf.numPages >= 2 && set.size >= Math.max(2, pdf.numPages / 2))) decorative.add(hash);
      }
    }
    removeHeadersFooters(pages);
    opts.onDebugLines?.(pages.flatMap((p) => p.lines.map((l) => ({ page: l.page, text: l.text, size: l.size, bold: l.bold, mono: l.mono, x0: Math.round(l.x0), x1: Math.round(l.x1), top: Math.round(l.top), bottom: Math.round(l.bottom) }))));
    const bodySize = bodyFontSize(pages);
    const headingLevels = computeHeadingLevels(pages, bodySize);

    const images: ImageAsset[] = [];
    const seenHash = new Map<string, ImageAsset>();
    let counter = 0;
    const blocks: Block[] = [];
    let ocrPages: number[] = [];
    let confSum = 0;
    for (const pd of pages) {
      const pageBlocks: Block[] = [];
      const pageImages = pd.images
        .filter((im) => !decorative.has(im.asset.sha256))
        .filter((im) => !(pd.scanned && im.area >= 0.5 * pd.width * pd.height && !opts.includePageScans))
        .sort((a, b) => a.top - b.top);
      const imageBlock = (im: PageImage): Block => {
        let asset = seenHash.get(im.asset.sha256);
        if (!asset) {
          counter++;
          asset = { ...im.asset, id: `img-${counter}` };
          seenHash.set(asset.sha256, asset);
          images.push(asset);
        }
        return { type: 'image', imageId: asset.id, alt: '' };
      };
      if (pd.scanned) {
        pageBlocks.push(...pageImages.map(imageBlock));
        if (pd.ocrBlocks) {
          pageBlocks.push(...pd.ocrBlocks);
          ocrPages.push(pd.index);
        }
      } else {
        const textBlocks = linesToBlocks(pd.lines, bodySize, headingLevels, pageImages, imageBlock);
        pageBlocks.push(...shortRunsToLists(textBlocks));
      }
      appendPageBlocks(blocks, pageBlocks);
    }
    void confSum;
    const garbage = pages.filter((p) => p.scanned && p.textChars >= 30);
    if (garbage.length) {
      warnings.push({ code: 'PDF_TEXT_UNREADABLE', message: `Couche texte illisible (polices sans table Unicode) sur ${garbage.length === pages.length ? 'toutes les pages' : 'les pages ' + garbage.map((p) => p.index).join(', ')} : texte obtenu par OCR.` });
    }
    if (pages.some((p) => p.scanned) && !pages.every((p) => p.scanned)) {
      warnings.push({ code: 'PDF_MIXED', message: `Document mixte : pages ${pages.filter((p) => p.scanned).map((p) => p.index).join(', ')} traitées par OCR.` });
    }
    return {
      schemaVersion: '1',
      metadata: {
        title,
        sourceFilename: opts.sourceFilename,
        sourceKind: 'pdf',
        pageCount: pdf.numPages,
        ocr: { used: ocrPages.length > 0, pages: ocrPages, engine: ocrPages.length ? opts.ocr?.id : undefined, langs: ocrPages.length ? opts.langs : undefined },
        language: null,
        warnings,
      },
      images,
      blocks,
    };
  } finally {
    await loadingTask.destroy();
  }
}

async function extractPage(page: PDFPageProxy, index: number): Promise<PageData> {
  const viewport = page.getViewport({ scale: 1 });
  const H = viewport.height;
  const W = viewport.width;
  // La liste d'opérateurs charge les polices (gras, chasse fixe) avant la lecture du texte ; elle sert aussi aux images.
  let opList: Awaited<ReturnType<PDFPageProxy['getOperatorList']>> | null = null;
  try {
    opList = await page.getOperatorList();
  } catch {
    opList = null;
  }
  const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
  const fontCache = new Map<string, { bold: boolean; mono: boolean }>();
  const fontInfo = (fontName: string): { bold: boolean; mono: boolean } => {
    let fi = fontCache.get(fontName);
    if (fi) return fi;
    const style = content.styles[fontName];
    let bold = false;
    let mono = style?.fontFamily === 'monospace';
    try {
      if (page.commonObjs.has(fontName)) {
        const f = page.commonObjs.get(fontName) as { name?: string; bold?: boolean; black?: boolean; isMonospace?: boolean } | null;
        const name = f?.name ?? '';
        bold = !!f?.bold || !!f?.black || /bold|black|heavy|semibold|demibold/i.test(name);
        mono = mono || !!f?.isMonospace || /courier|mono|consolas|menlo/i.test(name);
      }
    } catch { /* police non résolue : on garde les valeurs par défaut */ }
    fi = { bold, mono };
    fontCache.set(fontName, fi);
    return fi;
  };

  // Liens
  const links: { x0: number; y0: number; x1: number; y1: number; url: string }[] = [];
  try {
    const annots = (await page.getAnnotations()) as { subtype: string; url?: string; rect: number[] }[];
    for (const a of annots) {
      if (a.subtype === 'Link' && a.url && a.rect) {
        const [ax0, ay0, ax1, ay1] = a.rect;
        links.push({ x0: Math.min(ax0, ax1), x1: Math.max(ax0, ax1), y0: H - Math.max(ay0, ay1), y1: H - Math.min(ay0, ay1), url: a.url });
      }
    }
  } catch { /* pas d'annotations */ }

  // Items → lignes
  const lines: Line[] = [];
  let cur: Line | null = null;
  let prevEOL = false;
  let textChars = 0;
  for (const raw of content.items) {
    const it = raw as TextItem;
    if (!('str' in it)) continue;
    const [a, b, , , e, f] = it.transform as number[];
    const size = Math.abs(it.height) || Math.hypot(a, b) || 1;
    const x = e;
    const y = H - f; // baseline en repère haut-bas
    if (it.str === '' || it.str === ' ') {
      if (it.hasEOL) prevEOL = true;
      else if (cur && it.str === ' ') cur.text += ' ';
      continue;
    }
    const fi = fontInfo(it.fontName);
    const base: Item = { str: it.str, x, y, w: it.width, size, bold: fi.bold, mono: fi.mono };
    textChars += it.str.trim().length;
    for (const item of splitByLinks(base, links)) {
      const sameLine = cur && !prevEOL && Math.abs(item.y - cur.items[cur.items.length - 1].y) < 0.45 * Math.max(size, cur.size) && item.x >= cur.x0 - size;
      if (sameLine && cur) {
        const last = cur.items[cur.items.length - 1];
        const gap = item.x - (last.x + last.w);
        if (gap > 0.12 * size && !cur.text.endsWith(' ') && !item.str.startsWith(' ')) cur.text += ' ';
        cur.text += item.str;
        cur.items.push(item);
        cur.x1 = Math.max(cur.x1, item.x + item.w);
        cur.top = Math.min(cur.top, item.y - size * 0.85);
        cur.bottom = Math.max(cur.bottom, item.y + size * 0.25);
      } else {
        cur = { items: [item], text: item.str, x0: item.x, x1: item.x + item.w, top: item.y - size * 0.85, bottom: item.y + size * 0.25, size, bold: false, mono: false, page: index, spacedCaps: false };
        lines.push(cur);
      }
      prevEOL = false;
    }
    prevEOL = !!it.hasEOL;
  }
  for (const l of lines) {
    l.text = l.text.replace(/\s+/g, ' ').trim();
    const collapsed = collapseSpacedCaps(l.text);
    if (collapsed) {
      l.text = collapsed;
      l.spacedCaps = true;
    }
    const chars = l.items.reduce((s, i) => s + i.str.length, 0) || 1;
    const sizeWeights = new Map<number, number>();
    let boldChars = 0, monoChars = 0;
    for (const i of l.items) {
      const k = Math.round(i.size * 2) / 2;
      sizeWeights.set(k, (sizeWeights.get(k) ?? 0) + i.str.length);
      if (i.bold) boldChars += i.str.length;
      if (i.mono) monoChars += i.str.length;
    }
    l.size = [...sizeWeights.entries()].sort((p, q) => q[1] - p[1])[0][0];
    l.bold = boldChars / chars >= 0.8;
    l.mono = monoChars / chars >= 0.8;
  }

  const images = opList ? await extractImages(page, opList, H, index) : [];
  return { index, width: W, height: H, lines: lines.filter((l) => l.text), images, scanned: false, ocrBlocks: null, ocrRegions: null, textChars };
}

/**
 * Rattache les zones de lien du PDF au texte : si une zone ne couvre qu'une partie d'un fragment
 * (« Documentation : https://… »), le fragment est découpé pour que seule la partie cliquable devienne un lien.
 */
function splitByLinks(item: Item, links: { x0: number; y0: number; x1: number; y1: number; url: string }[]): Item[] {
  const cy = item.y - item.size * 0.3;
  const l = links.find((k) => cy >= k.y0 && cy <= k.y1 && k.x1 > item.x && k.x0 < item.x + item.w);
  if (!l) return [item];
  const len = item.str.length;
  let start: number, end: number;
  const exact = item.str.indexOf(l.url);
  if (exact >= 0) {
    start = exact;
    end = exact + l.url.length;
  } else {
    const perChar = item.w / Math.max(1, len);
    start = Math.max(0, Math.round((l.x0 - item.x) / perChar));
    end = Math.min(len, Math.round((l.x1 - item.x) / perChar));
    // Ajuste aux limites de mots.
    while (start > 0 && item.str[start - 1] !== ' ') start--;
    while (end < len && item.str[end] !== ' ') end++;
  }
  if (start <= 0 && end >= len) return [{ ...item, href: l.url }];
  const perChar = item.w / Math.max(1, len);
  const part = (a: number, b: number, href?: string): Item => ({ ...item, str: item.str.slice(a, b), x: item.x + a * perChar, w: (b - a) * perChar, href });
  const out: Item[] = [];
  if (start > 0) out.push(part(0, start));
  out.push(part(start, end, l.url));
  if (end < len) out.push(part(end, len));
  return out.filter((p) => p.str.length);
}

async function extractImages(page: PDFPageProxy, opList: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>, H: number, pageIndex: number): Promise<PageImage[]> {
  const out: PageImage[] = [];
  const OPS = pdfjs.OPS;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args as number[]);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
      const objId = args[0] as string;
      if (seen.has(objId)) continue;
      seen.add(objId);
      // Le carré unité est mappé par la matrice courante.
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const left = Math.min(...xs), right = Math.max(...xs);
      const top = H - Math.max(...ys), bottom = H - Math.min(...ys);
      const area = (right - left) * (bottom - top);
      if (right - left < 20 || bottom - top < 20) continue;
      const asset = await imageObjectToAsset(page, objId, pageIndex, out.length + 1);
      if (!asset) continue;
      if (asset.width < 24 || asset.height < 24) continue;
      out.push({ asset, top, bottom, left, right, area });
    }
  }
  return out;
}

function mul(m: number[], n: number[]): number[] {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

interface PdfImageObj { width: number; height: number; kind?: number; data?: Uint8ClampedArray | Uint8Array; bitmap?: ImageBitmap | HTMLImageElement }

async function imageObjectToAsset(page: PDFPageProxy, objId: string, pageIndex: number, idx: number): Promise<ImageAsset | null> {
  const obj = await new Promise<PdfImageObj | null>((resolve) => {
    try {
      if (page.objs.has(objId)) resolve(page.objs.get(objId) as PdfImageObj);
      else {
        const timer = setTimeout(() => resolve(null), 2500);
        page.objs.get(objId, (data: unknown) => { clearTimeout(timer); resolve(data as PdfImageObj); });
      }
    } catch {
      resolve(null);
    }
  });
  if (!obj || !obj.width || !obj.height) return null;
  if (obj.width * obj.height > 50_000_000) return null;
  try {
    const canvas = makeCanvas(obj.width, obj.height);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    if (obj.bitmap) {
      ctx.drawImage(obj.bitmap as CanvasImageSource, 0, 0);
    } else if (obj.data) {
      const img = ctx.createImageData(obj.width, obj.height);
      const src = obj.data;
      const dst = img.data;
      const n = obj.width * obj.height;
      if (obj.kind === pdfjs.ImageKind.RGBA_32BPP) dst.set(src.subarray(0, n * 4));
      else if (obj.kind === pdfjs.ImageKind.RGB_24BPP) {
        for (let p = 0, s = 0; p < n * 4; p += 4, s += 3) { dst[p] = src[s]; dst[p + 1] = src[s + 1]; dst[p + 2] = src[s + 2]; dst[p + 3] = 255; }
      } else if (obj.kind === pdfjs.ImageKind.GRAYSCALE_1BPP) {
        const rowBytes = Math.ceil(obj.width / 8);
        for (let yy = 0; yy < obj.height; yy++) for (let xx = 0; xx < obj.width; xx++) {
          const bit = (src[yy * rowBytes + (xx >> 3)] >> (7 - (xx & 7))) & 1;
          const p = (yy * obj.width + xx) * 4;
          const v = bit ? 255 : 0;
          dst[p] = dst[p + 1] = dst[p + 2] = v; dst[p + 3] = 255;
        }
      } else return null;
      ctx.putImageData(img, 0, 0);
    } else return null;
    const png = await canvasToPng(canvas);
    return { id: `p${pageIndex}-${idx}`, filename: '', mime: 'image/png', width: obj.width, height: obj.height, sha256: await sha256Hex(png), data: png, origin: { page: pageIndex, index: idx } };
  } catch {
    return null;
  }
}

/** « C O N T A C T » → « CONTACT » : au moins 3 jetons, majoritairement d'une lettre, tout en majuscules. */
export function collapseSpacedCaps(text: string): string | null {
  const tokens = text.split(' ').filter(Boolean);
  if (tokens.length < 3) return null;
  const singles = tokens.filter((t) => t.length === 1).length;
  if (singles / tokens.length < 0.6) return null;
  const joined = tokens.join('');
  if (!/^[A-ZÀ-Ý0-9&'’\-]+$/.test(joined) || !/[A-ZÀ-Ý]{3}/.test(joined)) return null;
  return joined;
}

function isAllCaps(text: string): boolean {
  return text.length >= 3 && text.length <= 40 && /^[A-ZÀ-Ý0-9&'’\-\s.]+$/.test(text) && /[A-ZÀ-Ý]{3}/.test(text) && !/[.:;,]$/.test(text);
}

function isScanned(pd: PageData): boolean {
  const pageArea = pd.width * pd.height;
  const bigImage = pd.images.some((im) => im.area >= 0.45 * pageArea);
  if (pd.textChars < 30 && bigImage) return true;
  if (pd.textChars === 0 && pd.images.length === 0) return false;
  return hasGarbageText(pd);
}

/**
 * Texte corrompu (polices embarquées sans table Unicode) : la couche texte contient des codes de glyphes,
 * caractères de contrôle ou de remplacement, et très peu de lettres. On traite alors la page par OCR,
 * car pdf.js sait quand même la dessiner avec les polices embarquées.
 */
export function hasGarbageText(pd: { lines: { text: string }[] }): boolean {
  const all = pd.lines.map((l) => l.text).join('').replace(/\s+/g, '');
  if (all.length < 40) return false;
  const bad = (all.match(/[�-\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g) ?? []).length;
  const letters = (all.match(/\p{L}/gu) ?? []).length;
  return bad / all.length > 0.08 || letters / all.length < 0.4;
}

async function ocrPage(page: PDFPageProxy, ocr: OcrEngine): Promise<OcrPage[]> {
  const base = page.getViewport({ scale: 1 });
  // Largeur de rendu visée ~2200 px quel que soit le format de page (bornes pour les pages géantes ou minuscules).
  const scale = Math.min(4, Math.max(0.3, 2200 / base.width));
  const viewport = page.getViewport({ scale });
  const canvas = makeCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas: canvas as HTMLCanvasElement, viewport }).promise;
  return recognizeWithLayout(ocr, canvas);
}

function removeHeadersFooters(pages: PageData[]): void {
  const textPages = pages.filter((p) => !p.scanned && p.lines.length);
  if (textPages.length < 2) {
    for (const p of textPages) p.lines = p.lines.filter((l) => !isPageNumber(l, p));
    return;
  }
  const counts = new Map<string, Set<number>>();
  const key = (l: Line) => l.text.replace(/\d+/g, '#').toLowerCase().trim();
  for (const p of textPages) {
    for (const l of p.lines) {
      if (inMargin(l, p)) {
        const k = key(l);
        if (!counts.has(k)) counts.set(k, new Set());
        counts.get(k)!.add(p.index);
      }
    }
  }
  const threshold = Math.max(2, Math.ceil(textPages.length * 0.5));
  for (const p of textPages) {
    p.lines = p.lines.filter((l) => {
      if (!inMargin(l, p)) return true;
      if (isPageNumber(l, p)) return false;
      return (counts.get(key(l))?.size ?? 0) < threshold;
    });
  }
}

function inMargin(l: Line, p: PageData): boolean {
  return l.top < p.height * 0.08 || l.bottom > p.height * 0.92;
}

function isPageNumber(l: Line, p: PageData): boolean {
  return inMargin(l, p) && PAGE_NUM_RE.test(l.text.trim());
}

function bodyFontSize(pages: PageData[]): number {
  const weights = new Map<number, number>();
  for (const p of pages) for (const l of p.lines) weights.set(l.size, (weights.get(l.size) ?? 0) + l.text.length);
  const sorted = [...weights.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? 11;
}

interface HeadingLevels { bySize: Map<number, number>; capsLevel: number; boldLevel: number }

function isSizeHeading(l: Line, body: number): boolean {
  return l.size >= body * 1.15 && l.text.length <= 120 && !l.mono;
}

function isBoldHeading(l: Line, body: number, prev: Line | undefined, next: Line | undefined): boolean {
  if (!l.bold || l.mono || l.text.length > 90 || l.size < body * 0.95) return false;
  if (/[.;,]$/.test(l.text) && !/^\d+(\.\d+)*\.?\s/.test(l.text)) return false;
  const gapBefore = prev && prev.page === l.page ? l.top - prev.bottom : Infinity;
  const gapAfter = next && next.page === l.page ? next.top - l.bottom : Infinity;
  const nextNotBold = !next || !next.bold || next.page !== l.page;
  return nextNotBold && (gapBefore > l.size * 0.4 || gapAfter > l.size * 0.3 || /^\d+(\.\d+)*\.?\s/.test(l.text));
}

function computeHeadingLevels(pages: PageData[], body: number): HeadingLevels {
  const sizes = new Set<number>();
  for (const p of pages) for (const l of p.lines) if (isSizeHeading(l, body)) sizes.add(l.size);
  const sorted = [...sizes].sort((a, b) => b - a).slice(0, 4);
  const bySize = new Map<number, number>();
  sorted.forEach((s, i) => bySize.set(s, i + 1));
  // Les tailles au-delà des 4 premières sont rattachées au dernier niveau.
  for (const s of sizes) if (!bySize.has(s)) bySize.set(s, sorted.length);
  const hasCaps = pages.some((p) => p.lines.some((l) => l.spacedCaps));
  const capsLevel = Math.min(sorted.length + 1, 5);
  return { bySize, capsLevel, boldLevel: Math.min(capsLevel + (hasCaps ? 1 : 0), 6) };
}

/** Titre de section en majuscules : isolé par un espace au-dessus et suivi de près par du contenu. */
function isCapsHeading(l: Line, body: number, prev: Line | undefined, next: Line | undefined): boolean {
  if (l.spacedCaps) return true;
  if (!isAllCaps(l.text) || l.mono || l.size < body * 0.85) return false;
  const gapBefore = prev && prev.page === l.page ? l.top - prev.bottom : Infinity;
  const gapAfter = next && next.page === l.page ? next.top - l.bottom : Infinity;
  return gapBefore >= l.size * 1.2 && (gapAfter < l.size * 1.5 || gapAfter === Infinity);
}

/** Sous-titre à peine plus grand que le corps (titre de poste, de certification…) introduisant un bloc serré. */
function isSubHeading(l: Line, body: number, prev: Line | undefined, next: Line | undefined, following: Line[]): boolean {
  if (l.mono || l.size < body * 1.04 || l.size >= body * 1.15 || l.text.length > 70 || /[.:;,]$/.test(l.text)) return false;
  const gapBefore = prev && prev.page === l.page ? l.top - prev.bottom : Infinity;
  const gapAfter = next && next.page === l.page ? next.top - l.bottom : Infinity;
  if (!(gapBefore >= l.size * 1.2 && gapAfter < l.size * 0.6)) return false;
  // Le bloc introduit doit contenir, dans les 3 lignes qui suivent, du texte plus petit (sinon c'est une phrase sur deux lignes).
  for (let k = 0; k < 3; k++) {
    const n = following[k];
    if (!n || n.page !== l.page || n.top < l.top) break;
    if (n.size < l.size - 0.3) return true;
  }
  return false;
}

function linesToBlocks(lines: Line[], body: number, hl: HeadingLevels, images: PageImage[], imageBlock: (im: PageImage) => Block): Block[] {
  const out: Block[] = [];
  // Interligne dominant de la page (écart médian entre lignes consécutives de même taille) :
  // un saut de paragraphe doit être nettement plus grand que lui.
  const gaps: number[] = [];
  for (let k = 1; k < lines.length; k++) {
    const a = lines[k - 1], b = lines[k];
    const g = b.top - a.bottom;
    if (a.page === b.page && Math.abs(a.size - b.size) < 0.3 && g > 0 && g < b.size * 2) gaps.push(g);
  }
  gaps.sort((p, q) => p - q);
  const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const paraGap = (size: number) => Math.max(size * 0.55, Math.min(size * 1.2, medianGap * 1.25 + 0.5));
  const colRightCache = new Map<Line, number>();
  /** Bord droit de la colonne d'une ligne : x1 maximal des lignes partageant son x0 (± 2 × taille). */
  const colRight = (l: Line): number => {
    let v = colRightCache.get(l);
    if (v === undefined) {
      v = l.x1;
      for (const o of lines) if (o.page === l.page && Math.abs(o.x0 - l.x0) <= l.size && o.x1 > v) v = o.x1;
      colRightCache.set(l, v);
    }
    return v;
  };
  let imgIdx = 0;
  let para: Line[] = [];
  let code: Line[] = [];
  let list: { level: number; ordered: boolean; lines: string[]; x0: number }[] = [];
  const bulletXs: number[] = [];

  const flushPara = () => {
    if (para.length) out.push({ type: 'paragraph', inlines: linesToInlines(para) });
    para = [];
  };
  const flushCode = () => {
    if (code.length) out.push({ type: 'code', text: code.map((l) => l.text).join('\n') });
    code = [];
  };
  const flushList = () => {
    if (list.length) out.push(...buildNestedList(list));
    list = [];
    bulletXs.length = 0;
  };
  const flushAll = () => { flushPara(); flushCode(); flushList(); };
  const flushImagesBefore = (top: number) => {
    while (imgIdx < images.length && images[imgIdx].top + (images[imgIdx].bottom - images[imgIdx].top) / 2 <= top) {
      flushAll();
      out.push(imageBlock(images[imgIdx++]));
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const prev = lines[i - 1];
    const next = lines[i + 1];
    flushImagesBefore(l.top);
    const gap = prev ? l.top - prev.bottom : Infinity;
    // Remontée verticale = changement de colonne : on ne fusionne jamais au travers.
    if (prev && gap < -2 * l.size) flushAll();

    // Tableau : lignes consécutives dont les fragments s'alignent sur les mêmes colonnes.
    const run = tableRunAt(lines, i);
    if (run) {
      flushAll();
      out.push(run.block);
      i += run.length - 1;
      continue;
    }

    if (isSizeHeading(l, body) || isCapsHeading(l, body, prev, next) || isBoldHeading(l, body, prev, next) || isSubHeading(l, body, prev, next, lines.slice(i + 1, i + 4))) {
      flushAll();
      const level = isSizeHeading(l, body) ? (hl.bySize.get(l.size) ?? 1) : isCapsHeading(l, body, prev, next) ? hl.capsLevel : hl.boldLevel;
      // Les titres sur deux lignes consécutives de même taille sont fusionnés.
      let text = l.text;
      while (i + 1 < lines.length && isSizeHeading(lines[i + 1], body) && lines[i + 1].size === l.size && lines[i + 1].top - lines[i].bottom < l.size * 0.6) {
        i++;
        text += ' ' + lines[i].text;
      }
      out.push({ type: 'heading', level, inlines: [{ type: 'text', text }] });
      continue;
    }
    if (l.mono) {
      flushPara();
      flushList();
      code.push(l);
      continue;
    }
    flushCode();

    const bullet = BULLET_RE.exec(l.text);
    const ordered = !bullet ? ORDERED_RE.exec(l.text) : null;
    if (bullet || ordered) {
      flushPara();
      const x0 = l.x0;
      let level = bulletXs.findIndex((x) => Math.abs(x - x0) < l.size * 0.6);
      if (level < 0) {
        bulletXs.push(x0);
        bulletXs.sort((a, b) => a - b);
        level = bulletXs.indexOf(x0);
        // Réindexer les niveaux existants
        for (const it of list) it.level = bulletXs.findIndex((x) => Math.abs(x - it.x0) < l.size * 0.6);
      }
      list.push({ level, ordered: !!ordered, lines: [(bullet ?? ordered)![2]], x0 });
      continue;
    }
    if (list.length && gap < l.size * 0.9 && l.x0 > list[list.length - 1].x0 + l.size * 0.5) {
      list[list.length - 1].lines.push(l.text);
      continue;
    }
    flushList();

    const prevLine = para[para.length - 1];
    const prevShort = !!prevLine && prevLine.x1 < colRight(prevLine) - l.size * 4;
    const newPara =
      !para.length ||
      gap > paraGap(l.size) ||
      Math.abs(l.size - prevLine.size) >= 0.4 ||
      (prevShort && Math.abs(l.x0 - prevLine.x0) < l.size * 0.5 && !/[,;]$/.test(prevLine.text)) ||
      (/[.!?:]$/.test(para[para.length - 1].text) && l.x0 > para[para.length - 1].x0 + l.size * 0.9) ||
      (para[para.length - 1].x1 < para[0].x1 - l.size * 6 && /[.!?]$/.test(para[para.length - 1].text));
    if (newPara) flushPara();
    para.push(l);
  }
  flushAll();
  while (imgIdx < images.length) out.push(imageBlock(images[imgIdx++]));
  return out;
}

function buildNestedList(items: { level: number; ordered: boolean; lines: string[] }[]): Block[] {
  const root: ListBlock[] = [];
  const stack: { level: number; list: ListBlock }[] = [];
  for (const it of items) {
    while (stack.length && stack[stack.length - 1].level > it.level) stack.pop();
    let cur = stack[stack.length - 1];
    if (!cur || cur.level < it.level) {
      const list: ListBlock = { type: 'list', ordered: it.ordered, items: [] };
      if (cur) {
        if (!cur.list.items.length) cur.list.items.push({ blocks: [] });
        cur.list.items[cur.list.items.length - 1].blocks.push(list);
      } else root.push(list);
      stack.push({ level: it.level, list });
      cur = stack[stack.length - 1];
    } else if (cur.list.ordered !== it.ordered && stack.length === 1) {
      const list: ListBlock = { type: 'list', ordered: it.ordered, items: [] };
      root.push(list);
      stack.length = 0;
      stack.push({ level: it.level, list });
      cur = stack[0];
    }
    cur.list.items.push({ blocks: [{ type: 'paragraph', inlines: [{ type: 'text', text: joinLines(it.lines) }] }] });
  }
  return root;
}

/** Fusionne les lignes d'un paragraphe en inlines (gras/italique/liens/code par item). */
function linesToInlines(lines: Line[]): Inline[] {
  const out: Inline[] = [];
  let pending = '';
  let pendingAttrs: { bold: boolean; mono: boolean; href?: string } | null = null;
  const push = () => {
    if (!pending) return;
    const inl: Inline = { type: 'text', text: pending };
    if (pendingAttrs?.bold) inl.bold = true;
    if (pendingAttrs?.mono) inl.code = true;
    if (pendingAttrs?.href) out.push({ type: 'link', href: pendingAttrs.href, children: [inl] });
    else out.push(inl);
    pending = '';
  };
  lines.forEach((l, li) => {
    let lineText = '';
    const segs: { text: string; attrs: { bold: boolean; mono: boolean; href?: string } }[] = [];
    let last: Item | null = null;
    for (const it of l.items) {
      let t = it.str;
      if (last) {
        const gap = it.x - (last.x + last.w);
        if (gap > 0.12 * it.size && !lineText.endsWith(' ') && !t.startsWith(' ')) t = ' ' + t;
      }
      lineText += t;
      segs.push({ text: t, attrs: { bold: it.bold && !l.bold ? true : l.bold ? false : false, mono: it.mono, href: it.href } });
      last = it;
    }
    // Césure en fin de ligne
    const isLast = li === lines.length - 1;
    const nextStartsLower = !isLast && /^[a-zà-ÿ]/.test(lines[li + 1].text);
    for (let si = 0; si < segs.length; si++) {
      const s = segs[si];
      let text = s.text;
      if (si === segs.length - 1) {
        text = text.replace(/\s+$/, '');
        if (!isLast) {
          if (/[A-Za-zÀ-ÿ]-$/.test(text) && nextStartsLower) text = text.slice(0, -1);
          else text += ' ';
        }
      }
      const same = pendingAttrs && pendingAttrs.bold === s.attrs.bold && pendingAttrs.mono === s.attrs.mono && pendingAttrs.href === s.attrs.href;
      if (!same) { push(); pendingAttrs = s.attrs; }
      pending += text;
    }
  });
  push();
  // Un paragraphe entièrement en gras (ligne bold) garde le gras.
  if (lines.every((l) => l.bold)) for (const i of out) { if (i.type === 'text') i.bold = true; if (i.type === 'link') i.children?.forEach((c) => (c.bold = true)); }
  return out;
}

interface PdfCell { x0: number; x1: number; text: string; bold: boolean }
const LIST_MARK_RE = /^([•·▪■●○◦‣➢➤\-–—*o]|\d{1,3}[.)]|[a-z][.)]|[ivx]{1,5}[.)])$/i;

/** Découpe une ligne en cellules là où l'espace entre deux fragments dépasse nettement une espace normale. */
function cellsOf(l: Line): PdfCell[] {
  const cells: PdfCell[] = [];
  for (const it of l.items) {
    const last = cells[cells.length - 1];
    const gap = last ? it.x - last.x1 : Infinity;
    if (last && gap < Math.max(l.size * 1.2, 6)) {
      last.text += (gap > l.size * 0.12 && !last.text.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '') + it.str;
      last.x1 = it.x + it.w;
      last.bold = last.bold && it.bold;
    } else {
      cells.push({ x0: it.x, x1: it.x + it.w, text: it.str, bold: it.bold });
    }
  }
  return cells.map((c) => ({ ...c, text: c.text.replace(/\s+/g, ' ').trim() })).filter((c) => c.text);
}

function tableRunAt(lines: Line[], i: number): { block: Block; length: number } | null {
  const first = cellsOf(lines[i]);
  if (first.length < 2 || LIST_MARK_RE.test(first[0].text) || lines[i].mono) return null;
  const tol = lines[i].size * 1.0;
  const rows: PdfCell[][] = [first];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j], p = lines[j - 1];
    if (l.page !== p.page || l.top - p.bottom > l.size * 1.6 || l.top < p.top) break;
    const cells = cellsOf(l);
    if (cells.length !== first.length || LIST_MARK_RE.test(cells[0].text)) break;
    if (!cells.every((c, k) => Math.abs(c.x0 - first[k].x0) <= tol)) break;
    rows.push(cells);
    j++;
  }
  if (rows.length < 2) return null;
  const header = rows[0].every((c) => c.bold) && !rows.slice(1).every((r) => r.every((c) => c.bold));
  return {
    length: rows.length,
    block: {
      type: 'table',
      rows: rows.map((r, ri) => ({
        cells: r.map((c) => ({ blocks: [{ type: 'paragraph' as const, inlines: autolinkText(c.text) }], header: header && ri === 0, colspan: 1, rowspan: 1 })),
      })),
    },
  };
}

function autolinkText(text: string): Inline[] {
  return [{ type: 'text', text }];
}

/** Concatène les blocs d'une page ; fusionne un paragraphe coupé par un saut de page. */
function appendPageBlocks(acc: Block[], pageBlocks: Block[]): void {
  if (acc.length && pageBlocks.length) {
    const last = acc[acc.length - 1];
    const first = pageBlocks[0];
    if (last.type === 'paragraph' && first.type === 'paragraph') {
      const lt = last.inlines.map((i) => i.text ?? '').join('');
      const ft = first.inlines.map((i) => i.text ?? '').join('');
      if (!/[.!?:]\s*$/.test(lt) && /^[a-zà-ÿ]/.test(ft)) {
        const lastInl = last.inlines[last.inlines.length - 1];
        if (lastInl?.type === 'text' && !/\s$/.test(lastInl.text ?? '')) lastInl.text += ' ';
        last.inlines.push(...first.inlines);
        acc.push(...pageBlocks.slice(1));
        return;
      }
    }
  }
  acc.push(...pageBlocks);
}
